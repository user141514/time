const Ajv = require('ajv');

const {
  GOAL_KEYS,
  TEXT_LIMITS,
  TASK_LIMIT,
  IMPORTANCE,
  URGENCY,
  SOURCES,
  TASK_STATUS,
  dedupeCrossSourceTasks,
  normalizeDueForWrite,
  normalizeTask,
  parseEstimatedMinutes,
} = require('../contracts/time-management');
const { applyDeadlineUrgency } = require('../policies/deadline');
const { loadStepPrompt } = require('../prompts/load-step-prompt');

const ajv = new Ajv({ allErrors: true, strict: true });
const goalProperties = Object.fromEntries(GOAL_KEYS.map((key) => [key, {
  type: 'string',
  maxLength: TEXT_LIMITS.goal,
}]));

const validateRequest = ajv.compile({
  type: 'object',
  additionalProperties: false,
  required: ['goals'],
  properties: {
    goals: {
      type: 'object',
      additionalProperties: false,
      required: GOAL_KEYS,
      properties: goalProperties,
    },
  },
});

const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'importance', 'urgency', 'source', 'est', 'status'],
  properties: {
    name: { type: 'string', maxLength: TEXT_LIMITS.taskName },
    importance: { type: 'string', enum: IMPORTANCE },
    urgency: { type: 'string', enum: URGENCY },
    source: { type: 'string', enum: SOURCES },
    due: { type: 'string', maxLength: TEXT_LIMITS.due },
          dueTime: { type: "string", maxLength: 10 },
    est: { type: 'string', maxLength: TEXT_LIMITS.est },
    owner: { type: 'string', maxLength: TEXT_LIMITS.owner },
    acceptanceCriteria: {
      type: 'array',
      items: { type: 'string', maxLength: TEXT_LIMITS.acceptanceCriteria },
    },
    nextAction: { type: 'string', maxLength: TEXT_LIMITS.nextAction },
    status: { type: 'string', enum: TASK_STATUS },
  },
};

const validateResponse = ajv.compile({
  type: 'object',
  additionalProperties: false,
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      maxItems: TASK_LIMIT,
      items: TASK_SCHEMA,
    },
  },
});

const SOURCE_GOAL_KEY = Object.freeze({
  复盘: '昨天',
  今天: '今天',
  临时: '今天',
  短期目标: '明天',
  中长期: '后天',
});

function publicError(code, message, status) {
  return Object.assign(new Error(message), { code, status, expose: true });
}

function outputError() {
  return publicError('MODEL_OUTPUT_INVALID', 'AI 返回格式异常，请重试。', 502);
}

function assertTaskSemantics(tasks, goals) {
  for (const task of tasks) {
    if (!task.name.trim() || !task.est.trim() || (task.due != null && !task.due.trim())) {
      throw outputError();
    }
    const sourceKey = SOURCE_GOAL_KEY[task.source];
    if (sourceKey && !goals[sourceKey].trim()) throw outputError();
    const acceptanceCriteria = task.acceptanceCriteria || [];
    if (acceptanceCriteria.some((item) => !item.trim())
        || (['短期目标', '中长期'].includes(task.source)
          && acceptanceCriteria.length === 0)) {
      throw outputError();
    }
    const estimatedMinutes = parseEstimatedMinutes(task.est);
    if (estimatedMinutes !== null && estimatedMinutes > 8 * 60
        && (task.source !== '中长期' || !task.nextAction?.trim())) {
      throw outputError();
    }
  }
}

function assertOwnerInSourceText(tasks, goals) {
  for (const task of tasks) {
    const owner = (task.owner || '').trim();
    if (!owner || owner === '待确认') continue;
    const sourceKey = SOURCE_GOAL_KEY[task.source];
    if (!sourceKey) continue;
    const sourceText = goals[sourceKey] || '';
    if (!sourceText.includes(owner)) {
      throw outputError();
    }
  }
}

function assertNoCompletedFactTasks(tasks, goals) {
  const yesterdayText = goals['昨天'] || '';
  if (!yesterdayText.trim()) return;
  const completedMarkers = /已完成|已经完成|完成了|已发送|已提交/;
  if (!completedMarkers.test(yesterdayText)) return;

  // Extract text before any contrast/转折 conjunction as the "completed clause"
  const contrastRe = /[，。,、；;]|但|不过|但是|然而|可是/;
  const contrastMatch = contrastRe.exec(yesterdayText);
  const prefixText = contrastMatch
    ? yesterdayText.slice(0, contrastMatch.index)
    : yesterdayText;

  for (const task of tasks) {
    if (task.source !== '复盘') continue;
    const taskName = task.name.trim();
    // Reject if the task name appears in the completed-clause portion
    // and that portion contains a completion marker
    if (prefixText.includes(taskName) && completedMarkers.test(prefixText)) {
      throw outputError();
    }
  }
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

async function extractTasks({
  goals,
  modelClient,
  requestBody,
  now,
  signal,
  deadlineAt,
  onAttempt,
}) {
  const input = requestBody || { goals };
  if (!validateRequest(input)) {
    throw publicError('INPUT_INVALID', '输入内容不符合要求。', 400);
  }

  const validatedGoals = input.goals;
  const system = loadStepPrompt('extract-tasks');
  const deadlineContext = {
    now: now || Date.now,
    timeZone: 'Asia/Shanghai',
  };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response;
    try {
      response = await modelClient.completeJson({
        system,
        user: JSON.stringify({ goals: validatedGoals }),
        temperature: 0.2,
        maxAttempts: 1,
        signal,
        deadlineAt,
        onAttempt,
      });
    } catch (error) {
      const normalized = normalizeModelError(error);
      // Only MODEL_OUTPUT_INVALID triggers retry; timeout/upstream errors fail immediately
      if (normalized.code !== 'MODEL_OUTPUT_INVALID' || attempt === 2) {
        throw normalized;
      }
      continue;
    }

    try {
      if (!validateResponse(response)) {
        if (attempt === 2) throw outputError();
        continue;
      }
      assertTaskSemantics(response.tasks, validatedGoals);
      assertOwnerInSourceText(response.tasks, validatedGoals);
      assertNoCompletedFactTasks(response.tasks, validatedGoals);
    } catch (error) {
      if (attempt === 2 || error.code !== 'MODEL_OUTPUT_INVALID') throw error;
      continue;
    }

    const tasks = dedupeCrossSourceTasks(response.tasks.map((task) => normalizeTask({
      ...task,
      classificationSource: 'ai-extraction',
    })));
    return {
      tasks: tasks.map((task) => normalizeDueForWrite(applyDeadlineUrgency(task, {
        ...deadlineContext,
        goalText: validatedGoals[SOURCE_GOAL_KEY[task.source]] || '',
      }))),
    };
  }

  throw outputError();
}

module.exports = { extractTasks };
