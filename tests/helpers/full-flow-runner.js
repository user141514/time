const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { AuthClient } = require('./auth-client');
const { createAuthTestApp } = require('./test-app');

const FULL_FLOW_ENTRIES = Object.freeze({
  昨天: '',
  今天: '张三今天17:00前提交接口联调结果，预计耗时1小时。',
  明天: '',
  后天: '',
});

async function responseJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { rawBody: text };
  }
}

async function expectJson(responsePromise, expectedStatus, label) {
  const response = await responsePromise;
  const payload = await responseJson(response);
  assert.equal(
    response.status,
    expectedStatus,
    `${label} returned ${response.status}: ${JSON.stringify(payload)}`,
  );
  return payload;
}

function post(client, path, body) {
  return client.request(path, {
    method: 'POST',
    csrfToken: client.sessionCsrfToken,
    body,
  });
}

function assertTaskCollection(tasks) {
  assert.ok(Array.isArray(tasks));
  assert.ok(tasks.length >= 1 && tasks.length <= 12);
  const ids = new Set();
  for (const task of tasks) {
    assert.match(task.id, /^[0-9a-f-]{36}$/i);
    assert.ok(task.name.trim());
    // Phase 3: est may be empty (filled by SMART later); due may be '待确认'
    assert.ok(typeof task.est === 'string');
    assert.ok(task.owner.trim());
    assert.ok(task.due.trim());
    assert.equal(task.status, 'pending');
    assert.ok(!ids.has(task.id));
    ids.add(task.id);
  }
}

