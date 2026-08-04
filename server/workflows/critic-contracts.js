const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true, strict: true });

const CRITIC_FINDING_LIMIT = 50;
const CRITIC_CHECKS = Object.freeze(['owner', 'due', 'coverage', 'dedupe', 'source']);

const FINDING_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['severity', 'category', 'description', 'atomIds', 'taskIds'],
  properties: {
    severity: { enum: ['blocker', 'warning', 'info'] },
    category: { enum: [
      'owner_hallucination',
      'due_contamination',
      'missing_evidence',
      'duplicate_task',
      'orphan_evidence',
      'wrong_source',
      'semantic_role_error',
    ] },
    description: { type: 'string', minLength: 1, maxLength: 2000 },
    atomIds: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 200 } },
    taskIds: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 200 } },
  },
});

// Each focused check returns the same shape as the full response, a subset of its findings
const CHECK_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: { type: 'array', maxItems: CRITIC_FINDING_LIMIT, items: FINDING_SCHEMA },
  },
});

const OWNER_CHECK_SCHEMA = CHECK_RESPONSE_SCHEMA;
const DUE_CHECK_SCHEMA = CHECK_RESPONSE_SCHEMA;
const COVERAGE_CHECK_SCHEMA = CHECK_RESPONSE_SCHEMA;
const DEDUPE_CHECK_SCHEMA = CHECK_RESPONSE_SCHEMA;
const SOURCE_CHECK_SCHEMA = CHECK_RESPONSE_SCHEMA;

const CRITIC_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: { type: 'array', maxItems: CRITIC_FINDING_LIMIT, items: FINDING_SCHEMA },
  },
});

const validateCriticResponse = ajv.compile(CRITIC_RESPONSE_SCHEMA);
const validateOwnerCheck = ajv.compile(OWNER_CHECK_SCHEMA);
const validateDueCheck = ajv.compile(DUE_CHECK_SCHEMA);
const validateCoverageCheck = ajv.compile(COVERAGE_CHECK_SCHEMA);
const validateDedupeCheck = ajv.compile(DEDUPE_CHECK_SCHEMA);
const validateSourceCheck = ajv.compile(SOURCE_CHECK_SCHEMA);

function contractError(failedRules) {
  return Object.assign(
    new Error('AI 返回格式异常，请重试。'),
    { code: 'MODEL_OUTPUT_INVALID', status: 502, expose: true, stage: 'critic-agent', failedRules },
  );
}

// checkResults: array of { findings } from the 5 parallel checks
function assertCriticFindingReferences(findings, { taskIds, atomIds }) {
  const validTasks = new Set(taskIds);
  const validAtoms = new Set(atomIds);
  for (const finding of findings) {
    if (finding.taskIds.some(taskId => !validTasks.has(taskId))) {
      throw contractError(['CRITIC_TASK_NOT_FOUND']);
    }
    if (finding.atomIds.some(atomId => !validAtoms.has(atomId))) {
      throw contractError(['CRITIC_ATOM_NOT_FOUND']);
    }
  }
}

function mergeCriticFindings(checkResults) {
  const seen = new Set();
  const merged = [];
  for (const result of checkResults) {
    for (const finding of result.findings) {
      const key = [
        finding.category,
        [...finding.taskIds].sort().join(','),
        [...finding.atomIds].sort().join(','),
        finding.description,
      ].join('|');
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(finding);
    }
  }
  return merged;
}

module.exports = {
  COVERAGE_CHECK_SCHEMA,
  CRITIC_CHECKS,
  CRITIC_FINDING_LIMIT,
  CRITIC_RESPONSE_SCHEMA,
  DEDUPE_CHECK_SCHEMA,
  DUE_CHECK_SCHEMA,
  FINDING_SCHEMA,
  OWNER_CHECK_SCHEMA,
  SOURCE_CHECK_SCHEMA,
  assertCriticFindingReferences,
  mergeCriticFindings,
  validateCoverageCheck,
  validateCriticResponse,
  validateDedupeCheck,
  validateDueCheck,
  validateOwnerCheck,
  validateSourceCheck,
};
