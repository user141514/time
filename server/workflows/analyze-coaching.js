const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { loadVersionedPrompt } = require('../prompts/load-versioned-prompt');
const { checkIntake } = require('./check-intake');
const {
  COACHING_RESPONSE_SCHEMA,
  DECOMPOSITION_ITEM_LIMIT,
  validateCoachingResponse,
  validateEvidenceResponseV2,
  visitClaims,
} = require('./decomposition-contracts');
const { CATEGORY_KEYS } = require('../contracts/time-management');
const { splitEntries } = require('./check-intake');

function assertEvidenceTrace(response, entries) {
  const lines = Object.fromEntries(
    CATEGORY_KEYS.map(key => [key, splitEntries(entries[key])]),
  );
  const ids = new Set();
  const coveredLines = new Set();

  for (const evidence of response.evidence) {
    if (ids.has(evidence.id)) {
      throw Object.assign(
        new Error('AI 返回格式异常，请重试。'),
        { code: 'MODEL_OUTPUT_INVALID', status: 502, stage: 'evidence-task-generation', failedRules: ['EVIDENCE_ID_DUPLICATED'] },
      );
    }
    ids.add(evidence.id);
    const sourceLine = lines[evidence.dimension]?.[evidence.sourceLineIndex];
    if (!sourceLine) {
      throw Object.assign(
        new Error('AI 返回格式异常，请重试。'),
        { code: 'MODEL_OUTPUT_INVALID', status: 502, stage: 'evidence-task-generation', failedRules: ['EVIDENCE_SOURCE_LINE_NOT_FOUND'] },
      );
    }
    if (!sourceLine.includes(evidence.quote)) {
      throw Object.assign(
        new Error('AI 返回格式异常，请重试。'),
        { code: 'MODEL_OUTPUT_INVALID', status: 502, stage: 'evidence-task-generation', failedRules: ['EVIDENCE_QUOTE_NOT_IN_SOURCE_LINE'] },
      );
    }
    if (evidence.owner !== '待确认' && !sourceLine.includes(evidence.owner)) {
      throw Object.assign(
        new Error('AI 返回格式异常，请重试。'),
        { code: 'MODEL_OUTPUT_INVALID', status: 502, stage: 'evidence-task-generation', failedRules: ['EVIDENCE_OWNER_NOT_IN_SOURCE_LINE'] },
      );
    }
    if (evidence.due !== '待确认' && !sourceLine.includes(evidence.due)) {
      throw Object.assign(
        new Error('AI 返回格式异常，请重试。'),
        { code: 'MODEL_OUTPUT_INVALID', status: 502, stage: 'evidence-task-generation', failedRules: ['EVIDENCE_DUE_NOT_IN_SOURCE_LINE'] },
      );
    }
    coveredLines.add(`${evidence.dimension}:${evidence.sourceLineIndex}`);
  }

  for (const dimension of CATEGORY_KEYS) {
    const dimLines = lines[dimension];
    if (!dimLines) continue;
    for (let index = 0; index < dimLines.length; index += 1) {
      if (!coveredLines.has(`${dimension}:${index}`)) {
        throw Object.assign(
          new Error('AI 返回格式异常，请重试。'),
          { code: 'MODEL_OUTPUT_INVALID', status: 502, stage: 'evidence-task-generation', failedRules: ['INPUT_LINE_NOT_COVERED'] },
        );
      }
    }
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_COACHING_ATTEMPTS = 3;
const OPTION_KEYS = new Set([
  'decompositionId',
  'attemptId',
  'businessDate',
  'entries',
  'evidence',
  'modelClient',
  'signal',
  'deadlineAt',
  'responseFormatMode',
  'maxTokens',
  'onAttempt',
  'monotonicNow',
]);

function publicError(code, message, status) {
  return Object.assign(new Error(message), { code, status, expose: true });
}

function outputError(failedRules = []) {
  return Object.assign(
    publicError('MODEL_OUTPUT_INVALID', 'AI 返回格式异常，请重试。', 502),
    { stage: 'coaching-analysis', failedRules },
  );
}

function normalizeModelError(error) {
  if (error.code === 'MODEL_OUTPUT_INVALID') {
    return Object.assign(outputError(), { diagnosticCode: error.diagnosticCode });
  }
  if (error.code === 'MODEL_TIMEOUT') {
    return publicError('MODEL_TIMEOUT', 'AI 响应超时，请重试。', 504);
  }
  if (error.code === 'MODEL_CANCELLED') {
    return publicError('REQUEST_CANCELLED', '请求已取消。', 499);
  }
  if ([
    'MODEL_UPSTREAM_ERROR',
    'MODEL_RESPONSE_ENVELOPE_TOO_LARGE',
    'MODEL_ERROR_BODY_TOO_LARGE',
  ].includes(error.code)) {
    return publicError('MODEL_UPSTREAM_ERROR', 'AI 服务暂时不可用，请稍后重试。', 502);
  }
  return error;
}

function validateInput(options) {
  if (Object.keys(options).some(key => !OPTION_KEYS.has(key))) {
    throw publicError('INPUT_INVALID', '教练诊断请求不符合要求。', 400);
  }
  const {
    decompositionId,
    attemptId,
    businessDate,
    entries,
    evidence,
  } = options;
  if (
    !UUID_PATTERN.test(decompositionId || '')
    || !UUID_PATTERN.test(attemptId || '')
    || !BUSINESS_DATE_PATTERN.test(businessDate || '')
  ) {
    throw publicError('INPUT_INVALID', '教练诊断请求不符合要求。', 400);
  }
  const intake = checkIntake({ requestBody: { entries } });
  if (intake.totalLines > DECOMPOSITION_ITEM_LIMIT) {
    throw publicError(
      'DECOMPOSITION_ITEM_LIMIT_EXCEEDED',
      `快速拆解单次最多处理 ${DECOMPOSITION_ITEM_LIMIT} 项事务。`,
      422,
    );
  }
  if (!validateEvidenceResponseV2({ evidence })) {
    throw publicError('INPUT_INVALID', '教练诊断证据不符合要求。', 400);
  }
  assertEvidenceTrace({ evidence }, intake.entries);
  return { entries: intake.entries, evidence };
}

function assertCoachingSemantics(response, evidence) {
  const evidenceIds = new Set(evidence.map(item => item.id));
  visitClaims(response.coachingAnalysis, claim => {
    if (new Set(claim.evidenceIds).size !== claim.evidenceIds.length) {
      throw outputError(['CLAIM_EVIDENCE_DUPLICATED']);
    }
    if (claim.evidenceIds.some(id => !evidenceIds.has(id))) {
      throw outputError(['CLAIM_EVIDENCE_NOT_FOUND']);
    }
    if (claim.evidenceIds.length === 0 && !claim.text.startsWith('证据不足')) {
      throw outputError(['UNSUPPORTED_CLAIM_NOT_MARKED']);
    }
  });
}

function coachingCorrection(failedRules = []) {
  if (failedRules.includes('UNSUPPORTED_CLAIM_NOT_MARKED')) {
    return [
      '逐个检查 coachingAnalysis 中的每个 claim。',
      '只要 evidenceIds 为空，text 必须严格以“证据不足”四个字开头，例如“证据不足：当前输入未提供该维度信息。”',
      '禁止使用“信息不足”“暂无证据”“无法判断”等替代表述。',
      '有输入 evidence 直接支持的 claim 才能填写对应 evidenceIds。',
      '返回完整 coachingAnalysis JSON。',
    ].join('');
  }
  if (failedRules.includes('CLAIM_EVIDENCE_NOT_FOUND')) {
    return '逐个检查所有 claim，仅保留输入 evidence 中真实存在的 evidenceIds；无法直接支持时清空 evidenceIds，并让 text 严格以“证据不足”开头。返回完整 coachingAnalysis JSON。';
  }
  if (failedRules.includes('CLAIM_EVIDENCE_DUPLICATED')) {
    return '删除每个 claim.evidenceIds 内的重复 ID；其他字段保持符合证据约束。返回完整 coachingAnalysis JSON。';
  }
  return '只修正失败的证据引用；任何 evidenceIds 为空的 claim，其 text 必须严格以“证据不足”开头。返回完整 coachingAnalysis JSON。';
}

async function analyzeCoaching(options = {}) {
  const {
    decompositionId,
    attemptId,
    businessDate,
    modelClient,
    signal,
    deadlineAt,
    responseFormatMode,
    maxTokens,
    onAttempt,
    monotonicNow = () => performance.now(),
  } = options;
  const input = validateInput(options);
  const prompt = loadVersionedPrompt('decomposition.coaching-analysis');
  const attemptEvents = [];
  const startedAt = monotonicNow();
  let modelCalls = 0;
  let retryFeedback;
  let response;

  for (let round = 1; round <= MAX_COACHING_ATTEMPTS; round += 1) {
    modelCalls += 1;
    try {
      response = await modelClient.completeJson({
        system: prompt.text,
        user: JSON.stringify({
          goals: input.entries,
          businessDate,
          evidence: input.evidence,
          ...(retryFeedback ? { retryFeedback } : {}),
        }),
        temperature: 0.1,
        maxAttempts: 1,
        responseSchema: COACHING_RESPONSE_SCHEMA,
        responseSchemaName: 'time_coaching_analysis_v2',
        signal,
        deadlineAt,
        responseFormatMode,
        maxTokens,
        maxContentBytes: 32 * 1024,
        onAttempt: event => {
          attemptEvents.push(event);
          try {
            onAttempt?.({ ...event, stage: 'coaching-analysis' });
          } catch {
            // Logging must not affect generation.
          }
        },
      });
    } catch (error) {
      const normalized = normalizeModelError(error);
      if (
        normalized.code !== 'MODEL_OUTPUT_INVALID'
        || round === MAX_COACHING_ATTEMPTS
      ) throw normalized;
      retryFeedback = {
        failedRules: [normalized.diagnosticCode || 'MODEL_JSON_INVALID'],
        correction: '重新生成完整 coachingAnalysis JSON。',
      };
      continue;
    }

    try {
      if (!validateCoachingResponse(response)) {
        throw outputError(['JSON_SCHEMA_INVALID']);
      }
      assertCoachingSemantics(response, input.evidence);
      break;
    } catch (error) {
      if (
        error.code !== 'MODEL_OUTPUT_INVALID'
        || round === MAX_COACHING_ATTEMPTS
      ) throw error;
      retryFeedback = {
        failedRules: error.failedRules,
        correction: coachingCorrection(error.failedRules),
      };
    }
  }

  const successfulAttempt = [...attemptEvents]
    .reverse()
    .find(event => !event.errorCode);
  const analysisId = randomUUID();
  return {
    decompositionId,
    attemptId,
    analysisId,
    stage: {
      name: 'coaching-analysis',
      analysisId,
      status: 'succeeded',
      prompt: {
        id: prompt.id,
        version: prompt.version,
        sha256: prompt.sha256,
      },
      attempts: Math.max(modelCalls, attemptEvents.length),
      durationMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
      responseFormat: successfulAttempt?.responseFormat
        || (responseFormatMode === 'json_object' ? 'json_object' : 'json_schema'),
      fallbackUsed: attemptEvents.some(event => event.fallbackUsed),
      output: response,
    },
  };
}

module.exports = { analyzeCoaching };
