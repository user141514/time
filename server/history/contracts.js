const Ajv = require('ajv');

const {
  COACH_RESPONSE_SCHEMA,
  COACHING_RESPONSE_SCHEMA,
  EVIDENCE_TASK_RESPONSE_SCHEMA,
  TASK_RESPONSE_SCHEMA,
  validateCoachResponse,
  validateCoachingResponse,
  validateEvidenceTaskResponse,
  validateTaskResponse,
  visitClaims,
} = require('../workflows/decomposition-contracts');
const {
  CATEGORY_KEYS,
  CLASSIFICATION_SOURCE,
  DISTRIBUTION_TARGETS,
  ENERGY_POLICY,
  GOAL_KEYS,
  IMPORTANCE,
  SOURCES,
  TASK_LIMIT,
  TASK_STATUS,
  TEXT_LIMITS,
  URGENCY,
  normalizeDueForWrite,
  normalizeOptionalDue,
  normalizeOptionalOwner,
  quadrantFor,
} = require('../contracts/time-management');
const { splitEntries } = require('../workflows/check-intake');
const { FACT_ATOM_SCHEMA } = require('../workflows/evidence-contracts');
const { RECONCILIATION_RESPONSE_SCHEMA } = require('../workflows/reconciliation-contracts');
const {
  CRITIC_CHECKS,
  CRITIC_RESPONSE_SCHEMA,
} = require('../workflows/critic-contracts');
const {
  ACTIONABLE_EVIDENCE_STATUSES,
  NON_ACTIONABLE_EVIDENCE_STATUSES,
  isDirectlyRelatedAuxiliary,
  taskSourceMatchesPrimary,
} = require('../workflows/task-evidence-policy');

const HISTORY_SCHEMA_VERSION = 3;
const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
const ajv = new Ajv({ allErrors: true, strict: true });

const distributionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['totalMinutes', 'totalHours', 'validTaskCount', 'invalidTasks', 'categories', 'percentages', 'diagnosis', 'recommendations'],
  properties: {
    totalMinutes: { type: 'number', minimum: 1 },
    totalHours: { type: 'number', minimum: 0 },
    validTaskCount: { type: 'integer', minimum: 0 },
    invalidTasks: {
      type: 'array',
      maxItems: TASK_LIMIT,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['taskId', 'name', 'est'],
        properties: {
          taskId: { type: 'string', pattern: UUID_PATTERN },
          name: { type: 'string', minLength: 1, maxLength: TEXT_LIMITS.taskName },
          est: { type: 'string', maxLength: TEXT_LIMITS.est },
        },
      },
    },
    categories: {
      type: 'array',
      minItems: 4,
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'minutes', 'hours', 'percent', 'target', 'status'],
        properties: {
          key: { enum: CATEGORY_KEYS },
          minutes: { type: 'number', minimum: 0 },
          hours: { type: 'number', minimum: 0 },
          percent: { type: 'number', minimum: 0, maximum: 100 },
          target: {
            type: 'object',
            additionalProperties: false,
            required: ['min', 'max', 'label'],
            properties: {
              min: { type: 'number', minimum: 0, maximum: 100 },
              max: { type: 'number', minimum: 0, maximum: 100 },
              label: { type: 'string', minLength: 1, maxLength: 20 },
            },
          },
          status: { enum: ['ok', 'under', 'over'] },
        },
      },
    },
    percentages: {
      type: 'object',
      additionalProperties: false,
      required: CATEGORY_KEYS,
      properties: Object.fromEntries(CATEGORY_KEYS.map((key) => [key, { type: 'number', minimum: 0, maximum: 100 }])),
    },
    diagnosis: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: { type: 'string', minLength: 1, maxLength: 4000 },
    },
    recommendations: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: { type: 'string', minLength: 1, maxLength: 4000 },
    },
  },
};

const validateDistribution = ajv.compile(distributionSchema);

const decompositionSchemaV2 = {
  type: 'object',
  additionalProperties: false,
  required: ['pipelineVersion', 'businessDate', 'stages', 'taskEvidence'],
  properties: {
    pipelineVersion: { const: 'coach-decompose-v1' },
    businessDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    stages: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'prompt', 'output'],
        properties: {
          name: { enum: ['coach-analysis', 'task-generation'] },
          prompt: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'version', 'sha256'],
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 100 },
              version: { type: 'string', minLength: 1, maxLength: 40 },
              sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            },
          },
          output: { anyOf: [COACH_RESPONSE_SCHEMA, TASK_RESPONSE_SCHEMA] },
        },
      },
    },
    taskEvidence: {
      type: 'array',
      maxItems: TASK_LIMIT,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['taskId', 'evidenceIds'],
        properties: {
          taskId: { type: 'string', pattern: UUID_PATTERN },
          evidenceIds: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            uniqueItems: true,
            items: { type: 'string', pattern: '^E[1-9][0-9]{0,2}$' },
          },
        },
      },
    },
  },
};

const stagePromptSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version', 'sha256'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 100 },
    version: { type: 'string', minLength: 1, maxLength: 40 },
    sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  },
};
const stageMetricsProperties = {
  status: { const: 'succeeded' },
  prompt: stagePromptSchema,
  attempts: { type: 'integer', minimum: 1, maximum: 3 },
  durationMs: { type: 'integer', minimum: 0 },
  responseFormat: { enum: ['json_schema', 'json_object'] },
  fallbackUsed: { type: 'boolean' },
};
const evidenceTaskStageSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'name', 'status', 'prompt', 'attempts', 'durationMs',
    'responseFormat', 'fallbackUsed', 'output',
  ],
  properties: {
    name: { const: 'evidence-task-generation' },
    ...stageMetricsProperties,
    correctionPrompt: stagePromptSchema,
    output: EVIDENCE_TASK_RESPONSE_SCHEMA,
  },
};
const coachingStageSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'name', 'analysisId', 'status', 'prompt', 'attempts', 'durationMs',
    'responseFormat', 'fallbackUsed', 'output',
  ],
  properties: {
    name: { const: 'coaching-analysis' },
    analysisId: { type: 'string', pattern: UUID_PATTERN },
    ...stageMetricsProperties,
    output: COACHING_RESPONSE_SCHEMA,
  },
};
const taskFirstDecompositionSchemaV3 = {
  type: 'object',
  additionalProperties: false,
  required: [
    'pipelineVersion', 'decompositionId', 'businessDate', 'stages', 'taskEvidence',
  ],
  properties: {
    pipelineVersion: { const: 'task-first-v2' },
    decompositionId: { type: 'string', pattern: UUID_PATTERN },
    businessDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    stages: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: { anyOf: [evidenceTaskStageSchema, coachingStageSchema] },
    },
    taskEvidence: decompositionSchemaV2.properties.taskEvidence,
  },
};

const evidenceAgentsStageSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'status', 'attempts', 'durationMs', 'responseFormat', 'output'],
  properties: {
    name: { const: 'evidence-agents' },
    status: { const: 'succeeded' },
    attempts: { type: 'integer', minimum: 0, maximum: 8 },
    durationMs: { type: 'integer', minimum: 0 },
    responseFormat: { enum: ['json_schema', 'json_object'] },
    output: {
      type: 'object',
      additionalProperties: false,
      required: GOAL_KEYS,
      properties: Object.fromEntries(GOAL_KEYS.map(key => [key, {
        type: 'array',
        maxItems: 50,
        items: FACT_ATOM_SCHEMA,
      }])),
    },
  },
};

const reconciliationSucceededStageSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'status', 'attempts', 'durationMs', 'output'],
  properties: {
    name: { const: 'reconciliation' },
    status: { const: 'succeeded' },
    attempts: { type: 'integer', minimum: 1, maximum: 2 },
    durationMs: { type: 'integer', minimum: 0 },
    output: RECONCILIATION_RESPONSE_SCHEMA,
  },
};

const reconciliationDegradedStageSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'status', 'errorCode'],
  properties: {
    name: { const: 'reconciliation' },
    status: { const: 'degraded' },
    errorCode: { type: 'string', minLength: 1, maxLength: 100 },
    fallbackMode: { const: 'one-to-one' },
  },
};

const criticCheckMetaSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'findings', 'attempts', 'durationMs'],
  properties: {
    ok: { type: 'boolean' },
    errorCode: { type: 'string', minLength: 1, maxLength: 100 },
    findings: { type: 'integer', minimum: 0, maximum: 50 },
    attempts: { type: 'integer', minimum: 0, maximum: 3 },
    durationMs: { type: 'integer', minimum: 0 },
  },
};

const criticCompletedStageSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'status', 'attempts', 'durationMs', 'output'],
  properties: {
    name: { const: 'critic' },
    status: { enum: ['succeeded', 'partial', 'degraded'] },
    attempts: { type: 'integer', minimum: 0, maximum: 15 },
    durationMs: { type: 'integer', minimum: 0 },
    output: {
      type: 'object',
      additionalProperties: false,
      required: ['findings', 'checkResults', 'governanceStatus'],
      properties: {
        findings: CRITIC_RESPONSE_SCHEMA.properties.findings,
        checkResults: {
          type: 'object',
          additionalProperties: false,
          required: CRITIC_CHECKS,
          properties: Object.fromEntries(CRITIC_CHECKS.map(key => [key, criticCheckMetaSchema])),
        },
        governanceStatus: { enum: ['accepted', 'review_recommended', 'needs_confirmation'] },
      },
    },
  },
};

const criticFailedStageSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'status', 'errorCode'],
  properties: {
    name: { const: 'critic' },
    status: { const: 'degraded' },
    errorCode: { type: 'string', minLength: 1, maxLength: 100 },
  },
};

const multiAgentDecompositionSchemaV3 = {
  type: 'object',
  additionalProperties: false,
  required: ['pipelineVersion', 'decompositionId', 'businessDate', 'stages', 'taskAtoms'],
  properties: {
    pipelineVersion: { enum: ['multi-agent-v2-phase1', 'multi-agent-v2-phase2', 'multi-agent-v2-phase3'] },
    decompositionId: { type: 'string', pattern: UUID_PATTERN },
    businessDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    stages: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: {
        anyOf: [
          evidenceAgentsStageSchema,
          reconciliationSucceededStageSchema,
          reconciliationDegradedStageSchema,
          criticCompletedStageSchema,
          criticFailedStageSchema,
          coachingStageSchema,
        ],
      },
    },
    taskAtoms: {
      type: 'array',
      maxItems: TASK_LIMIT * 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['taskId', 'atomId'],
        properties: {
          taskId: { type: 'string', pattern: UUID_PATTERN },
          clusterId: { type: 'string', minLength: 1, maxLength: 200 },
          atomId: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
    },
  },
};

const decompositionSchemaV3 = {
  anyOf: [taskFirstDecompositionSchemaV3, multiAgentDecompositionSchemaV3],
};

const snapshotSchemaV2 = {
  type: 'object',
  additionalProperties: false,
  required: ['clientRunId', 'title', 'goals', 'tasks', 'matrix', 'report'],
  properties: {
    clientRunId: { type: 'string', pattern: UUID_PATTERN },
    title: { type: 'string', minLength: 1, maxLength: 100 },
    goals: {
      type: 'object',
      additionalProperties: false,
      required: GOAL_KEYS,
      properties: Object.fromEntries(GOAL_KEYS.map((key) => [key, {
        type: 'string',
        maxLength: TEXT_LIMITS.goal,
      }])),
    },
    decomposition: { anyOf: [decompositionSchemaV2, { type: 'null' }] },
    tasks: {
      type: 'array',
      maxItems: TASK_LIMIT,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
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
          'classificationSource',
        ],
        properties: {
          id: { type: 'string', pattern: UUID_PATTERN },
          name: { type: 'string', minLength: 1, maxLength: TEXT_LIMITS.taskName },
          importance: { enum: IMPORTANCE },
          urgency: { enum: URGENCY },
          source: { enum: SOURCES },
          due: { type: 'string', minLength: 1, maxLength: TEXT_LIMITS.due },
          dueTime: { type: "string", maxLength: 10 },
          est: { type: 'string', maxLength: TEXT_LIMITS.est },
          owner: { type: 'string', minLength: 1, maxLength: TEXT_LIMITS.owner },
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
          classificationSource: { enum: CLASSIFICATION_SOURCE },
        },
      },
    },
    distribution: distributionSchema,
    matrix: {
      type: 'object',
      additionalProperties: false,
      required: ['classifications', 'quadrants', 'note'],
      properties: {
        classifications: {
          type: 'array',
          maxItems: TASK_LIMIT,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['taskId', 'importance', 'urgency', 'classificationSource'],
            properties: {
              taskId: { type: 'string', pattern: UUID_PATTERN },
              importance: { enum: IMPORTANCE },
              urgency: { enum: URGENCY },
              classificationSource: { enum: CLASSIFICATION_SOURCE },
            },
          },
        },
        quadrants: {
          type: 'array',
          minItems: 4,
          maxItems: 4,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'priority', 'action', 'energyPercent', 'taskIds'],
            properties: {
              name: { enum: Object.keys(ENERGY_POLICY) },
              priority: { type: 'integer', minimum: 1, maximum: 4 },
              action: { enum: ['立即做', '计划做', '授权做', '减少做'] },
              energyPercent: { type: 'integer', minimum: 0, maximum: 100 },
              taskIds: {
                type: 'array',
                maxItems: TASK_LIMIT,
                items: { type: 'string', pattern: UUID_PATTERN },
              },
            },
          },
        },
        note: { type: 'string', maxLength: 4000 },
      },
    },
    report: {
      type: 'object',
      additionalProperties: false,
      required: ['order', 'energyRules', 'adjustments'],
      properties: {
        order: {
          type: 'array',
          maxItems: 5,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['taskId', 'reason'],
            properties: {
              taskId: { type: 'string', pattern: UUID_PATTERN },
              reason: { type: 'string', minLength: 1, maxLength: 4000 },
            },
          },
        },
        energyRules: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          items: { type: 'string', minLength: 1, maxLength: 4000 },
        },
        adjustments: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          items: { type: 'string', minLength: 1, maxLength: 4000 },
        },
      },
    },
  },
};

