const Ajv = require('ajv');

const {
  CATEGORY_KEYS,
  CLASSIFICATION_SOURCE,
  DISTRIBUTION_TARGETS,
  IMPORTANCE,
  SOURCES,
  TASK_LIMIT,
  TASK_STATUS,
  TEXT_LIMITS,
  URGENCY,
  categoryForTask,
  normalizeOptionalDue,
  normalizeOptionalOwner,
  parseEstimatedMinutes,
} = require('../contracts/time-management');

const ajv = new Ajv({ allErrors: true, strict: true });
const nullableImportance = { anyOf: [{ enum: IMPORTANCE }, { type: 'null' }] };
const nullableUrgency = { anyOf: [{ enum: URGENCY }, { type: 'null' }] };

const validateRequest = ajv.compile({
  type: 'object',
  additionalProperties: false,
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      minItems: 1,
      maxItems: TASK_LIMIT,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'source', 'due', 'est', 'importance', 'urgency', 'status', 'classificationSource'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 200 },
          name: { type: 'string', minLength: 1, maxLength: TEXT_LIMITS.taskName },
          source: { enum: SOURCES },
          due: { type: 'string', maxLength: TEXT_LIMITS.due },
          dueTime: { type: "string", maxLength: 10 },
          est: { type: 'string', maxLength: TEXT_LIMITS.est },
          owner: { type: 'string', maxLength: TEXT_LIMITS.owner },
          importance: nullableImportance,
          urgency: nullableUrgency,
          acceptanceCriteria: {
            type: 'array',
            maxItems: 5,
            items: { type: 'string', maxLength: TEXT_LIMITS.acceptanceCriteria },
          },
          nextAction: { type: 'string', maxLength: TEXT_LIMITS.nextAction },
          status: { enum: TASK_STATUS },
          classificationSource: { enum: CLASSIFICATION_SOURCE },
        },
      },
    },
  },
});

function publicError(code, message, status) {
  return Object.assign(new Error(message), { code, status, expose: true });
}

function statusFor(category, percent) {
  const target = DISTRIBUTION_TARGETS[category];
  if (percent < target.min) return 'under';
  if (percent > target.max) return 'over';
  return 'ok';
}

function allocateTenths(minutesByCategory, totalMinutes) {
  if (totalMinutes <= 0) return Object.fromEntries(CATEGORY_KEYS.map(key => [key, 0]));
  const rows = CATEGORY_KEYS.map((key, index) => {
    const raw = (minutesByCategory[key] * 1000) / totalMinutes;
    const floor = Math.floor(raw);
    return { key, index, floor, fraction: raw - floor };
  });
  let remaining = 1000 - rows.reduce((sum, row) => sum + row.floor, 0);
  rows
    .slice()
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
    .slice(0, remaining)
    .forEach(row => {
      const target = rows.find(item => item.key === row.key);
      target.floor += 1;
    });
  return Object.fromEntries(rows.map(row => [row.key, row.floor / 10]));
}

function buildDiagnosis(categories) {
  const byKey = new Map(categories.map(item => [item.key, item]));
  const diagnosis = [];
  const recommendations = [];
  const yesterday = byKey.get('昨天');
  const today = byKey.get('今天');
  const tomorrow = byKey.get('明天');
  const future = byKey.get('后天');

  diagnosis.push(yesterday.status === 'ok'
    ? '“昨天”投入已趋近 0%，遗留事项控制良好。'
    : `“昨天”占 ${yesterday.percent}%：遗留和救火正在挤占当前工作。`);
  diagnosis.push(today.status === 'ok'
    ? '“今天”投入处于 70–80% 的目标区间。'
    : `“今天”占 ${today.percent}%：${today.status === 'under' ? '核心执行投入不足' : '日常事务占比过高'}。`);
  diagnosis.push(tomorrow.status === 'ok'
    ? '“明天”投入达标，机制、流程和能力建设得到保护。'
    : `“明天”占 ${tomorrow.percent}%：${tomorrow.status === 'under' ? '机制、流程或人才能力建设投入不足' : '建设性投入偏高，需检查是否挤压当日交付'}。`);
  diagnosis.push(future.status === 'ok'
    ? '“后天”已有未来规划与提前布局投入。'
    : `“后天”占 ${future.percent}%：缺少未来规划和提前布局。`);

  if (yesterday.status !== 'ok') recommendations.push('集中清理或授权“昨天”遗留，阻止事项继续滚存。');
  if (tomorrow.status === 'under') recommendations.push('为“明天”类机制、流程和带人工作设置不可挤占时段。');
  if (future.status === 'under') recommendations.push('将“后天”目标拆成可检查的里程碑，并安排固定复盘。');
  if (today.status === 'over') recommendations.push('合并低价值日常事务，减少上下文切换和重复沟通。');
  if (recommendations.length === 0) recommendations.push('维持当前结构，并通过每日跟踪验证是否持续达标。');

  return { diagnosis, recommendations };
}

function diagnoseDistribution({ tasks, requestBody } = {}) {
  const rawInput = requestBody || { tasks };
  const input = Array.isArray(rawInput?.tasks)
    ? {
      ...rawInput,
      tasks: rawInput.tasks.map(task => (
        normalizeOptionalOwner(normalizeOptionalDue(task))
      )),
    }
    : rawInput;
  if (!validateRequest(input)) {
    throw publicError('INPUT_INVALID', '任务数据不符合时间分布诊断要求。', 400);
  }

  const ids = new Set();
  const minutesByCategory = Object.fromEntries(CATEGORY_KEYS.map(key => [key, 0]));
  const invalidTasks = [];
  for (const task of input.tasks) {
    if (ids.has(task.id)) throw publicError('INPUT_INVALID', '任务 ID 不能重复。', 400);
    ids.add(task.id);
    const minutes = parseEstimatedMinutes(task.est);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      invalidTasks.push({ taskId: task.id, name: task.name, est: task.est });
      continue;
    }
    minutesByCategory[categoryForTask(task)] += minutes;
  }

  const totalMinutes = Object.values(minutesByCategory).reduce((sum, value) => sum + value, 0);
  if (totalMinutes <= 0) {
    throw publicError('DISTRIBUTION_UNAVAILABLE', '没有可解析的预估工时，无法生成时间分布诊断。', 422);
  }
  const percentages = allocateTenths(minutesByCategory, totalMinutes);
  const categories = CATEGORY_KEYS.map(key => ({
    key,
    minutes: minutesByCategory[key],
    hours: Math.round((minutesByCategory[key] / 60) * 10) / 10,
    percent: percentages[key],
    target: { ...DISTRIBUTION_TARGETS[key] },
    status: statusFor(key, percentages[key]),
  }));
  const narrative = buildDiagnosis(categories);

  return {
    totalMinutes,
    totalHours: Math.round((totalMinutes / 60) * 10) / 10,
    validTaskCount: input.tasks.length - invalidTasks.length,
    invalidTasks,
    categories,
    percentages,
    diagnosis: narrative.diagnosis,
    recommendations: narrative.recommendations,
  };
}

module.exports = { allocateTenths, diagnoseDistribution, statusFor };
