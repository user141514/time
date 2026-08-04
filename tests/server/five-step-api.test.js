const test = require('node:test');
const assert = require('node:assert/strict');

const { AuthClient } = require('../helpers/auth-client');
const { createAuthTestApp } = require('../helpers/test-app');
const { shanghaiBusinessDay } = require('../../server/daily-tracking/business-date');

async function authenticatedClient(t, modelClient) {
  const { baseUrl } = await createAuthTestApp(t, { modelClient });
  const client = new AuthClient(baseUrl);
  const username = `五步用户_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const password = '123456';
  assert.equal((await client.register(username, password)).status, 201);
  assert.equal((await client.login(username, password)).status, 200);
  assert.equal((await client.me()).status, 200);
  return client;
}

const entries = {
  昨天: '',
  今天: '完成时间管理新版接口联调',
  明天: '',
  后天: '',
};

function claim(text, evidenceIds = []) {
  return { text, evidenceIds };
}

function coachOutput() {
  const supported = claim('当前需要完成时间管理新版接口联调。', ['E1']);
  const unknown = claim('证据不足：当前输入未提供该维度信息。');
  return {
    evidence: [{
      id: 'E1',
      dimension: '今天',
      sourceLineIndex: 0,
      quote: entries.今天,
      observation: '完成时间管理新版接口联调',
      kind: 'work',
      status: 'planned',
      owner: '待确认',
      due: '待确认',
    }],
    coachingAnalysis: {
      yesterday_analysis: {
        key_problem: unknown,
        gap: unknown,
        root_cause: unknown,
        management_insight: unknown,
      },
      today_focus: {
        key_work: supported,
        priority_reason: supported,
        manager_action: supported,
        possible_delegation: unknown,
      },
      tomorrow_optimization: {
        management_improvement: unknown,
        system_building: unknown,
        capability_upgrade: unknown,
      },
      future_direction: {
        long_term_goal: unknown,
        organization_capability: unknown,
        future_focus: unknown,
      },
      connection_analysis: {
        problem_to_action: unknown,
        action_to_optimization: unknown,
        optimization_to_future: unknown,
      },
      coaching_suggestions: [],
      overall_insight: supported,
    },
  };
}

function directTasks(taskOverridesArray) {
  return {
    tasks: taskOverridesArray.map((overrides) => ({
      name: '完成时间管理新版接口联调',
      importance: '高',
      urgency: '高',
      source: '今天',
      due: '待确认',
      est: '1h',
      owner: '待确认',
      acceptanceCriteria: [],
      nextAction: '',
      status: 'pending',
      evidenceIds: ['E1'],
      ...overrides,
    })),
  };
}

function taskFirstOutput(taskOverridesArray, evidenceOverrides = {}) {
  return {
    evidence: [{ ...coachOutput().evidence[0], ...evidenceOverrides }],
    ...directTasks(taskOverridesArray),
  };
}

test('新版五步接口要求登录和会话 CSRF', async (t) => {
  const { baseUrl } = await createAuthTestApp(t);
  const response = await fetch(`${baseUrl}/api/time-management/intake/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ entries }),
  });
  assert.equal(response.status, 401);
});

test('四栏校验、任务拆解、SMART 和时间分布通过正式 API 串联', async (t) => {
  let modelCalls = 0;
  const client = await authenticatedClient(t, {
    completeJson: async (req) => {
      modelCalls += 1;
      const input = JSON.parse(req.user);
      return {
        dimension: input.dimension,
        atoms: input.dimension === '今天' ? [{
          id: 'atom-1', dimension: '今天', sourceLineIndex: 0,
          quote: entries.今天,
          kind: 'work', action: '完成时间管理新版接口联调',
          actor: { role: 'unknown', name: '' }, dueRef: '',
          status: 'planned', relatedTo: '', confidence: { actor: 0, due: 0, status: 1 },
        }] : [],
      };
    },
  });
  const request = (path, body) => client.request(path, {
    method: 'POST',
    csrfToken: client.sessionCsrfToken,
    body,
  });

  const intakeResponse = await request('/api/time-management/intake/check', { entries });
  assert.equal(intakeResponse.status, 200);
  const intake = await intakeResponse.json();
  assert.equal(intake.totalLines, 1);
  assert.deepEqual(intake.lineCounts, { 昨天: 0, 今天: 1, 明天: 0, 后天: 0 });

  const decomposeResponse = await request('/api/time-management/tasks/decompose', { entries });
  assert.equal(decomposeResponse.status, 200);
  const decomposed = await decomposeResponse.json();
  assert.ok(modelCalls >= 1, `expected >=1 calls, got ${modelCalls}`);
  assert.equal(decomposed.tasks.length, 1);
  assert.equal(decomposed.tasks[0].name, '完成时间管理新版接口联调');
  assert.deepEqual(
    Object.keys(decomposed).sort(),
    ['decomposition', 'intake', 'smart', 'tasks'],
  );
  assert.equal(decomposed.decomposition.pipelineVersion, 'multi-agent-v2-phase3');
  assert.ok(decomposed.decomposition.stages.length >= 1);  // Phase 2: evidence + reconciliation stages
  assert.equal(decomposed.decomposition.taskAtoms[0].taskId, decomposed.tasks[0].id);
  // Phase 1 任务不含 est/importance（后续步骤补充），SMART 预期 need_fix
  assert.equal(decomposed.smart.overall, 'need_fix');

  const smartResponse = await request('/api/time-management/tasks/smart-check', {
    tasks: decomposed.tasks,
  });
  assert.equal(smartResponse.status, 200);
  assert.equal((await smartResponse.json()).overall, 'need_fix');

  const distributionResponse = await request('/api/time-management/distribution/diagnose', {
    tasks: decomposed.tasks,
  });
  // Phase 1: est 为空，分布诊断无法计算工时
  assert.equal(distributionResponse.status, 422);
  assert.equal((await distributionResponse.json()).error.code, 'DISTRIBUTION_UNAVAILABLE');
});

