const Ajv = require('ajv');

const {
  GOAL_KEYS,
  IMPORTANCE,
  SOURCES,
  TASK_LIMIT,
  TASK_STATUS,
  TEXT_LIMITS,
  URGENCY,
} = require('../contracts/time-management');

const ajv = new Ajv({ allErrors: true, strict: true });
const EVIDENCE_ID_PATTERN = '^E[1-9][0-9]{0,2}$';
const CLAIM_PATHS = Object.freeze([
  'yesterday_analysis.key_problem',
  'yesterday_analysis.gap',
  'yesterday_analysis.root_cause',
  'yesterday_analysis.management_insight',
  'today_focus.key_work',
  'today_focus.priority_reason',
  'today_focus.manager_action',
  'today_focus.possible_delegation',
  'tomorrow_optimization.management_improvement',
  'tomorrow_optimization.system_building',
  'tomorrow_optimization.capability_upgrade',
  'future_direction.long_term_goal',
  'future_direction.organization_capability',
  'future_direction.future_focus',
  'connection_analysis.problem_to_action',
  'connection_analysis.action_to_optimization',
  'connection_analysis.optimization_to_future',
  'overall_insight',
]);

const evidenceIdsSchema = {
  type: 'array',
  maxItems: 20,
  items: { type: 'string', pattern: EVIDENCE_ID_PATTERN },
};

const claimSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'evidenceIds'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 4000 },
    evidenceIds: evidenceIdsSchema,
  },
};

function claimObject(keys) {
  return {
    type: 'object',
    additionalProperties: false,
    required: keys,
    properties: Object.fromEntries(keys.map(key => [key, claimSchema])),
  };
}

const coachingAnalysisSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'yesterday_analysis',
    'today_focus',
    'tomorrow_optimization',
    'future_direction',
    'connection_analysis',
    'coaching_suggestions',
    'overall_insight',
  ],
  properties: {
    yesterday_analysis: claimObject([
      'key_problem', 'gap', 'root_cause', 'management_insight',
    ]),
    today_focus: claimObject([
      'key_work', 'priority_reason', 'manager_action', 'possible_delegation',
    ]),
    tomorrow_optimization: claimObject([
      'management_improvement', 'system_building', 'capability_upgrade',
    ]),
    future_direction: claimObject([
      'long_term_goal', 'organization_capability', 'future_focus',
    ]),
    connection_analysis: claimObject([
      'problem_to_action', 'action_to_optimization', 'optimization_to_future',
    ]),
    coaching_suggestions: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['issue', 'suggestion', 'coaching_question'],
        properties: {
          issue: claimSchema,
          suggestion: claimSchema,
          coaching_question: { type: 'string', minLength: 1, maxLength: 1000 },
        },
      },
    },
    overall_insight: claimSchema,
  },
};

// V1 coach-analysis schema — used by pipeline version "coach-decompose-v1".
// Claim text maxLength is 4000. Distinct from V2 COACHING_RESPONSE_SCHEMA below.
const COACH_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['evidence', 'coachingAnalysis'],
  properties: {
    evidence: {
      type: 'array',
      maxItems: TASK_LIMIT,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id', 'dimension', 'quote', 'observation', 'kind', 'status', 'owner', 'due',
        ],
        properties: {
          id: { type: 'string', pattern: EVIDENCE_ID_PATTERN },
          dimension: { type: 'string', enum: GOAL_KEYS },
          quote: { type: 'string', minLength: 1, maxLength: TEXT_LIMITS.goal },
          observation: { type: 'string', minLength: 1, maxLength: 1000 },
          kind: {
            type: 'string',
            enum: ['problem', 'cause', 'result', 'work', 'goal', 'constraint', 'context'],
          },
          status: {
            type: 'string',
            enum: ['completed', 'unfinished', 'planned', 'not_actionable'],
          },
          owner: { type: 'string', minLength: 1, maxLength: TEXT_LIMITS.owner },
          due: { type: 'string', minLength: 1, maxLength: TEXT_LIMITS.due },
          dueTime: { type: "string", maxLength: 10 },
        },
      },
    },
    coachingAnalysis: coachingAnalysisSchema,
  },
});