const snapshotSchemaV3 = {
  ...snapshotSchemaV2,
  properties: {
    ...snapshotSchemaV2.properties,
    decomposition: { anyOf: [decompositionSchemaV3, { type: 'null' }] },
  },
};
const validateShapeV2 = ajv.compile(snapshotSchemaV2);
const validateShapeV3 = ajv.compile(snapshotSchemaV3);
const QUADRANT_RULES = Object.freeze({
  第一象限: Object.freeze({ priority: 1, action: '立即做' }),
  第二象限: Object.freeze({ priority: 2, action: '计划做' }),
  第三象限: Object.freeze({ priority: 3, action: '授权做' }),
  第四象限: Object.freeze({ priority: 4, action: '减少做' }),
});

const SUPPORTED_READ_VERSIONS = Object.freeze(new Set([1, 2, 3]));
const PERCENT_TOLERANCE = 0.1;
const MINUTES_TOLERANCE = 1;

function inputError() {
  return Object.assign(new Error('历史快照格式不正确。'), {
    code: 'INPUT_INVALID',
    status: 400,
    expose: true,
  });
}

function dataError() {
  return Object.assign(new Error('历史数据暂时无法读取。'), {
    code: 'HISTORY_DATA_INVALID',
    status: 500,
    expose: false,
  });
}

function containsTaskIdLeak(text, tasks) {
  if (typeof text !== 'string') return false;
  const lowered = text.toLowerCase();
  return tasks.some((task) => (
    lowered.includes(task.id.toLowerCase())
    || lowered.includes(task.id.slice(0, 8).toLowerCase())
  ));
}

function containsModelArtifacts(texts) {
  const patterns = [
    /{/,
    /}/,
    /"model"/i,
    /"prompt"/i,
    /"content"/i,
    /"role"/i,
    /"messages"/i,
    /api[_-]?key/i,
    /sk-[a-zA-Z0-9]{20,}/,
    /"error"/i,
    /stacktrace/i,
    /"choices"/i,
    /"usage"/i,
  ];
  return texts.some((text) => {
    if (typeof text !== 'string') return false;
    return patterns.some((pattern) => pattern.test(text));
  });
}

function assertDistributionSemantics(distribution, tasks) {
  if (!validateDistribution(distribution)) throw inputError();

  const taskIds = new Set(tasks.map((task) => task.id));
  const invalidIds = new Set();
  for (const item of distribution.invalidTasks) {
    if (!taskIds.has(item.taskId)) throw inputError();
    if (invalidIds.has(item.taskId)) throw inputError();
    invalidIds.add(item.taskId);
  }

  if (distribution.validTaskCount + distribution.invalidTasks.length !== tasks.length) {
    throw inputError();
  }

  const categoryKeys = new Set();
  const categorySum = distribution.categories.reduce((sum, item) => {
    if (categoryKeys.has(item.key)) throw inputError();
    categoryKeys.add(item.key);
    return sum + item.minutes;
  }, 0);
  if (categoryKeys.size !== 4 || !CATEGORY_KEYS.every((key) => categoryKeys.has(key))) {
    throw inputError();
  }

  if (Math.abs(categorySum - distribution.totalMinutes) > MINUTES_TOLERANCE) {
    throw inputError();
  }

  const percentSum = Object.values(distribution.percentages).reduce((sum, value) => sum + value, 0);
  if (Math.abs(percentSum - 100) > PERCENT_TOLERANCE) throw inputError();

  for (const key of CATEGORY_KEYS) {
    if (typeof distribution.percentages[key] !== 'number') throw inputError();
  }

  for (const item of distribution.categories) {
    const expectedPercent = distribution.percentages[item.key];
    if (Math.abs(item.percent - expectedPercent) > PERCENT_TOLERANCE) throw inputError();
    if (item.target.min < 0 || item.target.max > 100 || item.target.min > item.target.max) throw inputError();
  }

  if (containsModelArtifacts(distribution.diagnosis)) throw inputError();
  if (containsModelArtifacts(distribution.recommendations)) throw inputError();
}

