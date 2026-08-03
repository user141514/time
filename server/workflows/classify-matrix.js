const Ajv = require('ajv');

const {
  CLASSIFICATION_SOURCE,
  ENERGY_POLICY,
  IMPORTANCE,
  SOURCES,
  TASK_LIMIT,
  TASK_STATUS,
  TEXT_LIMITS,
  URGENCY,
  normalizeOptionalDue,
  normalizeOptionalOwner,
  quadrantFor,
} = require('../contracts/time-management');
const { loadStepPrompt } = require('../prompts/load-step-prompt');

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
      maxItems: TASK_LIMIT,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'importance', 'urgency', 'classificationSource'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 200 },
          name: { type: 'string', minLength: 1, maxLength: TEXT_LIMITS.taskName },
          importance: nullableImportance,
          urgency: nullableUrgency,
          classificationSource: { enum: CLASSIFICATION_SOURCE },
          source: { enum: SOURCES },
          due: { type: 'string', maxLength: TEXT_LIMITS.due },
          est: { type: 'string', minLength: 1, maxLength: TEXT_LIMITS.est },
          owner: { type: 'string', maxLength: TEXT_LIMITS.owner },
          acceptanceCriteria: {
            type: 'array',
            maxItems: 5,
            items: {
              type: 'string',
              minLength: 1,
              maxLength: TEXT_LIMITS.acceptanceCriteria,
            },
          },
          nextAction: { type: 'string', maxLength: TEXT_LIMITS.nextAction },
          status: { enum: TASK_STATUS },
        },
      },
    },
  },
});

const validateResponse = ajv.compile({
  type: 'object',
  additionalProperties: false,
  required: ['classifications', 'note'],
  properties: {
    classifications: {
      type: 'array',
      maxItems: TASK_LIMIT,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['taskId', 'importance', 'urgency'],
        properties: {
          taskId: { type: 'string', minLength: 1, maxLength: 200 },
          importance: { enum: IMPORTANCE },
          urgency: { enum: URGENCY },
        },
      },
    },
    note: { type: 'string', maxLength: 4000 },
  },
});

const QUADRANTS = Object.freeze([
  Object.freeze({ name: '第一象限', priority: 1, action: '立即做' }),
  Object.freeze({ name: '第二象限', priority: 2, action: '计划做' }),
  Object.freeze({ name: '第三象限', priority: 3, action: '授权做' }),
  Object.freeze({ name: '第四象限', priority: 4, action: '减少做' }),
]);

function publicError(code, message, status) {
  return Object.assign(new Error(message), { code, status, expose: true });
}

function outputError() {
  return publicError('MODEL_OUTPUT_INVALID', 'AI 返回格式异常，请重试。', 502);
}

function assertInputSemantics(tasks) {
  const ids = new Set();
  for (const task of tasks) {
    if (!task.id.trim() || !task.name.trim() || ids.has(task.id)) {
      throw publicError('INPUT_INVALID', '输入内容不符合要求。', 400);
    }
    ids.add(task.id);

    const isUnclassified = task.classificationSource === 'unclassified';
    const hasBothLabels = IMPORTANCE.includes(task.importance)
      && URGENCY.includes(task.urgency);
    if ((isUnclassified && (task.importance !== null || task.urgency !== null))
        || (!isUnclassified && !hasBothLabels)) {
      throw publicError('INPUT_INVALID', '输入内容不符合要求。', 400);
    }
  }
}

function mergeClassifications(tasks, output) {
  if (output.classifications.length !== tasks.length) throw outputError();
  const byId = new Map();
  for (const item of output.classifications) {
    if (byId.has(item.taskId)) throw outputError();
    byId.set(item.taskId, item);
  }
  if (tasks.some(task => !byId.has(task.id))) throw outputError();

  return tasks.map(task => {
    const item = byId.get(task.id);
    if (task.classificationSource !== 'unclassified'
        && (item.importance !== task.importance || item.urgency !== task.urgency)) {
      throw outputError();
    }
    return {
      taskId: task.id,
      importance: item.importance,
      urgency: item.urgency,
      classificationSource: task.classificationSource === 'unclassified'
        ? 'ai-matrix'
        : task.classificationSource,
    };
  });
}

function buildResult(classifications, modelNote) {
  const quadrants = QUADRANTS.map(item => ({
    ...item,
    energyPercent: ENERGY_POLICY[item.name],
    taskIds: [],
  }));
  const byName = new Map(quadrants.map(item => [item.name, item]));
  for (const item of classifications) {
    byName.get(quadrantFor(item)).taskIds.push(item.taskId);
  }

  const overloaded = quadrants[0].taskIds.length >= 5;
  return {
    classifications,
    quadrants,
    note: overloaded
      ? '第一象限任务过多，建议二次筛选或授权。'
      : modelNote.trim(),
  };
}

function normalizeModelError(error) {
  if (error.code === 'MODEL_OUTPUT_INVALID') return outputError();
  if (error.code === 'MODEL_TIMEOUT') {
    return publicError('MODEL_TIMEOUT', 'AI 响应超时，请重试。', 504);
  }
  if (error.code === 'MODEL_CANCELLED') {
    return publicError('REQUEST_CANCELLED', '请求已取消。', 499);
  }
  if (error.code === 'MODEL_UPSTREAM_ERROR') {
    return publicError('MODEL_UPSTREAM_ERROR', 'AI 服务暂时不可用，请稍后重试。', 502);
  }
  return error;
}

async function classifyMatrix({
  tasks,
  modelClient,
  requestBody,
  signal,
  deadlineAt,
  onAttempt,
}) {
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
    throw publicError('INPUT_INVALID', '输入内容不符合要求。', 400);
  }
  assertInputSemantics(input.tasks);

  // 全部任务已有轻重缓急时直接确定性计算四象限，不调用模型
  if (input.tasks.every(task => task.classificationSource !== 'unclassified')) {
    return buildResult(input.tasks.map(task => ({
      taskId: task.id,
      importance: task.importance,
      urgency: task.urgency,
    })), '');
  }

  const request = {
    system: loadStepPrompt('classify-matrix'),
    user: JSON.stringify({ tasks: input.tasks }),
    temperature: 0.2,
    maxAttempts: 1,
    signal,
    deadlineAt,
    onAttempt,
  };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const output = await modelClient.completeJson(request);
      if (!validateResponse(output)) throw outputError();
      return buildResult(mergeClassifications(input.tasks, output), output.note);
    } catch (error) {
      const normalized = normalizeModelError(error);
      if (normalized.code === 'MODEL_OUTPUT_INVALID' && attempt < 2) continue;
      throw normalized;
    }
  }
  throw outputError();
}

module.exports = { classifyMatrix };
