const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadAdapter() {
  const url = pathToFileURL(path.join(
    __dirname,
    '..',
    '..',
    'frontend',
    'decomposition-adapter.mjs',
  ));
  return import(url.href);
}

test('multi-agent decomposition is accepted and converted to coaching evidence', async () => {
  const { validateDecompositionResponse, evidenceForCoaching } = await loadAdapter();
  const result = {
    tasks: [{ id: 'task-1', name: '提交排期表' }],
    decomposition: {
      pipelineVersion: 'multi-agent-v2-phase3',
      decompositionId: '11111111-1111-4111-8111-111111111111',
      businessDate: '2026-08-04',
      stages: [{
        name: 'evidence-agents',
        output: {
          昨天: [],
          今天: [{
            id: 'atom-1',
            dimension: '今天',
            sourceLineIndex: 0,
            quote: '由王芳负责今天18:00前提交排期表',
            kind: 'work',
            action: '提交排期表',
            actor: { role: 'explicit', name: '王芳' },
            dueRef: '今天18:00前',
            status: 'in_progress',
          }],
          明天: [],
          后天: [],
        },
      }],
    },
  };

  assert.doesNotThrow(() => validateDecompositionResponse(result));
  assert.deepEqual(evidenceForCoaching(result.decomposition), [{
    id: 'E1',
    dimension: '今天',
    sourceLineIndex: 0,
    quote: '由王芳负责今天18:00前提交排期表',
    observation: '提交排期表',
    kind: 'work',
    status: 'planned',
    owner: '王芳',
    due: '今天18:00前',
  }]);
});

test('multi-agent governance and degradation states produce a visible review notice', async () => {
  const { decompositionReviewNotice } = await loadAdapter();
  const needsConfirmation = {
    pipelineVersion: 'multi-agent-v2-phase3',
    stages: [{
      name: 'critic',
      status: 'succeeded',
      output: { governanceStatus: 'needs_confirmation' },
    }],
  };
  assert.deepEqual(decompositionReviewNotice(needsConfirmation), {
    level: 'warning',
    code: 'TASKS_NEED_CONFIRMATION',
    message: 'AI 审查发现部分任务的责任人、期限或证据需要人工确认；相关不确定字段已回退为待确认。',
  });

  const reconciliationFallback = {
    pipelineVersion: 'multi-agent-v2-phase3',
    stages: [{
      name: 'reconciliation',
      status: 'degraded',
      fallbackMode: 'one-to-one',
    }],
  };
  assert.equal(
    decompositionReviewNotice(reconciliationFallback).code,
    'RECONCILIATION_FALLBACK',
  );
});

test('legacy task-first decomposition remains accepted', async () => {
  const { validateDecompositionResponse, evidenceForCoaching } = await loadAdapter();
  const evidence = [{
    id: 'E1',
    dimension: '今天',
    sourceLineIndex: 0,
    quote: '提交排期表',
    observation: '提交排期表',
    kind: 'work',
    status: 'planned',
    owner: '待确认',
    due: '待确认',
  }];
  const result = {
    tasks: [{ id: 'task-1', name: '提交排期表' }],
    decomposition: {
      pipelineVersion: 'task-first-v2',
      decompositionId: '11111111-1111-4111-8111-111111111111',
      businessDate: '2026-08-04',
      stages: [{
        name: 'evidence-task-generation',
        output: { evidence },
      }],
    },
  };

  assert.doesNotThrow(() => validateDecompositionResponse(result));
  assert.deepEqual(evidenceForCoaching(result.decomposition), evidence);
});

test('decomposition without supported evidence stage is rejected', async () => {
  const { validateDecompositionResponse } = await loadAdapter();
  assert.throws(
    () => validateDecompositionResponse({
      tasks: [],
      decomposition: {
        pipelineVersion: 'multi-agent-v2-phase3',
        decompositionId: '11111111-1111-4111-8111-111111111111',
        businessDate: '2026-08-04',
        stages: [],
      },
    }),
    error => error.code === 'DECOMPOSITION_RESPONSE_INVALID',
  );
});
