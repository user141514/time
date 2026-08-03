const Ajv = require('ajv');

const {
  CLASSIFICATION_SOURCE,
  IMPORTANCE,
  SOURCES,
  TASK_LIMIT,
  TASK_STATUS,
  TEXT_LIMITS,
  URGENCY,
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
        required: ['id', 'name', 'source', 'due', 'est', 'owner', 'importance', 'urgency', 'status', 'classificationSource'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 200 },
          name: { type: 'string', maxLength: TEXT_LIMITS.taskName },
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

function issue(field, code, message) {
  return { field, code, message };
}

function issuesForTask(task) {
  const issues = [];
  if (task.name.trim().length < 5) {
    issues.push(issue('name', 'DESCRIPTION_TOO_SHORT', '任务描述至少应包含明确动作和对象。'));
  }
  const minutes = parseEstimatedMinutes(task.est);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    issues.push(issue('est', 'ESTIMATE_REQUIRED', '请填写可解析的正数工时，如 1h、1.5小时或 30分钟。'));
  }
  if (!IMPORTANCE.includes(task.importance) || !URGENCY.includes(task.urgency)) {
    issues.push(issue('priority', 'PRIORITY_REQUIRED', '请确认任务的轻重缓急。'));
  }
  return issues;
}

function checkTaskSmart({ tasks, requestBody } = {}) {
  const rawInput = requestBody || { tasks };
  const input = Array.isArray(rawInput?.tasks)
    ? { ...rawInput, tasks: rawInput.tasks.map(task => normalizeOptionalOwner(normalizeOptionalDue(task))) }
    : rawInput;
  if (!validateRequest(input)) {
    throw publicError('INPUT_INVALID', '任务数据不符合 SMART 校验要求。', 400);
  }

  const ids = new Set();
  const results = input.tasks.map(task => {
    if (ids.has(task.id)) {
      throw publicError('INPUT_INVALID', '任务 ID 不能重复。', 400);
    }
    ids.add(task.id);
    const issues = issuesForTask(task);
    return {
      taskId: task.id,
      status: issues.length ? 'need_fix' : 'pass',
      issues,
    };
  });
  const needFix = results.filter(item => item.status === 'need_fix').length;
  return {
    overall: needFix ? 'need_fix' : 'pass',
    results,
    summary: {
      total: results.length,
      pass: results.length - needFix,
      needFix,
    },
  };
}

module.exports = { checkTaskSmart, issuesForTask };