const TASK_CANDIDATE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'name',
    'importance',
    'urgency',
    'source',
    'due',
    'est',
    'owner',
    'acceptanceCriteria',
    'nextAction',
    'status',
    'evidenceIds',
  ],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: TEXT_LIMITS.taskName },
    importance: { type: 'string', enum: IMPORTANCE },
    urgency: { type: 'string', enum: URGENCY },
    source: { type: 'string', enum: SOURCES },
    due: { type: 'string', minLength: 1, maxLength: TEXT_LIMITS.due },
          dueTime: { type: "string", maxLength: 10 },
    est: { type: 'string', minLength: 1, maxLength: TEXT_LIMITS.est },
    owner: { type: 'string', minLength: 1, maxLength: TEXT_LIMITS.owner },
    acceptanceCriteria: {
      type: 'array',
      maxItems: 5,
      items: { type: 'string', minLength: 1, maxLength: TEXT_LIMITS.acceptanceCriteria },
    },
    nextAction: { type: 'string', maxLength: TEXT_LIMITS.nextAction },
    status: { type: 'string', enum: TASK_STATUS },
    evidenceIds: evidenceIdsSchema,
  },
});

const TASK_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      maxItems: TASK_LIMIT,
      items: TASK_CANDIDATE_SCHEMA,
    },
  },
});

const DECOMPOSITION_ITEM_LIMIT = 12;
const v2EvidenceIdsSchema = {
  type: 'array',
  maxItems: DECOMPOSITION_ITEM_LIMIT,
  items: { type: 'string', pattern: EVIDENCE_ID_PATTERN },
};
// ponytail: maxLength reduced from 4000 (V1) to 240 (V2) — claims should be
// one-sentence evidence pointers, not paragraph-length model output.
const v2ClaimSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'evidenceIds'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 240 },
    evidenceIds: v2EvidenceIdsSchema,
  },
};

function v2ClaimObject(keys) {
  return {
    type: 'object',
    additionalProperties: false,
    required: keys,
    properties: Object.fromEntries(keys.map(key => [key, v2ClaimSchema])),
  };
}

const coachingAnalysisV2Schema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'yesterday_analysis',
    'today_focus',
    'tomorrow_optimization',
    'future_direction',
    'connection_analysis',
    'coaching_suggestions',
    'overall_insight',
  ],
  properties: {
    yesterday_analysis: v2ClaimObject([
      'key_problem', 'gap', 'root_cause', 'management_insight',
    ]),
    today_focus: v2ClaimObject([
      'key_work', 'priority_reason', 'manager_action', 'possible_delegation',
    ]),
    tomorrow_optimization: v2ClaimObject([
      'management_improvement', 'system_building', 'capability_upgrade',
    ]),
    future_direction: v2ClaimObject([
      'long_term_goal', 'organization_capability', 'future_focus',
    ]),
    connection_analysis: v2ClaimObject([
      'problem_to_action', 'action_to_optimization', 'optimization_to_future',
    ]),
    coaching_suggestions: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['issue', 'suggestion', 'coaching_question'],
        properties: {
          issue: v2ClaimSchema,
          suggestion: v2ClaimSchema,
          coaching_question: { type: 'string', minLength: 1, maxLength: 240 },
        },
      },
    },
    overall_insight: v2ClaimSchema,
  },
};

const EVIDENCE_ITEM_V2_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'dimension',
    'sourceLineIndex',
    'quote',
    'observation',
    'kind',
    'status',
    'owner',
    'due',
  ],
  properties: {
    id: { type: 'string', pattern: EVIDENCE_ID_PATTERN },
    dimension: { type: 'string', enum: GOAL_KEYS },
    sourceLineIndex: { type: 'integer', minimum: 0, maximum: DECOMPOSITION_ITEM_LIMIT - 1 },
    quote: { type: 'string', minLength: 1, maxLength: 120 },
    observation: { type: 'string', minLength: 1, maxLength: 120 },
    kind: {
      type: 'string',
      enum: ['problem', 'cause', 'result', 'work', 'goal', 'constraint', 'context'],
    },
    status: {
      type: 'string',
      enum: ['completed', 'unfinished', 'planned', 'not_actionable'],
    },
    owner: { type: 'string', minLength: 0, maxLength: 60 },
    due: { type: 'string', minLength: 0, maxLength: 40 },
  },
});

const EVIDENCE_RESPONSE_V2_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['evidence'],
  properties: {
    evidence: {
      type: 'array',
      maxItems: DECOMPOSITION_ITEM_LIMIT,
      items: EVIDENCE_ITEM_V2_SCHEMA,
    },
  },
});