async function runFullFlow(t, {
  modelClient,
  now,
  appConfig,
  logger,
  entries = FULL_FLOW_ENTRIES,
  usernamePrefix = 'ff',
} = {}) {
  const { baseUrl } = await createAuthTestApp(t, {
    modelClient,
    ...(now ? { now } : {}),
    ...(appConfig ? { config: appConfig } : {}),
    ...(logger ? { logger } : {}),
  });
  const client = new AuthClient(baseUrl);
  const username = `${usernamePrefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 7)}`;
  const password = 'FullFlow-2026';

  const health = await expectJson(fetch(`${baseUrl}/api/health`), 200, 'health');
  assert.deepEqual(health, { status: 'ok' });
  await expectJson(client.register(username, password), 201, 'register');
  await expectJson(client.login(username, password), 200, 'login');
  const identity = await expectJson(client.me(), 200, 'me');
  assert.equal(identity.user.username, username);
  assert.ok(client.sessionCsrfToken);

  const intake = await expectJson(
    post(client, '/api/time-management/intake/check', { entries }),
    200,
    'intake',
  );
  assert.equal(intake.totalLines, 1);
  assert.deepEqual(intake.lineCounts, { 昨天: 0, 今天: 1, 明天: 0, 后天: 0 });

  const decomposed = await expectJson(
    post(client, '/api/time-management/tasks/decompose', { entries }),
    200,
    'decompose',
  );
  assertTaskCollection(decomposed.tasks);
  assert.equal(decomposed.decomposition.pipelineVersion, 'multi-agent-v2-phase3');
  assert.equal(decomposed.decomposition.stages[0].name, 'evidence-agents');
  assert.ok(decomposed.decomposition.taskAtoms.length >= decomposed.tasks.length);

  // Convert Phase 3 atoms to old evidence format for coaching (coaching not yet migrated)
  const byDim = decomposed.decomposition.stages[0].output;
  const allAtoms = [...(byDim['昨天']||[]), ...(byDim['今天']||[]), ...(byDim['明天']||[]), ...(byDim['后天']||[])];
  const evidence = allAtoms.map((a, i) => ({
    id: 'E' + (i + 1),
    dimension: a.dimension,
    sourceLineIndex: a.sourceLineIndex,
    quote: (a.quote || '').slice(0, 120),
    observation: (a.action || a.quote || '').slice(0, 120),
    kind: a.kind === 'note' || a.kind === 'ambiguous' ? 'context' : a.kind,
    status: a.status === 'in_progress' || a.status === 'unknown' ? 'planned' : a.status,
    owner: a.actor?.name || '待确认',
    due: a.dueRef || '待确认',
  }));
  const coaching = await expectJson(
    post(client, '/api/time-management/tasks/coaching-analysis', {
      decompositionId: decomposed.decomposition.decompositionId,
      attemptId: randomUUID(),
      businessDate: decomposed.decomposition.businessDate,
      entries,
      evidence,
    }),
    200,
    'coaching',
  );
  assert.equal(coaching.decompositionId, decomposed.decomposition.decompositionId);
  assert.equal(coaching.stage.name, 'coaching-analysis');

  const smart = await expectJson(
    post(client, '/api/time-management/tasks/smart-check', { tasks: decomposed.tasks }),
    200,
    'smart-check',
  );
  assert.equal(smart.results.length, decomposed.tasks.length);

  const distribution = await expectJson(
    post(client, '/api/time-management/distribution/diagnose', { tasks: decomposed.tasks }),
    200,
    'distribution',
  );
  assert.equal(distribution.categories.length, 4);

  const matrix = await expectJson(
    post(client, '/api/time-management/matrix/classify', { tasks: decomposed.tasks }),
    200,
    'matrix',
  );
  assert.equal(matrix.classifications.length, decomposed.tasks.length);
  assert.equal(matrix.quadrants.length, 4);
  assert.deepEqual(
    matrix.quadrants.flatMap(item => item.taskIds).sort(),
    decomposed.tasks.map(task => task.id).sort(),
  );
  const classifications = new Map(
    matrix.classifications.map(item => [item.taskId, item]),
  );
  const classifiedTasks = decomposed.tasks.map(task => ({
    ...task,
    importance: classifications.get(task.id).importance,
    urgency: classifications.get(task.id).urgency,
    classificationSource: classifications.get(task.id).classificationSource,
  }));
  const report = await expectJson(
    post(client, '/api/time-management/report/generate', {
      tasks: classifiedTasks,
      distribution,
      matrix,
      goals: entries,
    }),
    200,
    'report',
  );
  assert.ok(report.energyRules.length >= 1);
  assert.ok(report.adjustments.length >= 1);
  assert.ok(report.order.every(item => classifiedTasks.some(task => task.id === item.taskId)));

  const decomposition = {
    ...decomposed.decomposition,
    stages: [...decomposed.decomposition.stages, coaching.stage],
  };
  const snapshot = {
    clientRunId: randomUUID(),
    title: `${decomposed.decomposition.businessDate} 全流程测试`,
    goals: entries,
    decomposition,
    tasks: classifiedTasks,
    distribution,
    matrix,
    report,
  };
  const history = await expectJson(
    client.request('/api/time-management/history', {
      method: 'POST',
      csrfToken: client.sessionCsrfToken,
      body: snapshot,
    }),
    201,
    'history-save',
  );
  assert.match(history.id, /^[0-9a-f-]{36}$/i);

  const historyPage = await expectJson(
    client.request('/api/time-management/history'),
    200,
    'history-list',
  );
  assert.ok(historyPage.items.some(item => item.id === history.id));
  const historyDetail = await expectJson(
    client.request(`/api/time-management/history/${history.id}`),
    200,
    'history-detail',
  );
  assert.equal(historyDetail.decomposition.decompositionId, decomposition.decompositionId);
  assert.equal(historyDetail.tasks.length, classifiedTasks.length);

  const daily = await expectJson(
    client.request('/api/time-management/daily-tracking/today'),
    200,
    'daily-tracking',
  );
  assert.equal(daily.sourceSummary.historyCount, 1);
  assert.equal(daily.sourceSummary.taskCount, decomposed.tasks.length);
  assert.deepEqual(
    daily.tasks.map(task => task.id).sort(),
    decomposed.tasks.map(task => task.id).sort(),
  );

  await expectJson(client.logout(), 204, 'logout');
  const afterLogout = await client.me();
  assert.equal(afterLogout.status, 401);

  return {
    baseUrl,
    entries,
    decomposed,
    coaching,
    smart,
    distribution,
    matrix,
    report,
    history,
    daily,
  };
}

module.exports = {
  FULL_FLOW_ENTRIES,
  runFullFlow,
};
