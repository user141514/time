const { performance } = require('node:perf_hooks');
const { loadVersionedPrompt } = require('../prompts/load-versioned-prompt');
const {
  RECONCILIATION_RESPONSE_SCHEMA,
  assertAllAtomsClustered,
  assertClusterAtomIdsExist,
  assertClusterRelationsValid,
  assertConflictAtomIdsExist,
  assertConflictAtomsShareCluster,
  assertNoDuplicateAtomsInClusters,
  validateReconciliationResponse,
} = require('./reconciliation-contracts');

const PROMPT_ID = 'decomposition.reconciliation';
const STAGE = 'reconciliation';

function publicError(code, message, status) {
  return Object.assign(new Error(message), { code, status, expose: true });
}

function outputError(stage, failedRules = []) {
  return Object.assign(
    publicError('MODEL_OUTPUT_INVALID', 'AI 返回格式异常，请重试。', 502),
    { stage, failedRules },
  );
}

function normalizeModelError(error, stage) {
  if (error.code === 'MODEL_OUTPUT_INVALID') {
    return Object.assign(outputError(stage), { diagnosticCode: error.diagnosticCode });
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

function canRetry(deadlineAt, monotonicNow) {
  return !Number.isFinite(deadlineAt) || deadlineAt - monotonicNow() >= 2_000;
}

function validateResponse(response, atoms) {
  if (
    !response
    || typeof response !== 'object'
    || Array.isArray(response)
  ) {
    throw outputError(STAGE, ['RECONCILIATION_RESPONSE_INVALID']);
  }
  if (!validateReconciliationResponse(response)) {
    throw outputError(STAGE, ['RECONCILIATION_SCHEMA_INVALID']);
  }
  assertNoDuplicateAtomsInClusters(response);
  assertClusterAtomIdsExist(response, atoms);
  assertAllAtomsClustered(response, atoms.map(atom => atom.id));
  assertClusterRelationsValid(response, atoms);
  assertConflictAtomIdsExist(response, atoms);
  assertConflictAtomsShareCluster(response);
  return response;
}

async function runReconciliationAgent({
  atoms,           // FactAtom[] from all 4 evidence agents (merged)
  byDimension,     // { 昨天: FactAtom[], 今天: FactAtom[], 明天: FactAtom[], 后天: FactAtom[] }
  entries,         // original goal entries
  businessDate,
  modelClient,
  signal,
  deadlineAt,
  responseFormatMode,
  maxTokens,
  onAttempt,
  monotonicNow = () => performance.now(),
}) {
  const prompt = loadVersionedPrompt(PROMPT_ID);
  const attemptEvents = [];
  let modelCalls = 0;
  const startedAt = monotonicNow();

  const recordAttempt = event => {
    attemptEvents.push(event);
    try {
      onAttempt?.({ ...event, stage: STAGE });
    } catch {
      // Logging must not affect generation.
    }
  };

  async function invoke({ input, schema, schemaName }) {
    modelCalls += 1;
    try {
      return await modelClient.completeJson({
        system: prompt.text,
        user: JSON.stringify(input),
        temperature: 0.1,
        maxAttempts: 1,
        responseSchema: schema,
        responseSchemaName: schemaName,
        signal,
        deadlineAt,
        responseFormatMode,
        maxTokens,
        maxContentBytes: 64 * 1024,
        onAttempt: recordAttempt,
      });
    } catch (error) {
      throw normalizeModelError(error, STAGE);
    }
  }

  const baseInput = { atoms, byDimension, entries, businessDate };
  let response;
  try {
    response = validateResponse(
      await invoke({
        input: baseInput,
        schema: RECONCILIATION_RESPONSE_SCHEMA,
        schemaName: 'time_reconciliation_v1',
      }),
      atoms,
    );
  } catch (error) {
    if (error.code !== 'MODEL_OUTPUT_INVALID' || !canRetry(deadlineAt, monotonicNow)) {
      throw error;
    }
    const failedRules = error.failedRules?.length
      ? error.failedRules
      : [error.diagnosticCode || 'MODEL_JSON_INVALID'];
    const corrected = await invoke({
      input: {
        ...baseInput,
        retryFeedback: {
          failedRules,
          correction: '重新生成完整 clusters/conflicts JSON，逐条修正。',
        },
      },
      schema: RECONCILIATION_RESPONSE_SCHEMA,
      schemaName: 'time_reconciliation_v1',
    });
    response = validateResponse(corrected, atoms);
  }

  return {
    clusters: response.clusters,
    conflicts: response.conflicts,
    attempts: Math.max(modelCalls, attemptEvents.length),
    durationMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
  };
}

module.exports = { runReconciliationAgent };