function assertDecompositionSemanticsV2(decomposition, tasks, goals) {
  if (decomposition == null) return;
  const stageByName = new Map();
  for (const stage of decomposition.stages) {
    if (stageByName.has(stage.name)) throw inputError();
    stageByName.set(stage.name, stage);
  }
  const coachStage = stageByName.get('coach-analysis');
  const taskStage = stageByName.get('task-generation');
  if (
    stageByName.size !== 2
    || !coachStage
    || !taskStage
    || coachStage.prompt.id !== 'decomposition.coach-analysis'
    || taskStage.prompt.id !== 'decomposition.task-generation'
    || !validateCoachResponse(coachStage.output)
    || !validateTaskResponse(taskStage.output)
  ) {
    throw inputError();
  }

  const evidenceById = new Map();
  for (const evidence of coachStage.output.evidence) {
    if (
      evidenceById.has(evidence.id)
      || !String(goals[evidence.dimension] || '').includes(evidence.quote)
      || (evidence.owner !== '待确认'
        && !String(goals[evidence.dimension] || '').includes(evidence.owner))
      || (evidence.due !== '待确认'
        && !String(goals[evidence.dimension] || '').includes(evidence.due))
    ) {
      throw inputError();
    }
    evidenceById.set(evidence.id, evidence);
  }
  visitClaims(coachStage.output.coachingAnalysis, (claim) => {
    if (
      new Set(claim.evidenceIds).size !== claim.evidenceIds.length
      || claim.evidenceIds.some(id => !evidenceById.has(id))
      || (claim.evidenceIds.length === 0 && !claim.text.startsWith('证据不足'))
    ) {
      throw inputError();
    }
  });

  if (decomposition.taskEvidence.length !== taskStage.output.tasks.length) {
    throw inputError();
  }
  const sourceForDimension = {
    昨天: '复盘',
    今天: '今天',
    明天: '短期目标',
    后天: '中长期',
  };
  const linkedTaskIds = new Set();
  for (let index = 0; index < taskStage.output.tasks.length; index += 1) {
    const link = decomposition.taskEvidence[index];
    const candidate = taskStage.output.tasks[index];
    const primary = evidenceById.get(candidate.evidenceIds[0]);
    const sourceMatches = primary?.dimension === '今天'
      ? ['今天', '临时'].includes(candidate.source)
      : candidate.source === sourceForDimension[primary?.dimension];
    if (
      linkedTaskIds.has(link.taskId)
      || candidate.status !== 'pending'
      || candidate.evidenceIds.length === 0
      || new Set(candidate.evidenceIds).size !== candidate.evidenceIds.length
      || candidate.evidenceIds.some(id => !evidenceById.has(id))
      || JSON.stringify(link.evidenceIds) !== JSON.stringify(candidate.evidenceIds)
      || !sourceMatches
      || ['completed', 'not_actionable'].includes(primary?.status)
      || (candidate.owner !== '待确认' && candidate.owner !== primary?.owner)
      || (candidate.due !== '待确认' && candidate.due !== primary?.due)
    ) {
      throw inputError();
    }
    linkedTaskIds.add(link.taskId);
  }

  // Final tasks may differ after user review. Generated IDs can be edited,
  // deleted, or joined by manual tasks, while the original trace remains intact.
  const finalTaskIds = new Set(tasks.map(task => task.id));
  if (finalTaskIds.size !== tasks.length) throw inputError();
}

