const Ajv = require('ajv');

const { GOAL_KEYS, TEXT_LIMITS } = require('../contracts/time-management');
const { loadStepPrompt } = require('../prompts/load-step-prompt');

const ajv = new Ajv({ allErrors: true, strict: true });
const goalProperties = Object.fromEntries(GOAL_KEYS.map(key => [key, {
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

const validateResponse = ajv.compile({
  type: 'object',
  additionalProperties: false,
  required: ['fields', 'overall'],
  properties: {
    fields: {
      type: 'array',
      minItems: GOAL_KEYS.length,
      maxItems: GOAL_KEYS.length,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'status', 'issue', 'suggestion'],
        properties: {
          key: { enum: GOAL_KEYS },
          status: { enum: ['ok', 'warn'] },
          issue: { type: 'string', maxLength: 2000 },
          suggestion: { type: 'string', maxLength: 4000 },
        },
      },
    },
    overall: { enum: ['pass', 'need_fix'] },
  },
});

function publicError(code, message, status) {
  return Object.assign(new Error(message), { code, status, expose: true });
}

function outputError() {
  return publicError('MODEL_OUTPUT_INVALID', 'AI 返回格式异常，请重试。', 502);
}

function assertReviewSemantics(review, goals) {
  const byKey = new Map(review.fields.map(item => [item.key, item]));
  if (byKey.size !== GOAL_KEYS.length || GOAL_KEYS.some(key => !byKey.has(key))) {
    throw outputError();
  }

  const hasWarning = review.fields.some(item => item.status === 'warn');
  if ((hasWarning && review.overall !== 'need_fix')
      || (!hasWarning && review.overall !== 'pass')) {
    throw outputError();
  }

  for (const key of GOAL_KEYS) {
    if (goals[key].trim()) continue;
    const feedback = byKey.get(key);
    if (feedback.status !== 'warn'
        || !/示范[，,]请按实际修改/.test(feedback.issue)
        || !feedback.suggestion.trim()) {
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

async function checkGoals({
  goals,
  modelClient,
  requestBody,
  signal,
  deadlineAt,
  onAttempt,
}) {
  const input = requestBody || { goals };
  if (!validateRequest(input)) {
    throw publicError('INPUT_INVALID', '输入内容不符合要求。', 400);
  }

  const validatedGoals = input.goals;
  const request = {
    system: await loadStepPrompt('check-goals'),
    user: JSON.stringify({ goals: validatedGoals }),
    temperature: 0.2,
    maxAttempts: 1,
    signal,
    deadlineAt,
    onAttempt,
  };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const review = await modelClient.completeJson(request);
      if (!validateResponse(review)) throw outputError();
      assertReviewSemantics(review, validatedGoals);
      return review;
    } catch (error) {
      const normalized = normalizeModelError(error);
      if (normalized.code === 'MODEL_OUTPUT_INVALID' && attempt < 2) continue;
      throw normalized;
    }
  }
  throw outputError();
}

module.exports = { checkGoals };