test('任务返回后可独立请求 coaching analysis', async (t) => {
  const client = await authenticatedClient(t, {
    completeJson: async (req) => {
      const input = typeof req.user === 'string' ? JSON.parse(req.user) : req.user;
      // Evidence agent calls
      if (input.dimension !== undefined) {
        return {
          dimension: input.dimension,
          atoms: input.dimension === '今天' ? [{
            id: 'atom-1', dimension: '今天', sourceLineIndex: 0,
            quote: entries.今天,
            kind: 'work', action: '完成时间管理新版接口联调',
            actor: { role: 'unknown', name: '' }, dueRef: '',
            status: 'planned', relatedTo: '', confidence: { actor: 0, due: 0, status: 1 },
          }] : [],
        };
      }
      // Coaching call
      return { coachingAnalysis: coachOutput().coachingAnalysis };
    },
  });
  const decomposeResponse = await client.request(
    '/api/time-management/tasks/decompose',
    {
      method: 'POST',
      csrfToken: client.sessionCsrfToken,
      body: { entries },
    },
  );
  const decomposed = await decomposeResponse.json();
  // coaching uses old evidence format — convert atoms to evidence shape
  const atoms = decomposed.decomposition.stages[0].output.今天 || [];
  const evidence = atoms.map((a, i) => ({
    id: `E${i + 1}`, dimension: a.dimension, sourceLineIndex: a.sourceLineIndex,
    quote: (a.quote || '').slice(0, 120), observation: (a.action || a.quote || '').slice(0, 120),
    kind: a.kind === 'note' || a.kind === 'ambiguous' ? 'context' : a.kind,
    status: a.status === 'in_progress' || a.status === 'unknown' ? 'planned' : a.status,
    owner: a.actor.name || '待确认', due: a.dueRef || '待确认',
  }));
  const coachingResponse = await client.request(
    '/api/time-management/tasks/coaching-analysis',
    {
      method: 'POST',
      csrfToken: client.sessionCsrfToken,
      body: {
        decompositionId: decomposed.decomposition.decompositionId,
        attemptId: '22222222-2222-4222-8222-222222222222',
        businessDate: decomposed.decomposition.businessDate,
        entries,
        evidence,
      },
    },
  );

  assert.equal(coachingResponse.status, 200);
  const coaching = await coachingResponse.json();
  assert.equal(coaching.decompositionId, decomposed.decomposition.decompositionId);
  assert.equal(coaching.stage.name, 'coaching-analysis');
  assert.equal(coaching.stage.analysisId, coaching.analysisId);
});

test('零任务返回 422 NO_ACTIONABLE_TASKS', async (t) => {
  const client = await authenticatedClient(t, {
    completeJson: async (req) => {
      const input = JSON.parse(req.user);
      // 每行都要有 atom 覆盖，但全都标记为 note（不产生任务）
      return {
        dimension: input.dimension,
        atoms: input.dimension === '今天' ? [{
          id: 'atom-1', dimension: '今天', sourceLineIndex: 0,
          quote: entries.今天,
          kind: 'note', action: '', actor: { role: 'unknown', name: '' },
          dueRef: '', status: 'planned', relatedTo: '',
          confidence: { actor: 0, due: 0, status: 0 },
        }] : [],
      };
    },
  });
  const response = await client.request('/api/time-management/tasks/decompose', {
    method: 'POST',
    csrfToken: client.sessionCsrfToken,
    body: { entries },
  });

  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'NO_ACTIONABLE_TASKS');
});

