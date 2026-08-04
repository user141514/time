const test = require('node:test');
const assert = require('node:assert/strict');

const { runReconciliationAgent } = require('../../server/workflows/reconciliation-agent');

function atom(id, dimension = '今天') {
  return {
    id,
    dimension,
    sourceLineIndex: 0,
    quote: `${id} 原文`,
    kind: 'work',
    action: `${id} 动作`,
    actor: { role: 'unknown', name: '' },
    dueRef: '',
    status: 'planned',
    relatedTo: '',
    confidence: { actor: 0, due: 0, status: 1 },
  };
}

function cluster(id, atomIds, relations = []) {
  return {
    id,
    label: `${id} 工作项`,
    atomIds,
    relations,
    mergedOwner: { name: '', source: 'implied' },
    mergedDueRef: '',
    mergedStatus: 'planned',
  };
}

function repeatedResponse(response) {
  const calls = [];
  return {
    calls,
    async completeJson(request) {
      calls.push(request);
      return structuredClone(response);
    },
  };
}

async function expectRule(response, atoms, rule) {
  const modelClient = repeatedResponse(response);
  await assert.rejects(
    runReconciliationAgent({
      atoms,
      byDimension: { 昨天: [], 今天: atoms, 明天: [], 后天: [] },
      entries: { 昨天: '', 今天: atoms.map(item => item.quote).join('\n'), 明天: '', 后天: '' },
      businessDate: '2026-08-04',
      modelClient,
    }),
    error => error.code === 'MODEL_OUTPUT_INVALID'
      && Array.isArray(error.failedRules)
      && error.failedRules.includes(rule),
  );
  assert.equal(modelClient.calls.length, 2);
}

test('reconciliation rejects cluster atom IDs that do not exist', async () => {
  const atoms = [atom('atom-1')];
  await expectRule({
    clusters: [cluster('cluster-1', ['atom-1', 'ghost-atom'])],
    conflicts: [],
  }, atoms, 'CLUSTER_ATOM_NOT_FOUND');
});

test('reconciliation rejects relations whose endpoints are outside the current cluster', async () => {
  const atoms = [atom('atom-1'), atom('atom-2')];
  await expectRule({
    clusters: [
      cluster('cluster-1', ['atom-1'], [{
        fromAtom: 'atom-1',
        toAtom: 'atom-2',
        type: 'dependency',
        rationale: '错误地跨 cluster 建立关系',
      }]),
      cluster('cluster-2', ['atom-2']),
    ],
    conflicts: [],
  }, atoms, 'RELATION_ATOM_OUTSIDE_CLUSTER');
});

test('reconciliation rejects conflicts whose atoms belong to different clusters', async () => {
  const atoms = [atom('atom-1'), atom('atom-2')];
  await expectRule({
    clusters: [
      cluster('cluster-1', ['atom-1']),
      cluster('cluster-2', ['atom-2']),
    ],
    conflicts: [{
      atomIds: ['atom-1', 'atom-2'],
      field: 'owner',
      description: '跨 cluster 伪造冲突',
      resolution: 'human_needed',
    }],
  }, atoms, 'CONFLICT_ATOMS_OUTSIDE_SINGLE_CLUSTER');
});

test('reconciliation rejects conflicts that reference unknown atoms', async () => {
  const atoms = [atom('atom-1'), atom('atom-2')];
  await expectRule({
    clusters: [cluster('cluster-1', ['atom-1', 'atom-2'])],
    conflicts: [{
      atomIds: ['atom-1', 'ghost-atom'],
      field: 'owner',
      description: '责任人冲突',
      resolution: 'human_needed',
    }],
  }, atoms, 'CONFLICT_ATOM_NOT_FOUND');
});
