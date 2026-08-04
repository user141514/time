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

test('combined critic receives all task evidence in a single call', async () => {
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

  // Single combined call instead of 5 parallel calls
  assert.equal(requests.length, 1);
  assert.equal(requests[0].responseSchemaName, 'time_critic_combined_v1');

  // Combined input includes all tasks with evidence
  const input = JSON.parse(requests[0].user);
  assert.deepEqual(input.tasks[0].evidence, [{
    id: 'atom-1',
    dimension: '今天',
    kind: 'work',
    quote: '由王芳负责今天18:00前提交排期表',
  }]);
  assert.equal(input.tasks[0].owner, '王芳');
  assert.equal(input.tasks[0].due, '2026-08-04');
  assert.deepEqual(input.atoms, [{
    id: 'atom-1',
    dimension: '今天',
    kind: 'work',
    quote: '由王芳负责今天18:00前提交排期表',
  }]);
  assert.deepEqual(input.clusters, [{ id: 'cluster-1', label: '提交排期表', atomIds: ['atom-1'] }]);

  assert.equal(result.status, 'succeeded');
  // All 5 check slots share the same combined meta for backward compat
  for (const key of ['owner', 'due', 'coverage', 'dedupe', 'source']) {
    assert.equal(result.checkResults[key].ok, true);
  }
});

test('combined critic transport failure degrades all checks together', async () => {
  const data = fixture();
  const result = await runCriticAgent({
    ...data,
    modelClient: {
      async completeJson() {
        throw Object.assign(new Error('upstream unavailable'), {
          code: 'MODEL_UPSTREAM_ERROR',
        });
      },
    },
  });

  // Single call failure → all checks degraded
  assert.equal(result.status, 'degraded');
  assert.deepEqual(result.findings, []);
  for (const key of ['owner', 'due', 'coverage', 'dedupe', 'source']) {
    assert.equal(result.checkResults[key].ok, false);
    assert.equal(result.checkResults[key].errorCode, 'MODEL_UPSTREAM_ERROR');
  }
});

test('combined critic rejects findings with unknown task or atom IDs', async () => {
  const data = fixture();
  const result = await runCriticAgent({
    ...data,
    modelClient: {
      async completeJson() {
        return {
          findings: [{
            severity: 'blocker',
            category: 'owner_hallucination',
            description: '引用不存在的任务和证据',
            atomIds: ['ghost-atom'],
            taskIds: ['ghost-task'],
          }],
        };
      },
    },
  });

  // Combined call fails validation → retry once, then empty findings
  assert.equal(result.status, 'degraded');
  assert.deepEqual(result.findings, []);
  for (const key of ['owner', 'due', 'coverage', 'dedupe', 'source']) {
    assert.equal(result.checkResults[key].ok, false);
    assert.equal(result.checkResults[key].errorCode, 'MODEL_OUTPUT_INVALID');
  }
});

test('combined critic retries once with retryFeedback on MODEL_OUTPUT_INVALID', async () => {
  const data = fixture();
  const requests = [];
  const result = await runCriticAgent({
    ...data,
    modelClient: {
      async completeJson(request) {
        requests.push(request);
        if (requests.length === 1) {
          throw Object.assign(new Error('invalid json'), {
            code: 'MODEL_OUTPUT_INVALID',
            failedRules: ['CRITIC_SCHEMA_INVALID'],
          });
        }
        return { findings: [] };
      },
    },
  });

  assert.equal(requests.length, 2);
  // Second call has retryFeedback
  const retryInput = JSON.parse(requests[1].user);
  assert.deepEqual(retryInput.retryFeedback.failedRules, ['CRITIC_SCHEMA_INVALID']);
  assert.equal(result.status, 'succeeded');
});