test('四栏多行输入：totalLines 按实际行数计算并全流程串联（公网验收场景）', async (t) => {
  const multiEntries = {
    昨天: '客户投诉复盘尚未完成，需要补充原因和改进措施，预计1小时。',
    今天: '由王芳负责今天18:00前提交新版排期表，预计1小时。\n研发组负责今天完成支付回调日志采集，预计2小时。',
    明天: '由李明负责明天下午完成接口回归方案，预计1.5小时。',
    后天: '本月底形成支付系统稳定性改进路线图，预计4小时。',
  };
  const atomsByDimension = {
    昨天: [{ id: 'E1', dimension: '昨天', sourceLineIndex: 0, quote: multiEntries.昨天, kind: 'work', action: '客户投诉复盘', actor: { role: 'unknown', name: '' }, dueRef: '', status: 'unfinished', relatedTo: '', confidence: { actor: 0, due: 0, status: 1 } }],
    今天: [
      { id: 'E2', dimension: '今天', sourceLineIndex: 0, quote: '由王芳负责今天18:00前提交新版排期表，预计1小时。', kind: 'work', action: '提交新版排期表', actor: { role: 'explicit', name: '王芳' }, dueRef: '今天18:00前', status: 'planned', relatedTo: '', confidence: { actor: 1, due: 1, status: 1 } },
      { id: 'E3', dimension: '今天', sourceLineIndex: 1, quote: '研发组负责今天完成支付回调日志采集，预计2小时。', kind: 'work', action: '支付回调日志采集', actor: { role: 'explicit', name: '研发组' }, dueRef: '', status: 'planned', relatedTo: '', confidence: { actor: 1, due: 0, status: 1 } },
    ],
    明天: [{ id: 'E4', dimension: '明天', sourceLineIndex: 0, quote: '由李明负责明天下午完成接口回归方案，预计1.5小时。', kind: 'work', action: '接口回归方案', actor: { role: 'explicit', name: '李明' }, dueRef: '明天下午', status: 'planned', relatedTo: '', confidence: { actor: 1, due: 1, status: 1 } }],
    后天: [{ id: 'E5', dimension: '后天', sourceLineIndex: 0, quote: multiEntries.后天, kind: 'work', action: '稳定性改进路线图', actor: { role: 'unknown', name: '' }, dueRef: '本月底', status: 'planned', relatedTo: '', confidence: { actor: 0, due: 1, status: 1 } }],
  };
  let modelCalls = 0;
  const client = await authenticatedClient(t, {
    completeJson: async (req) => {
      modelCalls += 1;
      const input = JSON.parse(req.user);
      return { dimension: input.dimension, atoms: atomsByDimension[input.dimension] || [] };
    },
  });
  const request = (path, body) => client.request(path, {
    method: 'POST',
    csrfToken: client.sessionCsrfToken,
    body,
  });

  const intakeResponse = await request('/api/time-management/intake/check', { entries: multiEntries });
  assert.equal(intakeResponse.status, 200);
  const intake = await intakeResponse.json();
  assert.equal(intake.totalLines, 5);
  assert.deepEqual(intake.lineCounts, { 昨天: 1, 今天: 2, 明天: 1, 后天: 1 });

  const decomposeResponse = await request('/api/time-management/tasks/decompose', { entries: multiEntries });
  assert.equal(decomposeResponse.status, 200);
  const decomposed = await decomposeResponse.json();
  assert.equal(decomposed.tasks.length, 5);
  // 服务端确定性：今天18:00前 → 当天业务日期；本月底 → 当月最后一天（均按上海时区）
  const today = shanghaiBusinessDay().trackingDate;
  const schedule = decomposed.tasks.find(task => task.name === '提交新版排期表');
  assert.equal(schedule.due, today);
  assert.equal(schedule.owner, '王芳');
  assert.equal(decomposed.tasks.find(task => task.name === '支付回调日志采集').owner, '研发组');
  assert.equal(decomposed.tasks.find(task => task.name === '接口回归方案').owner, '李明');
  const monthEnd = new Date(Date.UTC(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)),
    0,
  )).toISOString().slice(0, 10);
  assert.equal(decomposed.tasks.find(task => task.name === '稳定性改进路线图').due, monthEnd);

  const smartResponse = await request('/api/time-management/tasks/smart-check', { tasks: decomposed.tasks });
  assert.equal(smartResponse.status, 200);

  const distributionResponse = await request('/api/time-management/distribution/diagnose', { tasks: decomposed.tasks });
  // Phase 1: est 为空，分布诊断无法计算工时
  assert.equal(distributionResponse.status, 422);
});