function assertMultiAgentDecompositionSemantics(decomposition, tasks, goals) {
  const stageByName = new Map();
  for (const stage of decomposition.stages) {
    if (stageByName.has(stage.name)) throw inputError();
    stageByName.set(stage.name, stage);
  }

  const evidenceStage = stageByName.get('evidence-agents');
  if (!evidenceStage) throw inputError();
  const lines = Object.fromEntries(
    GOAL_KEYS.map(key => [key, splitEntries(goals[key])]),
  );
  const atoms = GOAL_KEYS.flatMap(key => evidenceStage.output[key]);
  const atomsById = new Map();
  const coveredLines = new Set();
  for (const atom of atoms) {
    const sourceLine = lines[atom.dimension]?.[atom.sourceLineIndex];
    if (
      atomsById.has(atom.id)
      || !sourceLine
      || !sourceLine.includes(atom.quote)
    ) {
      throw inputError();
    }
    atomsById.set(atom.id, atom);
    coveredLines.add(`${atom.dimension}:${atom.sourceLineIndex}`);
  }
  for (const dimension of GOAL_KEYS) {
    for (const index of lines[dimension].keys()) {
      if (!coveredLines.has(`${dimension}:${index}`)) throw inputError();
    }
  }

  const reconciliationStage = stageByName.get('reconciliation');
  const clustersById = new Map();
  const atomCluster = new Map();
  if (reconciliationStage?.status === 'succeeded') {
    for (const cluster of reconciliationStage.output.clusters) {
      if (clustersById.has(cluster.id)) throw inputError();
      clustersById.set(cluster.id, cluster);
      const clusterAtoms = new Set(cluster.atomIds);
      for (const atomId of cluster.atomIds) {
        if (!atomsById.has(atomId) || atomCluster.has(atomId)) throw inputError();
        atomCluster.set(atomId, cluster.id);
      }
      for (const relation of cluster.relations) {
        if (
          !clusterAtoms.has(relation.fromAtom)
          || !clusterAtoms.has(relation.toAtom)
        ) {
          throw inputError();
        }
      }
    }
    if (atomCluster.size !== atomsById.size) throw inputError();
    for (const conflict of reconciliationStage.output.conflicts) {
      const clusterIds = new Set();
      for (const atomId of conflict.atomIds) {
        if (!atomsById.has(atomId)) throw inputError();
        const clusterId = atomCluster.get(atomId);
        if (!clusterId) throw inputError();
        clusterIds.add(clusterId);
      }
      if (clusterIds.size !== 1) throw inputError();
    }
  }

  const taskIds = new Set(tasks.map(task => task.id));
  const taskAtomEdges = new Set();
  for (const link of decomposition.taskAtoms) {
    const edge = `${link.taskId}:${link.atomId}`;
    if (
      taskAtomEdges.has(edge)
      || !taskIds.has(link.taskId)
      || !atomsById.has(link.atomId)
    ) {
      throw inputError();
    }
    if (link.clusterId) {
      const cluster = clustersById.get(link.clusterId);
      if (!cluster || !cluster.atomIds.includes(link.atomId)) throw inputError();
    }
    taskAtomEdges.add(edge);
  }

  const criticStage = stageByName.get('critic');
  if (criticStage?.output) {
    for (const finding of criticStage.output.findings) {
      if (
        finding.taskIds.some(taskId => !taskIds.has(taskId))
        || finding.atomIds.some(atomId => !atomsById.has(atomId))
      ) {
        throw inputError();
      }
    }
  }

  const coachingStage = stageByName.get('coaching-analysis');
  if (coachingStage) {
    const coachingEvidenceIds = new Set(atoms.map((atom, index) => `E${index + 1}`));
    visitClaims(coachingStage.output.coachingAnalysis, claim => {
      if (
        new Set(claim.evidenceIds).size !== claim.evidenceIds.length
        || claim.evidenceIds.some(id => !coachingEvidenceIds.has(id))
        || (claim.evidenceIds.length === 0 && !claim.text.startsWith('证据不足'))
      ) {
        throw inputError();
      }
    });
  }
}

