const assert = require('node:assert/strict');
const test = require('node:test');

const { AuthClient } = require('../helpers/auth-client');
const { createAuthTestApp } = require('../helpers/test-app');

const USERNAME = 'Workflow_Manager';
const PASSWORD = 'Workflow-Horse-2026';
const WORKFLOW_PATHS = [
  '/api/time-management/goals/check',
  '/api/time-management/tasks/extract',
  '/api/time-management/matrix/classify',
  '/api/time-management/report/generate',
  '/api/time-management/tasks/decompose',
  '/api/time-management/tasks/coaching-analysis',
];
const GOALS = Object.freeze({
  昨天: '原计划完成复盘，实际已完成，差距为零，下一步记录经验',
  今天: '今天18:00前提交一份方案',
  明天: '本周五前完成一份验收清单',
  后天: '年底前完成年度目标并按月复盘',
});

async function login(client) {
  assert.equal((await client.register(USERNAME, PASSWORD)).status, 201);
  assert.equal((await client.login(USERNAME, PASSWORD)).status, 200);
  assert.equal((await client.me()).status, 200);
}

test('health stays public while every time-management API rejects anonymous requests first', async (t) => {
  let modelCalls = 0;
  const { baseUrl } = await createAuthTestApp(t, {
    modelClient: { completeJson: async () => { modelCalls += 1; return {}; } },
  });

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const client = new AuthClient(baseUrl);
  for (const path of WORKFLOW_PATHS) {
    const response = await client.request(path, { method: 'POST', body: {} });
    const payload = await response.json();
    assert.equal(response.status, 401, path);
    assert.equal(payload.error.code, 'AUTH_REQUIRED', path);
  }
  assert.equal(modelCalls, 0);
});

test('every time-management mutation rejects missing and incorrect session CSRF before model work', async (t) => {
  let modelCalls = 0;
  const { baseUrl } = await createAuthTestApp(t, {
    modelClient: { completeJson: async () => { modelCalls += 1; return {}; } },
  });
  const client = new AuthClient(baseUrl);
  await login(client);

  for (const path of WORKFLOW_PATHS) {
    const missing = await client.request(path, {
      method: 'POST',
      csrfToken: '',
      body: {},
    });
    assert.equal(missing.status, 403, `${path} missing token`);
    assert.equal((await missing.json()).error.code, 'AUTH_CSRF_INVALID');

    const incorrect = await client.request(path, {
      method: 'POST',
      csrfToken: 'incorrect-session-csrf-token',
      body: {},
    });
    assert.equal(incorrect.status, 403, `${path} incorrect token`);
    assert.equal((await incorrect.json()).error.code, 'AUTH_CSRF_INVALID');
  }

  assert.equal(modelCalls, 0);
});

test('time-management mutations reject a cross-origin request before model work', async (t) => {
  let modelCalls = 0;
  const { baseUrl } = await createAuthTestApp(t, {
    modelClient: { completeJson: async () => { modelCalls += 1; return {}; } },
  });
  const client = new AuthClient(baseUrl);
  await login(client);

  const wrongOrigin = await fetch(`${baseUrl}${WORKFLOW_PATHS[0]}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: client.cookie,
      origin: 'http://attacker.invalid',
      'x-csrf-token': client.sessionCsrfToken,
    },
    body: '{}',
  });
  assert.equal(wrongOrigin.status, 403);
  assert.equal((await wrongOrigin.json()).error.code, 'AUTH_CSRF_INVALID');
  assert.equal(modelCalls, 0);
});

test('a valid session, same-origin request, and CSRF preserve all four workflow contracts', async (t) => {
  let callIndex = 0;
  const expectedReview = {
    fields: Object.keys(GOALS).map((key) => ({
      key,
      status: 'ok',
      issue: '',
      suggestion: '',
    })),
    overall: 'pass',
  };
  let expectedReport;
  const modelClient = {
    async completeJson(input) {
      callIndex += 1;
      if (callIndex === 1) return expectedReview;
      if (callIndex === 2) {
        return {
          tasks: [{
            name: '提交方案',
            importance: '高',
            urgency: '高',
            source: '今天',
            due: '2026-07-27',
            est: '约1h',
            owner: '待确认',
            acceptanceCriteria: [],
            nextAction: '',
            status: 'pending',
          }],
        };
      }
      const requestBody = JSON.parse(input.user);
      if (callIndex === 3) {
        return {
          classifications: requestBody.tasks.map((task) => ({
            taskId: task.id,
            importance: task.importance,
            urgency: task.urgency,
          })),
          note: '',
        };
      }
      // 建议文字必须可归因到任务名，服务端会回写 basis
      const taskId = requestBody.tasks[0].id;
      expectedReport = {
        order: requestBody.tasks.map(task => ({
          taskId: task.id,
          reason: '该任务重要且紧急',
          basis: { type: 'task', taskId: task.id },
        })),
        energyRules: [{ text: '优先完成提交方案', basis: { type: 'task', taskId } }],
        adjustments: [{ text: '每周固定复盘提交方案的进展', basis: { type: 'task', taskId } }],
      };
      return {
        order: requestBody.tasks.map(task => ({
          taskId: task.id,
          reason: '该任务重要且紧急',
        })),
        energyRules: ['优先完成提交方案'],
        adjustments: ['每周固定复盘提交方案的进展'],
      };
    },
  };
  const { baseUrl } = await createAuthTestApp(t, { modelClient });
  const client = new AuthClient(baseUrl);
  await login(client);

  const reviewResponse = await client.request(WORKFLOW_PATHS[0], {
    method: 'POST',
    csrfToken: client.sessionCsrfToken,
    body: { goals: GOALS },
  });
  assert.equal(reviewResponse.status, 200);
  assert.deepEqual(await reviewResponse.json(), expectedReview);

  const extractResponse = await client.request(WORKFLOW_PATHS[1], {
    method: 'POST',
    csrfToken: client.sessionCsrfToken,
    body: { goals: GOALS },
  });
  assert.equal(extractResponse.status, 200);
  const extracted = await extractResponse.json();
  assert.deepEqual(
    Object.keys(extracted).sort(),
    ['tasks'].sort(),
  );
  assert.equal(extracted.tasks.length, 1);
  assert.equal(extracted.tasks[0].name, '提交方案');
  assert.equal(extracted.tasks[0].classificationSource, 'ai-extraction');

  const matrixResponse = await client.request(WORKFLOW_PATHS[2], {
    method: 'POST',
    csrfToken: client.sessionCsrfToken,
    body: { tasks: extracted.tasks },
  });
  assert.equal(matrixResponse.status, 200);
  const matrix = await matrixResponse.json();
  assert.deepEqual(
    Object.keys(matrix).sort(),
    ['classifications', 'note', 'quadrants'].sort(),
  );
  assert.deepEqual(matrix.quadrants[0].taskIds, [extracted.tasks[0].id]);

  const reportResponse = await client.request(WORKFLOW_PATHS[3], {
    method: 'POST',
    csrfToken: client.sessionCsrfToken,
    body: { tasks: extracted.tasks, matrix, goals: GOALS },
  });
  assert.equal(reportResponse.status, 200);
  assert.deepEqual(await reportResponse.json(), expectedReport);
  assert.equal(callIndex, 4);
});
