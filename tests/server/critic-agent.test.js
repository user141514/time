const test = require('node:test');
const assert = require('node:assert/strict');

const { runCriticAgent } = require('../../server/workflows/critic-agent');

function fixture() {
  const atom = {
    id: 'atom-1',
    dimension: '今天',
    sourceLineIndex: 0,
    quote: '由王芳负责今天18:00前提交排期表',
    kind: 'work',
    action: '提交排期表',
    actor: { role: 'explicit', name: '王芳' },
    dueRef: '今天18:00前',
    status: 'planned',
    relatedTo: '',
    confidence: { actor: 1, due: 1, status: 1 },
  };
  const task = {
    id: 'task-1',
    name: '提交排期表',
    owner: '王芳',
    due: '2026-08-04',
    source: '今天',
  };
  const cluster = {
    id: 'cluster-1',
    label: '提交排期表',
    atomIds: ['atom-1'],
  };
  return {
    atoms: [atom],
    clusters: [cluster],
    compiledItems: [{
      task,
      clusterId: 'cluster-1',
      atomIds: ['atom-1'],
      reviewRequired: false,
      unresolvedFields: [],
    }],
  };
}

function requestName(request) {
  return request.responseSchemaName;
}

test('critic checks receive compiled task lineage and real evidence quotes', async () => {
  const data = fixture();
  const requests = [];
  const result = await runCriticAgent({
    ...data,
    modelClient: {
      async completeJson(request) {
        requests.push(request);
        return { findings: [] };
      },
    },
  });

  const ownerRequest = requests.find(item => requestName(item) === 'time_critic_owner_v1');
  const ownerInput = JSON.parse(ownerRequest.user);
  assert.deepEqual(ownerInput.tasks[0].evidence, [{
    id: 'atom-1',
    dimension: '今天',
    quote: '由王芳负责今天18:00前提交排期表',
  }]);

  const dueRequest = requests.find(item => requestName(item) === 'time_critic_due_v1');
  const dueInput = JSON.parse(dueRequest.user);
  assert.deepEqual(dueInput.tasks[0].cluster.atomIds, ['atom-1']);
  assert.equal(result.status, 'succeeded');
});

test('one critic transport failure does not cancel the other checks', async () => {
  const data = fixture();
  const result = await runCriticAgent({
    ...data,
    modelClient: {
      async completeJson(request) {
        if (requestName(request) === 'time_critic_owner_v1') {
          throw Object.assign(new Error('upstream unavailable'), {
            code: 'MODEL_UPSTREAM_ERROR',
          });
        }
        return { findings: [] };
      },
    },
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.checkResults.owner.ok, false);
  assert.equal(result.checkResults.owner.errorCode, 'MODEL_UPSTREAM_ERROR');
  assert.equal(result.checkResults.due.ok, true);
  assert.equal(result.checkResults.coverage.ok, true);
  assert.equal(result.checkResults.dedupe.ok, true);
  assert.equal(result.checkResults.source.ok, true);
});

test('critic findings with unknown task or atom IDs are rejected per check', async () => {
  const data = fixture();
  const result = await runCriticAgent({
    ...data,
    modelClient: {
      async completeJson(request) {
        if (requestName(request) === 'time_critic_owner_v1') {
          return {
            findings: [{
              severity: 'blocker',
              category: 'owner_hallucination',
              description: '引用不存在的任务和证据',
              atomIds: ['ghost-atom'],
              taskIds: ['ghost-task'],
            }],
          };
        }
        return { findings: [] };
      },
    },
  });

  assert.equal(result.status, 'partial');
  assert.deepEqual(result.findings, []);
  assert.equal(result.checkResults.owner.ok, false);
  assert.equal(result.checkResults.owner.errorCode, 'MODEL_OUTPUT_INVALID');
});