const TASK_MODEL_PROPERTIES_V2 = Object.freeze({
  name: { type: 'string', minLength: 1, maxLength: 120 },
  importance: { type: 'string', enum: IMPORTANCE },
  urgency: { type: 'string', enum: URGENCY },
  source: { type: 'string', enum: SOURCES },
  est: { type: 'string', minLength: 1, maxLength: 20 },
  acceptanceCriteria: {
    type: 'array',
    maxItems: 3,
    items: { type: 'string', minLength: 1, maxLength: 120 },
  },
  nextAction: { type: 'string', maxLength: 120 },
  status: { type: 'string', enum: TASK_STATUS },
  evidenceIds: v2EvidenceIdsSchema,
});
const TASK_MODEL_REQUIRED_FIELDS_V2 = Object.freeze([
  'name',
  'importance',
  'urgency',
  'source',
  'est',
  'acceptanceCriteria',
  'nextAction',
  'status',
  'evidenceIds',
]);
const TASK_MODEL_CANDIDATE_V2_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: TASK_MODEL_REQUIRED_FIELDS_V2,
  properties: TASK_MODEL_PROPERTIES_V2,
});
const TASK_CANDIDATE_V2_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [...TASK_MODEL_REQUIRED_FIELDS_V2, 'due', 'owner'],
  properties: {
    ...TASK_MODEL_PROPERTIES_V2,
    due: { type: 'string', minLength: 1, maxLength: 40 },
    owner: { type: 'string', minLength: 1, maxLength: 60 },
  },
});

const TASK_MODEL_RESPONSE_V2_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      maxItems: DECOMPOSITION_ITEM_LIMIT,
      items: TASK_MODEL_CANDIDATE_V2_SCHEMA,
    },
  },
});
const TASK_RESPONSE_V2_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      maxItems: DECOMPOSITION_ITEM_LIMIT,
      items: TASK_CANDIDATE_V2_SCHEMA,
    },
  },
});

const EVIDENCE_TASK_MODEL_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['evidence', 'tasks'],
  properties: {
    evidence: EVIDENCE_RESPONSE_V2_SCHEMA.properties.evidence,
    tasks: TASK_MODEL_RESPONSE_V2_SCHEMA.properties.tasks,
  },
});
const EVIDENCE_TASK_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['evidence', 'tasks'],
  properties: {
    evidence: EVIDENCE_RESPONSE_V2_SCHEMA.properties.evidence,
    tasks: TASK_RESPONSE_V2_SCHEMA.properties.tasks,
  },
});

// V2 coaching-analysis schema — used by pipeline versions "task-first-v2" and later.
// Claim text maxLength reduced to 240. Distinct from V1 COACH_RESPONSE_SCHEMA above.
const COACHING_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['coachingAnalysis'],
  properties: { coachingAnalysis: coachingAnalysisV2Schema },
});

const validateCoachResponse = ajv.compile(COACH_RESPONSE_SCHEMA);
const validateTaskResponse = ajv.compile(TASK_RESPONSE_SCHEMA);
const validateEvidenceResponseV2 = ajv.compile(EVIDENCE_RESPONSE_V2_SCHEMA);
const validateTaskModelResponseV2 = ajv.compile(TASK_MODEL_RESPONSE_V2_SCHEMA);
const validateTaskResponseV2 = ajv.compile(TASK_RESPONSE_V2_SCHEMA);
const validateEvidenceTaskResponse = ajv.compile(EVIDENCE_TASK_RESPONSE_SCHEMA);
const validateCoachingResponse = ajv.compile(COACHING_RESPONSE_SCHEMA);

function visitClaims(analysis, visitor) {
  for (const path of CLAIM_PATHS) {
    const parts = path.split('.');
    const claim = parts.reduce((value, key) => value?.[key], analysis);
    visitor(claim, path);
  }
  for (const [index, item] of (analysis.coaching_suggestions || []).entries()) {
    visitor(item.issue, `coaching_suggestions.${index}.issue`);
    visitor(item.suggestion, `coaching_suggestions.${index}.suggestion`);
  }
}

module.exports = {
  COACH_RESPONSE_SCHEMA,
  COACHING_RESPONSE_SCHEMA,
  DECOMPOSITION_ITEM_LIMIT,
  EVIDENCE_ID_PATTERN,
  EVIDENCE_TASK_MODEL_RESPONSE_SCHEMA,
  EVIDENCE_TASK_RESPONSE_SCHEMA,
  TASK_MODEL_RESPONSE_V2_SCHEMA,
  TASK_RESPONSE_SCHEMA,
  TASK_RESPONSE_V2_SCHEMA,
  validateCoachResponse,
  validateCoachingResponse,
  validateEvidenceResponseV2,
  validateEvidenceTaskResponse,
  validateTaskModelResponseV2,
  validateTaskResponse,
  validateTaskResponseV2,
  visitClaims,
};
