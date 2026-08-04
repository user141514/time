const { performance } = require('node:perf_hooks');
const { loadVersionedPrompt } = require('../prompts/load-versioned-prompt');
const {
  COVERAGE_CHECK_SCHEMA,
  CRITIC_CHECKS,
  DEDUPE_CHECK_SCHEMA,
  DUE_CHECK_SCHEMA,
  OWNER_CHECK_SCHEMA,
  SOURCE_CHECK_SCHEMA,
  assertCriticFindingReferences,
  mergeCriticFindings,
  validateCoverageCheck,
  validateDedupeCheck,
  validateDueCheck,
  validateOwnerCheck,
  validateSourceCheck,
} = require('./critic-contracts');

const STAGE = 'critic';

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

const CHECKS = Object.freeze({
  owner: Object.freeze({
    promptId: 'decomposition.critic-owner',
    schema: OWNER_CHECK_SCHEMA,
    schemaName: 'time_critic_owner_v1',
    validate: validateOwnerCheck,
  }),
  due: Object.freeze({
    promptId: 'decomposition.critic-due',
    schema: DUE_CHECK_SCHEMA,
    schemaName: 'time_critic_due_v1',
    validate: validateDueCheck,
  }),
  coverage: Object.freeze({
    promptId: 'decomposition.critic-coverage',
    schema: COVERAGE_CHECK_SCHEMA,
    schemaName: 'time_critic_coverage_v1',
    validate: validateCoverageCheck,
  }),
  dedupe: Object.freeze({
    promptId: 'decomposition.critic-dedupe',
    schema: DEDUPE_CHECK_SCHEMA,
    schemaName: 'time_critic_dedupe_v1',
    validate: validateDedupeCheck,
  }),
  source: Object.freeze({
    promptId: 'decomposition.critic-source',
    schema: SOURCE_CHECK_SCHEMA,
    schemaName: 'time_critic_source_v1',
    validate: validateSourceCheck,
  }),
});

// Each check receives only the input subset it needs.
function buildCheckInput(checkName, { compiledItems, clusters, atoms }) {
  const atomMap = new Map((atoms || []).map(atom => [atom.id, atom]));
  const clusterMap = new Map((clusters || []).map(cluster => [cluster.id, cluster]));

  const evidenceOf = item => (item.atomIds || [])
    .map(id => atomMap.get(id))
    .filter(Boolean)
    .map(atom => ({ id: atom.id, dimension: atom.dimension, quote: atom.quote }));

  switch (checkName) {
    case 'owner':
      return {
        tasks: compiledItems
          .filter(item => item.task.owner && item.task.owner !== '待确认')
          .map(item => ({
            id: item.task.id,
            name: item.task.name,
            owner: item.task.owner,
            evidence: evidenceOf(item),
          })),
      };
    case 'due':
      return {
        tasks: compiledItems
          .filter(item => item.task.due && item.task.due !== '待确认')
          .map(item => {
            const cluster = clusterMap.get(item.clusterId);
            return {
              id: item.task.id,
              name: item.task.name,
              due: item.task.due,
              evidence: evidenceOf(item),
              cluster: cluster
                ? { id: cluster.id, label: cluster.label, atomIds: cluster.atomIds }
                : null,
            };
          }),
        clusters: (clusters || []).map(cluster => ({
          id: cluster.id,
          label: cluster.label,
          atomIds: cluster.atomIds,
        })),
      };
    case 'coverage':
      return {
        atoms: (atoms || []).map(atom => ({
          id: atom.id,
          dimension: atom.dimension,
          kind: atom.kind,
          quote: atom.quote,
        })),
        tasks: compiledItems.map(item => ({
          id: item.task.id,
          name: item.task.name,
          source: item.task.source,
          evidenceAtomIds: item.atomIds || [],
        })),
      };
    case 'dedupe':
      return {
        tasks: compiledItems.map(item => ({
          id: item.task.id,
          name: item.task.name,
          source: item.task.source,
          clusterId: item.clusterId,
          evidence: evidenceOf(item),
        })),
      };
    case 'source':
      return {
        tasks: compiledItems.map(item => ({
          id: item.task.id,
          name: item.task.name,
          source: item.task.source,
          atoms: (item.atomIds || [])
            .map(id => atomMap.get(id))
            .filter(Boolean)
            .map(atom => ({ id: atom.id, dimension: atom.dimension, kind: atom.kind })),
        })),
      };
    default:
      throw new Error(`unknown critic check: ${checkName}`);
  }
}