function assertDecompositionSemanticsV3(decomposition, tasks, goals) {
  if (decomposition == null) return;
  if (decomposition.pipelineVersion.startsWith('multi-agent-v2')) {
    assertMultiAgentDecompositionSemantics(decomposition, tasks, goals);
    return;
  }
  const stageByName = new Map();
  for (const stage of decomposition.stages) {
    if (stageByName.has(stage.name)) throw inputError();
    stageByName.set(stage.name, stage);
  }
  const taskStage = stageByName.get('evidence-task-generation');
  const coachingStage = stageByName.get('coaching-analysis');
  const taskPromptVersion = taskStage?.prompt.version;
  const supportsRelatedYesterdayCoverage = taskPromptVersion === '2.1.0';
  const correctionPrompt = taskStage?.correctionPrompt;
  if (
    !taskStage
    || stageByName.size !== (coachingStage ? 2 : 1)
    || taskStage.prompt.id !== 'decomposition.evidence-task-generation'
    || !['2.0.0', '2.1.0'].includes(taskPromptVersion)
    || !validateEvidenceTaskResponse(taskStage.output)
    || (correctionPrompt && (
      !supportsRelatedYesterdayCoverage
      || correctionPrompt.id !== 'decomposition.task-generation'
      || correctionPrompt.version !== '1.1.0'
      || taskStage.attempts < 2
    ))
    || (coachingStage && (
      coachingStage.prompt.id !== 'decomposition.coaching-analysis'
      || coachingStage.prompt.version !== '2.0.0'
      || !validateCoachingResponse(coachingStage.output)
    ))
  ) {
    throw inputError();
  }

  const lines = Object.fromEntries(
    GOAL_KEYS.map(key => [key, splitEntries(goals[key])]),
  );
  const evidenceById = new Map();
  const coveredLines = new Set();
  for (const evidence of taskStage.output.evidence) {
    const sourceLine = lines[evidence.dimension]?.[evidence.sourceLineIndex];
    if (
      evidenceById.has(evidence.id)
      || !sourceLine
      || !sourceLine.includes(evidence.quote)
      || (evidence.owner !== '待确认' && !sourceLine.includes(evidence.owner))
      || (evidence.due !== '待确认' && !sourceLine.includes(evidence.due))
    ) {
      throw inputError();
    }
    evidenceById.set(evidence.id, evidence);
    coveredLines.add(`${evidence.dimension}:${evidence.sourceLineIndex}`);
  }
  for (const dimension of GOAL_KEYS) {
    for (const index of lines[dimension].keys()) {
      if (!coveredLines.has(`${dimension}:${index}`)) throw inputError();
    }
  }

  if (coachingStage) {
    visitClaims(coachingStage.output.coachingAnalysis, claim => {
      if (
        new Set(claim.evidenceIds).size !== claim.evidenceIds.length
        || claim.evidenceIds.some(id => !evidenceById.has(id))
        || (claim.evidenceIds.length === 0 && !claim.text.startsWith('证据不足'))
      ) {
        throw inputError();
      }
    });
  }

  const candidates = taskStage.output.tasks;
  if (decomposition.taskEvidence.length !== candidates.length) throw inputError();
  const primaryCoverage = new Set();
  const relatedYesterdayCoverage = new Set();
  const linkedTaskIds = new Set();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const link = decomposition.taskEvidence[index];
    const referenced = candidate.evidenceIds.map(id => evidenceById.get(id));
    const primary = referenced[0];
    const ownerGrounded = supportsRelatedYesterdayCoverage
      ? candidate.owner === primary?.owner
      : candidate.owner === '待确认' || candidate.owner === primary?.owner;
    const dueGrounded = supportsRelatedYesterdayCoverage
      ? candidate.due === primary?.due
      : candidate.due === '待确认' || candidate.due === primary?.due;
    if (
      linkedTaskIds.has(link.taskId)
      || candidate.status !== 'pending'
      || candidate.evidenceIds.length === 0
      || new Set(candidate.evidenceIds).size !== candidate.evidenceIds.length
      || referenced.some(item => !item)
      || referenced.some(item => NON_ACTIONABLE_EVIDENCE_STATUSES.has(item.status))
      || JSON.stringify(link.evidenceIds) !== JSON.stringify(candidate.evidenceIds)
      || !taskSourceMatchesPrimary(candidate, primary)
      || !ownerGrounded
      || !dueGrounded
    ) {
      throw inputError();
    }
    if (supportsRelatedYesterdayCoverage) {
      for (const auxiliary of referenced.slice(1)) {
        if (auxiliary.dimension !== '昨天') continue;
        if (!isDirectlyRelatedAuxiliary(primary, auxiliary)) throw inputError();
        relatedYesterdayCoverage.add(auxiliary.id);
      }
    }
    primaryCoverage.add(primary.id);
    linkedTaskIds.add(link.taskId);
  }
  for (const evidence of evidenceById.values()) {
    if (!ACTIONABLE_EVIDENCE_STATUSES.has(evidence.status)) continue;
    const covered = primaryCoverage.has(evidence.id)
      || (
        supportsRelatedYesterdayCoverage
        && evidence.dimension === '昨天'
        && relatedYesterdayCoverage.has(evidence.id)
      );
    if (!covered) throw inputError();
  }

  const finalTaskIds = new Set(tasks.map(task => task.id));
  if (finalTaskIds.size !== tasks.length) throw inputError();
}

