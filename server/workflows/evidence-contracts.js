const Ajv = require('ajv');

const { GOAL_KEYS } = require('../contracts/time-management');

const ajv = new Ajv({ allErrors: true, strict: true });

const FACT_ATOM_ITEM_LIMIT = 50;

// Each FactAtom is a faithful extraction of one actionable item from one goal column
const FACT_ATOM_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['id', 'dimension', 'sourceLineIndex', 'quote', 'kind', 'action', 'actor', 'dueRef', 'status', 'confidence'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 200 },
    dimension: { type: 'string', enum: GOAL_KEYS },
    sourceLineIndex: { type: 'integer', minimum: 0 },
    quote: { type: 'string', minLength: 1, maxLength: 4000 },
    kind: { type: 'string', enum: ['work', 'goal', 'note', 'ambiguous'] },
    action: { type: 'string', maxLength: 2000 }, // verb phrase, null → ""
    actor: {
      type: 'object',
      additionalProperties: false,
      required: ['role', 'name'],
      properties: {
        role: { type: 'string', enum: ['explicit', 'implied', 'unknown'] },
        name: { type: 'string', maxLength: 100 }, // null → ""
      },
    },
    dueRef: { type: 'string', maxLength: 200 }, // raw time expression, null → ""
    estimateRef: { type: 'string', maxLength: 200 }, // raw explicit duration expression, null → ""
    acceptanceCriteria: {
      type: 'array',
      maxItems: 5,
      items: { type: 'string', minLength: 1, maxLength: 500 },
    },
    nextActionRef: { type: 'string', maxLength: 500 },
    status: { type: 'string', enum: ['planned', 'in_progress', 'unfinished', 'unknown'] },
    relatedTo: { type: 'string', maxLength: 2000 }, // free-text work object reference
    confidence: {
      type: 'object',
      additionalProperties: false,
      required: ['actor', 'due', 'status'],
      properties: {
        actor: { enum: [0, 1] },
        due: { enum: [0, 1] },
        estimate: { enum: [0, 1] },
        status: { enum: [0, 1] },
      },
    },
  },
});

const EVIDENCE_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['dimension', 'atoms'],
  properties: {
    dimension: { type: 'string', enum: GOAL_KEYS },
    atoms: {
      type: 'array',
      maxItems: FACT_ATOM_ITEM_LIMIT,
      items: FACT_ATOM_SCHEMA,
    },
  },
});

const MERGED_EVIDENCE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['atoms', 'byDimension'],
  properties: {
    atoms: {
      type: 'array',
      maxItems: FACT_ATOM_ITEM_LIMIT * 4,
      items: FACT_ATOM_SCHEMA,
    },
    byDimension: {
      type: 'object',
      additionalProperties: false,
      required: GOAL_KEYS,
      properties: Object.fromEntries(GOAL_KEYS.map(key => [
        key,
        { type: 'array', maxItems: FACT_ATOM_ITEM_LIMIT, items: FACT_ATOM_SCHEMA },
      ])),
    },
  },
});

const validateEvidenceResponse = ajv.compile(EVIDENCE_RESPONSE_SCHEMA);
const validateMergedEvidence = ajv.compile(MERGED_EVIDENCE_SCHEMA);

function contractError(failedRules) {
  return Object.assign(
    new Error('AI 返回格式异常，请重试。'),
    { code: 'MODEL_OUTPUT_INVALID', status: 502, expose: true, stage: 'evidence-agent', failedRules },
  );
}

function assertNoAtomIdDuplicates(atoms) {
  const seen = new Set();
  for (const atom of atoms) {
    if (seen.has(atom.id)) {
      throw contractError(['EVIDENCE_ID_DUPLICATED']);
    }
    seen.add(atom.id);
  }
}

function assertFactAtomTrace(atoms, entries) {
  const coveredLines = new Set();
  for (const atom of atoms) {
    const sourceLine = entries[atom.sourceLineIndex];
    if (!sourceLine) {
      throw contractError(['EVIDENCE_SOURCE_LINE_NOT_FOUND']);
    }
    if (!sourceLine.includes(atom.quote)) {
      throw contractError(['EVIDENCE_QUOTE_NOT_IN_SOURCE_LINE']);
    }
    if (atom.actor?.role === 'explicit' && atom.actor.name && !sourceLine.includes(atom.actor.name)) {
      throw contractError(['EVIDENCE_ACTOR_NOT_IN_SOURCE_LINE']);
    }
    if (atom.dueRef && !sourceLine.includes(atom.dueRef)) {
      throw contractError(['EVIDENCE_DUE_NOT_IN_SOURCE_LINE']);
    }
    if (atom.estimateRef && !sourceLine.includes(atom.estimateRef)) {
      throw contractError(['EVIDENCE_ESTIMATE_NOT_IN_SOURCE_LINE']);
    }
    if ((atom.acceptanceCriteria || []).some(item => !sourceLine.includes(item))) {
      throw contractError(['EVIDENCE_ACCEPTANCE_NOT_IN_SOURCE_LINE']);
    }
    if (atom.nextActionRef && !sourceLine.includes(atom.nextActionRef)) {
      throw contractError(['EVIDENCE_NEXT_ACTION_NOT_IN_SOURCE_LINE']);
    }
    coveredLines.add(atom.sourceLineIndex);
  }
  for (const [index] of entries.entries()) {
    if (!coveredLines.has(index)) {
      throw contractError(['INPUT_LINE_NOT_COVERED']);
    }
  }
}

module.exports = {
  EVIDENCE_RESPONSE_SCHEMA,
  FACT_ATOM_ITEM_LIMIT,
  FACT_ATOM_SCHEMA,
  MERGED_EVIDENCE_SCHEMA,
  assertFactAtomTrace,
  assertNoAtomIdDuplicates,
  validateEvidenceResponse,
  validateMergedEvidence,
};