async function runCheck(checkName, definition, baseInput, {
  modelClient,
  signal,
  deadlineAt,
  responseFormatMode,
  maxTokens,
  onAttempt,
  monotonicNow,
  references,
}) {
  const prompt = loadVersionedPrompt(definition.promptId);
  const attemptEvents = [];
  let modelCalls = 0;
  const startedAt = monotonicNow();

  const recordAttempt = event => {
    attemptEvents.push(event);
    try {
      onAttempt?.({ ...event, stage: STAGE, check: checkName });
    } catch {
      // Logging must not affect generation.
    }
  };

  async function invoke(input) {
    modelCalls += 1;
    try {
      return await modelClient.completeJson({
        system: prompt.text,
        user: JSON.stringify(input),
        temperature: 0.1,
        maxAttempts: 1,
        responseSchema: definition.schema,
        responseSchemaName: definition.schemaName,
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

  function validate(response) {
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw outputError(STAGE, ['CRITIC_RESPONSE_INVALID']);
    }
    if (!definition.validate(response)) {
      throw outputError(STAGE, ['CRITIC_SCHEMA_INVALID']);
    }
    assertCriticFindingReferences(response.findings, references);
    return response;
  }

  const meta = { ok: true };
  let response;
  try {
    response = validate(await invoke(baseInput));
  } catch (error) {
    if (error.code !== 'MODEL_OUTPUT_INVALID' || !canRetry(deadlineAt, monotonicNow)) {
      throw error;
    }
    const failedRules = error.failedRules?.length
      ? error.failedRules
      : [error.diagnosticCode || 'MODEL_JSON_INVALID'];
    try {
      response = validate(await invoke({
        ...baseInput,
        retryFeedback: {
          failedRules,
          correction: '重新生成完整 findings JSON，逐条修正。',
        },
      }));
    } catch (retryError) {
      if (retryError.code !== 'MODEL_OUTPUT_INVALID') {
        throw retryError;
      }
      // Check failed after retry: empty findings, do not block other checks.
      meta.ok = false;
      meta.errorCode = retryError.code;
      response = { findings: [] };
    }
  }

  meta.findings = response.findings.length;
  meta.attempts = Math.max(modelCalls, attemptEvents.length);
  meta.durationMs = Math.max(0, Math.round(monotonicNow() - startedAt));
  return { findings: response.findings, attempts: meta.attempts, meta };
}

async function runCriticAgent({
  compiledItems = [],
  tasks = [],
  clusters = [],
  atoms = [],
  entries,      // original goal entries (unused: each check gets only its input subset)
  businessDate,
  modelClient,
  signal,
  deadlineAt,
  responseFormatMode,
  maxTokens,
  onAttempt,
  monotonicNow = () => performance.now(),
}) {
  const startedAt = monotonicNow();
  const items = compiledItems.length > 0
    ? compiledItems
    : tasks.map(task => ({
      task,
      clusterId: task.clusterId || null,
      atomIds: task.evidenceAtomIds || task.evidenceIds || [],
      reviewRequired: false,
      unresolvedFields: [],
    }));
  const references = {
    taskIds: items.map(item => item.task.id),
    atomIds: atoms.map(atom => atom.id),
  };
  const settled = await Promise.allSettled(CRITIC_CHECKS.map(checkName => (
    runCheck(
      checkName,
      CHECKS[checkName],
      buildCheckInput(checkName, { compiledItems: items, clusters, atoms }),
      {
        modelClient,
        signal,
        deadlineAt,
        responseFormatMode,
        maxTokens,
        onAttempt,
        monotonicNow,
        references,
      },
    )
  )));
  const results = settled.map(item => {
    if (item.status === 'fulfilled') return item.value;
    return {
      findings: [],
      attempts: 1,
      meta: {
        ok: false,
        errorCode: item.reason?.code || 'CRITIC_CHECK_FAILED',
        findings: 0,
        attempts: 1,
        durationMs: 0,
      },
    };
  });
  const successfulChecks = results.filter(result => result.meta.ok).length;
  const status = successfulChecks === CRITIC_CHECKS.length
    ? 'succeeded'
    : (successfulChecks > 0 ? 'partial' : 'degraded');

  return {
    status,
    findings: mergeCriticFindings(results.map(result => ({ findings: result.findings }))),
    checkResults: Object.fromEntries(CRITIC_CHECKS.map((checkName, index) => [
      checkName,
      results[index].meta,
    ])),
    attempts: results.reduce((sum, result) => sum + result.attempts, 0),
    durationMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
  };
}

module.exports = { runCriticAgent };
