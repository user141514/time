const { performance } = require('node:perf_hooks');
const { loadVersionedPrompt } = require('../prompts/load-versioned-prompt');
const { publicError, outputError, normalizeModelError, canRetry } = require('./agent-error-utils');
const {
  CHECK_RESPONSE_SCHEMA,
  assertCriticFindingReferences,
  mergeCriticFindings,
} = require('./critic-contracts');

const STAGE = 'critic';
const COMBINED_PROMPT_ID = 'decomposition.critic-combined';

// Build a combined input that includes all data needed for all 5 checks.
function buildCombinedCriticInput({ compiledItems, clusters, atoms }) {
  const atomMap = new Map((atoms || []).map(atom => [atom.id, atom]));

  const tasksWithEvidence = compiledItems.map(item => ({
    id: item.task.id,
    name: item.task.name,
    owner: item.task.owner,
    due: item.task.due,
    source: item.task.source,
    clusterId: item.clusterId,
    evidence: (item.atomIds || [])
      .map(id => atomMap.get(id))
      .filter(Boolean)
      .map(atom => ({ id: atom.id, dimension: atom.dimension, kind: atom.kind, quote: atom.quote })),
  }));

  return {
    tasks: tasksWithEvidence,
    atoms: (atoms || []).map(atom => ({
      id: atom.id, dimension: atom.dimension, kind: atom.kind, quote: atom.quote,
    })),
    clusters: (clusters || []).map(cluster => ({
      id: cluster.id, label: cluster.label, atomIds: cluster.atomIds,
    })),
  };
}

async function runCriticAgent({
  compiledItems = [],
  tasks = [],
  clusters = [],
  atoms = [],
  entries,      // original goal entries (unused; combined input is self-contained)
  businessDate,
  modelClient,
  signal,
  deadlineAt,
  responseFormatMode,
  maxTokens,
  onAttempt,
  monotonicNow = () => performance.now(),
}) {
  const CRITIC_CHECKS = Object.freeze(['owner', 'due', 'coverage', 'dedupe', 'source']);
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

  const prompt = loadVersionedPrompt(COMBINED_PROMPT_ID);
  const attemptEvents = [];
  let modelCalls = 0;

  const recordAttempt = event => {
    attemptEvents.push(event);
    try {
      onAttempt?.({ ...event, stage: STAGE });
    } catch {
      // Logging must not affect generation.
    }
  };

  const baseInput = buildCombinedCriticInput({ compiledItems: items, clusters, atoms });
  const references = {
    taskIds: items.map(item => item.task.id),
    atomIds: atoms.map(atom => atom.id),
  };

  async function invoke(input) {
    modelCalls += 1;
    try {
      return await modelClient.completeJson({
        system: prompt.text,
        user: JSON.stringify(input),
        temperature: 0.1,
        maxAttempts: 1,
        responseSchema: CHECK_RESPONSE_SCHEMA,
        responseSchemaName: 'time_critic_combined_v1',
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
    // CHECK_RESPONSE_SCHEMA validates the { findings } shape.
    // Use the Ajv validator from critic-contracts if available; otherwise trust the schema.
    const { validateCriticResponse } = require('./critic-contracts');
    if (!validateCriticResponse(response)) {
      throw outputError(STAGE, ['CRITIC_SCHEMA_INVALID']);
    }
    assertCriticFindingReferences(response.findings, references);
    return response;
  }

  let response;
  let meta = { ok: true };
  try {
    response = validate(await invoke(baseInput));
  } catch (error) {
    if (error.code !== 'MODEL_OUTPUT_INVALID' || !canRetry(deadlineAt, monotonicNow)) {
      // Transport error or deadline exceeded: return degraded, don't throw.
      // This lets decompose-tasks continue with one-to-one tasks.
      if (error.code !== 'MODEL_OUTPUT_INVALID') {
        return {
          status: 'degraded',
          findings: [],
          checkResults: Object.fromEntries(CRITIC_CHECKS.map(key => [key, {
            ok: false,
            errorCode: error.code || 'CRITIC_ERROR',
            findings: 0,
            attempts: 0,
            durationMs: 0,
          }])),
          attempts: 0,
          durationMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
        };
      }
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
      meta = { ok: false, errorCode: retryError.code };
      response = { findings: [] };
    }
  }

  meta.findings = response.findings.length;
  meta.attempts = Math.max(modelCalls, attemptEvents.length);
  meta.durationMs = Math.max(0, Math.round(monotonicNow() - startedAt));

  return {
    status: meta.ok ? 'succeeded' : 'degraded',
    findings: mergeCriticFindings([{ findings: response.findings }]),
    checkResults: Object.fromEntries(CRITIC_CHECKS.map(key => [key, meta])),
    attempts: meta.attempts,
    durationMs: meta.durationMs,
  };
}

module.exports = { runCriticAgent };
