const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true, strict: true });

const WORK_ITEM_CLUSTER_LIMIT = 100;
const CONFLICT_LIMIT = 50;
const CLUSTER_ATOM_LIMIT = 20;
const CLUSTER_RELATION_LIMIT = 20;

const RELATION_TYPES = Object.freeze([
  'same_work_item', 'continuation', 'dependency', 'duplicate', 'conflict', 'unrelated',
]);
const OWNER_SOURCES = Object.freeze(['explicit', 'implied', 'conflict']);
const CONFLICT_FIELDS = Object.freeze(['owner', 'due', 'status', 'action']);
const CONFLICT_RESOLUTIONS = Object.freeze(['use_explicit', 'use_latest', 'keep_both', 'human_needed']);

// One cluster = one canonical work object, possibly spanning multiple goal columns
const WORK_ITEM_CLUSTER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['id', 'label', 'atomIds', 'relations', 'mergedOwner', 'mergedDueRef', 'mergedStatus'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 200 },
    label: { type: 'string', minLength: 1, maxLength: 400 }, // canonical work object name
    atomIds: {
      type: 'array', minItems: 1, maxItems: CLUSTER_ATOM_LIMIT,
      items: { type: 'string', minLength: 1, maxLength: 200 },
    },
    relations: {
      type: 'array', maxItems: CLUSTER_RELATION_LIMIT,
      items: {
        type: 'object', additionalProperties: false,
        required: ['fromAtom', 'toAtom', 'type', 'rationale'],
        properties: {
          fromAtom: { type: 'string', minLength: 1, maxLength: 200 },
          toAtom: { type: 'string', minLength: 1, maxLength: 200 },
          type: { enum: RELATION_TYPES },
          rationale: { type: 'string', minLength: 1, maxLength: 2000 },
        },
      },
    },
    mergedOwner: {
      type: 'object', additionalProperties: false,
      required: ['name', 'source'],
      properties: {
        name: { type: 'string', maxLength: 100 },
        source: { enum: OWNER_SOURCES },
      },
    },
    mergedDueRef: { type: 'string', maxLength: 200 }, // raw time expression or empty
    mergedStatus: { enum: ['unfinished', 'planned', 'both'] },
  },
});

const CONFLICT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['atomIds', 'field', 'description', 'resolution'],
  properties: {
    atomIds: {
      type: 'array', minItems: 2, maxItems: 10, uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 200 },
    },
    field: { enum: CONFLICT_FIELDS },
    description: { type: 'string', minLength: 1, maxLength: 2000 },
    resolution: { enum: CONFLICT_RESOLUTIONS },
  },
});

const RECONCILIATION_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['clusters', 'conflicts'],
  properties: {
    clusters: { type: 'array', maxItems: WORK_ITEM_CLUSTER_LIMIT, items: WORK_ITEM_CLUSTER_SCHEMA },
    conflicts: { type: 'array', maxItems: CONFLICT_LIMIT, items: CONFLICT_SCHEMA },
  },
});

const validateReconciliationResponse = ajv.compile(RECONCILIATION_RESPONSE_SCHEMA);

function contractError(failedRules) {
  return Object.assign(
    new Error('AI 返回格式异常，请重试。'),
    { code: 'MODEL_OUTPUT_INVALID', status: 502, expose: true, stage: 'reconciliation-agent', failedRules },
  );
}

function assertNoDuplicateAtomsInClusters(response) {
  const seen = new Set();
  for (const cluster of response.clusters) {
    for (const atomId of cluster.atomIds) {
      if (seen.has(atomId)) {
        throw contractError(['CLUSTER_ATOM_DUPLICATED']);
      }
      seen.add(atomId);
    }
  }
}

function assertAllAtomsClustered(response, allAtomIds) {
  const clustered = new Set();
  for (const cluster of response.clusters) {
    for (const atomId of cluster.atomIds) {
      clustered.add(atomId);
    }
  }
  for (const atomId of allAtomIds) {
    if (!clustered.has(atomId)) {
      throw contractError(['ATOM_NOT_CLUSTERED']);
    }
  }
}

function assertClusterAtomIdsExist(response, atoms) {
  const valid = new Set(atoms.map(atom => atom.id));
  for (const cluster of response.clusters) {
    if (cluster.atomIds.some(atomId => !valid.has(atomId))) {
      throw contractError(['CLUSTER_ATOM_NOT_FOUND']);
    }
  }
}

function assertClusterRelationsValid(response, atoms) {
  const valid = new Set(atoms.map(atom => atom.id));
  for (const cluster of response.clusters) {
    const clusterAtoms = new Set(cluster.atomIds);
    for (const relation of cluster.relations) {
      if (!valid.has(relation.fromAtom) || !valid.has(relation.toAtom)) {
        throw contractError(['RELATION_ATOM_NOT_FOUND']);
      }
      if (!clusterAtoms.has(relation.fromAtom) || !clusterAtoms.has(relation.toAtom)) {
        throw contractError(['RELATION_ATOM_OUTSIDE_CLUSTER']);
      }
    }
  }
}

function assertConflictAtomIdsExist(response, atoms) {
  const valid = new Set(atoms.map(atom => atom.id));
  for (const conflict of response.conflicts) {
    if (conflict.atomIds.some(atomId => !valid.has(atomId))) {
      throw contractError(['CONFLICT_ATOM_NOT_FOUND']);
    }
  }
}

function assertConflictAtomsShareCluster(response) {
  const clusterByAtom = new Map();
  for (const cluster of response.clusters) {
    for (const atomId of cluster.atomIds) clusterByAtom.set(atomId, cluster.id);
  }
  for (const conflict of response.conflicts) {
    const clusterIds = new Set(conflict.atomIds.map(atomId => clusterByAtom.get(atomId)));
    if (clusterIds.size !== 1 || clusterIds.has(undefined)) {
      throw contractError(['CONFLICT_ATOMS_OUTSIDE_SINGLE_CLUSTER']);
    }
  }
}

module.exports = {
  CLUSTER_ATOM_LIMIT,
  CLUSTER_RELATION_LIMIT,
  CONFLICT_FIELDS,
  CONFLICT_LIMIT,
  CONFLICT_RESOLUTIONS,
  CONFLICT_SCHEMA,
  OWNER_SOURCES,
  RECONCILIATION_RESPONSE_SCHEMA,
  RELATION_TYPES,
  WORK_ITEM_CLUSTER_LIMIT,
  WORK_ITEM_CLUSTER_SCHEMA,
  assertAllAtomsClustered,
  assertClusterAtomIdsExist,
  assertClusterRelationsValid,
  assertConflictAtomIdsExist,
  assertConflictAtomsShareCluster,
  assertNoDuplicateAtomsInClusters,
  validateReconciliationResponse,
};