function assertSemantics(snapshot, schemaVersion = HISTORY_SCHEMA_VERSION) {
  if (!snapshot.title.trim()) throw inputError();
  const tasksById = new Map();
  for (const task of snapshot.tasks) {
    if (!task.name.trim() || tasksById.has(task.id)) throw inputError();
    if (task.classificationSource === 'unclassified') throw inputError();
    tasksById.set(task.id, task);
  }

  if (snapshot.matrix.classifications.length !== snapshot.tasks.length) throw inputError();
  const classifications = new Map();
  for (const item of snapshot.matrix.classifications) {
    const task = tasksById.get(item.taskId);
    if (!task || classifications.has(item.taskId)) throw inputError();
    if (
      item.importance !== task.importance
      || item.urgency !== task.urgency
      || item.classificationSource !== task.classificationSource
    ) {
      throw inputError();
    }
    classifications.set(item.taskId, item);
  }

  const quadrantByName = new Map();
  const placedIds = [];
  for (const quadrant of snapshot.matrix.quadrants) {
    const rule = QUADRANT_RULES[quadrant.name];
    if (
      !rule
      || quadrantByName.has(quadrant.name)
      || quadrant.priority !== rule.priority
      || quadrant.action !== rule.action
      || quadrant.energyPercent !== ENERGY_POLICY[quadrant.name]
    ) {
      throw inputError();
    }
    quadrantByName.set(quadrant.name, quadrant);
    placedIds.push(...quadrant.taskIds);
  }
  if (
    quadrantByName.size !== 4
    || placedIds.length !== snapshot.tasks.length
    || new Set(placedIds).size !== placedIds.length
    || placedIds.some((id) => !tasksById.has(id))
  ) {
    throw inputError();
  }
  for (const task of snapshot.tasks) {
    if (!quadrantByName.get(quadrantFor(task)).taskIds.includes(task.id)) throw inputError();
  }

  const orderIds = snapshot.report.order.map((item) => item.taskId);
  if (
    new Set(orderIds).size !== orderIds.length
    || orderIds.some((id) => !tasksById.has(id))
  ) {
    throw inputError();
  }
  const visibleText = [
    ...snapshot.report.order.map((item) => item.reason),
    ...snapshot.report.energyRules,
    ...snapshot.report.adjustments,
  ];
  if (visibleText.some((text) => containsTaskIdLeak(text, snapshot.tasks))) throw inputError();

  if (schemaVersion >= 2) {
    if (!snapshot.distribution) throw inputError();
    assertDistributionSemantics(snapshot.distribution, snapshot.tasks);
  }
  if (schemaVersion === 2) {
    assertDecompositionSemanticsV2(snapshot.decomposition, snapshot.tasks, snapshot.goals);
  }
  if (schemaVersion === 3) {
    assertDecompositionSemanticsV3(snapshot.decomposition, snapshot.tasks, snapshot.goals);
  }
}

function validateHistorySnapshot(value, { dueMode = 'read', schemaVersion = HISTORY_SCHEMA_VERSION } = {}) {
  if (!['read', 'write'].includes(dueMode)) throw inputError();
  if (!SUPPORTED_READ_VERSIONS.has(schemaVersion)) throw inputError();
  const normalized = Array.isArray(value?.tasks)
    ? {
      ...value,
      tasks: value.tasks.map((task) => {
        const withOwner = normalizeOptionalOwner(normalizeOptionalDue(task));
        return dueMode === 'write' ? normalizeDueForWrite(withOwner) : withOwner;
      }),
      // 降级报告是生成期状态，不写入历史契约（report 保持字符串数组）
      report: value.report
        ? Object.fromEntries(
          Object.entries(value.report).filter(([key]) => !key.startsWith('degraded')),
        )
        : value.report,
    }
    : value;
  const validateShape = schemaVersion === 3 ? validateShapeV3 : validateShapeV2;
  if (!validateShape(normalized)) throw inputError();
  assertSemantics(normalized, schemaVersion);
  return JSON.parse(JSON.stringify(normalized));
}

function decodeStoredSnapshot(record) {
  try {
    if (!record || !SUPPORTED_READ_VERSIONS.has(record.schemaVersion)) throw dataError();
    const base = {
      clientRunId: record.clientRunId,
      title: record.title,
      goals: JSON.parse(record.goalsJson),
      tasks: JSON.parse(record.tasksJson),
      matrix: JSON.parse(record.matrixJson),
      report: JSON.parse(record.reportJson),
    };

    if (record.schemaVersion === 1) {
      const validated = validateHistorySnapshot(base, { schemaVersion: 1 });
      return { ...validated, distribution: null };
    }

    let distribution = null;
    if (typeof record.distributionJson === 'string') {
      distribution = JSON.parse(record.distributionJson);
    }
    if (!distribution) throw dataError();

    const candidate = { ...base, distribution };
    if (typeof record.decompositionJson === 'string') {
      candidate.decomposition = JSON.parse(record.decompositionJson);
    }
    return validateHistorySnapshot(candidate, { schemaVersion: record.schemaVersion });
  } catch (error) {
    if (error?.code === 'INPUT_INVALID' || error?.code === 'HISTORY_DATA_INVALID') {
      throw error;
    }
    throw dataError();
  }
}

module.exports = {
  HISTORY_SCHEMA_VERSION,
  UUID_PATTERN,
  decodeStoredSnapshot,
  validateHistorySnapshot,
};
