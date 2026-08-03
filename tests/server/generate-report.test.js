const test = require('node:test');
const assert = require('node:assert/strict');

const { generateReport } = require('../../server/workflows/generate-report');
const {
  buildReportScheduleContext,
  hasScheduleConflict,
} = require('../../server/policies/report-schedule');
const { createTestAuthBoundary } = require('../helpers/test-auth-boundary');

function task(id, overrides = {}) {
  // 名称不包含 id，避免与 REPORT_TASK_ID_LEAK 冲突（生产 id 为 UUID，不会出现在名称中）
  return { id, name: '测试任务', source: '今天', due: '待确认', owner: '待确认', ...overrides };
}

function matrixFor(tasks) {
  return { quadrants: [{ q: '第一象限', taskIds: tasks.map(item => item.id) }] };
}

function textOf(item) {
  return typeof item === 'string' ? item : String(item?.text || '');
}

// 模型输出夹具：文字必须可归因（引用任务名/非空维度/分布事实），否则会被证据门禁拒绝
function reportFor(tasks, overrides = {}) {
  const name = tasks[0]?.name || '任务';
  return {
    order: tasks.slice(0, 5).map(item => ({
      taskId: item.id,
      reason: '该任务重要且紧急',
    })),
    energyRules: [`优先完成${name}`],
    adjustments: [`每周复盘${name}的进展`],
    ...overrides,
  };
}

// 与 reportFor 对应的期望响应（依据只在服务端内部计算，不进入响应）
function expectedReport(tasks, overrides = {}) {
  const name = tasks[0]?.name || '任务';
  return {
    order: tasks.slice(0, 5).map(item => ({
      taskId: item.id,
      reason: '该任务重要且紧急',
    })),
    energyRules: [`优先完成${name}`],
    adjustments: [`每周复盘${name}的进展`],
    ...overrides,
  };
}

function queuedModel(outputs) {
  const calls = [];
  return {
    calls,
    completeJson: async input => {
      calls.push(input);
      return outputs[Math.min(calls.length - 1, outputs.length - 1)];
    },
  };
}

function rejectingModel(diagnosticCode) {
  const calls = [];
  return {
    calls,
    async completeJson(input) {
      calls.push(input);
      throw Object.assign(new Error('model output is invalid'), {
        code: 'MODEL_OUTPUT_INVALID',
        diagnosticCode,
      });
    },
  };
}

async function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

test('报告只引用当前任务并保留三段结构', async () => {
  const tasks = [task('task-a', { name: '提交复盘', source: '复盘' })];
  const matrix = matrixFor(tasks);
  const expected = expectedReport(tasks);
  const modelClient = queuedModel([reportFor(tasks)]);
  const goals = { 昨天: '复盘不足', 后天: '' };

  const result = await generateReport({ tasks, matrix, goals, modelClient });
  assert.deepEqual(result, expected);
  assert.equal(modelClient.calls.length, 1);
  assert.equal(modelClient.calls[0].maxAttempts, 1);
  assert.match(modelClient.calls[0].system, /时间管理报告生成模块/);
  assert.deepEqual(JSON.parse(modelClient.calls[0].user), {
    tasks,
    matrix,
    goals,
    priorityContext: {
      recommendedTaskIds: ['task-a'],
      protectedTaskIds: [],
      remainingProtectedTaskIds: [],
      actionByTaskId: { 'task-a': '立即处理' },
    },
    scheduleContext: {
      fixedPoints: [],
      protectedWindows: [],
    },
  });
});

test('五步报告接收时间分布诊断并原样传入模型上下文', async () => {
  const tasks = [task('task-a', { name: '提交复盘', source: '复盘' })];
  const matrix = matrixFor(tasks);
  const modelClient = queuedModel([reportFor(tasks, { adjustments: ['先清理遗留事项。'] })]);
  const goals = { 昨天: '存在遗留事项', 后天: '' };
  const distribution = {
    totalMinutes: 60,
    totalHours: 1,
    validTaskCount: 1,
    invalidTasks: [],
    percentages: { 昨天: 100, 今天: 0, 明天: 0, 后天: 0 },
    categories: [
      { key: '昨天', percent: 100, status: 'over' },
      { key: '今天', percent: 0, status: 'under' },
      { key: '明天', percent: 0, status: 'under' },
      { key: '后天', percent: 0, status: 'under' },
    ],
    diagnosis: ['“昨天”投入偏高。'],
    recommendations: ['先清理遗留事项。'],
  };

  const result = await generateReport({
    tasks,
    matrix,
    goals,
    distribution,
    modelClient,
  });

  assert.deepEqual(result, {
    ...expectedReport(tasks, {
      adjustments: ['先清理遗留事项。'],
    }),
  });
  const modelInput = JSON.parse(modelClient.calls[0].user);
  assert.deepEqual(modelInput.distribution, distribution);
  assert.match(modelClient.calls[0].system, /时间分布诊断/);
});

test('任务不少于 3 条时 order 长度必须为 3–5', async () => {
  const tasks = Array.from({ length: 6 }, (_, index) => task(`task-${index}`));
  const invalid = reportFor(tasks, { order: reportFor(tasks).order.slice(0, 2) });
  const valid = reportFor(tasks);
  const modelClient = queuedModel([invalid, valid]);

  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
  });
  assert.equal(result.order.length, 5);
  assert.equal(modelClient.calls.length, 2);
});

test('任务不足 3 条时 order 不得超过当前任务数', async () => {
  const tasks = [task('task-a')];
  const invalid = reportFor(tasks, {
    order: [
      { taskId: 'task-a', reason: '先做' },
      { taskId: 'task-b', reason: '再做' },
    ],
  });
  const modelClient = queuedModel([invalid, reportFor(tasks)]);

  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
  });
  assert.equal(result.order.length, 1);
  assert.equal(modelClient.calls.length, 2);
});

test('不存在或已删除的 taskId 触发重试', async () => {
  const tasks = [task('current')];
  const invalid = reportFor(tasks, {
    order: [{ taskId: 'deleted', reason: '旧任务' }],
  });
  const modelClient = queuedModel([invalid, reportFor(tasks)]);

  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
  });
  assert.equal(result.order[0].taskId, 'current');
  assert.equal(modelClient.calls.length, 2);
});

test('中长期目标的建议必须包含指标或时间节点', async () => {
  const tasks = [task('task-a')];
  const invalid = reportFor(tasks, { adjustments: ['继续努力推进长期目标'] });
  const valid = reportFor(tasks, { adjustments: [`12 月 31 日前完成 3 个里程碑，推动${tasks[0].name}`] });
  const modelClient = queuedModel([invalid, valid]);

  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '完成年度能力提升计划' },
    modelClient,
  });
  assert.match(textOf(result.adjustments[0]), /12|3/);
  assert.equal(modelClient.calls.length, 2);
});

test('单任务不能虚构第二个任务，连续失败时降级为基础报告', async () => {
  const tasks = [task('only')];
  const invalid = reportFor(tasks, {
    order: [
      { taskId: 'only', reason: '当前任务' },
      { taskId: 'invented', reason: '虚构任务' },
    ],
  });
  const modelClient = queuedModel([invalid, invalid]);
  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
  });
  assert.equal(modelClient.calls.length, 2);
  assert.equal(result.degraded, true);
  assert.equal(result.degradedReason, 'REPORT_ORDER_REFERENCE_INVALID');
  assert.deepEqual(result.order.map(item => item.taskId), ['only']);
});

test('报告顺序与服务端候选顺序不一致时重试一次', async () => {
  const tasks = [
    task('later', { due: '2026-07-20 17:00' }),
    task('earlier', { due: '2026-07-20 16:00' }),
  ];
  const invalid = reportFor(tasks);
  const valid = reportFor(tasks, {
    order: [
      { taskId: 'earlier', reason: '16:00 截止，先完成' },
      { taskId: 'later', reason: '17:00 截止，随后完成' },
    ],
  });
  const modelClient = queuedModel([invalid, valid]);

  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-07-20T04:00:00.000Z'),
  });

  assert.deepEqual(result.order.map(item => item.taskId), ['earlier', 'later']);
  assert.equal(modelClient.calls.length, 2);
});

test('当天到期任务被建议延后时拒绝并重试', async () => {
  const tasks = [task('due-today', {
    name: '发送项目会议纪要',
    due: '2026-07-20 18:00',
  })];
  const invalid = reportFor(tasks, {
    order: [{ taskId: 'due-today', reason: '建议延后发送项目会议纪要' }],
  });
  const valid = reportFor(tasks, {
    order: [{ taskId: 'due-today', reason: '18:00 前完成发送项目会议纪要' }],
  });
  const modelClient = queuedModel([invalid, valid]);

  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-07-20T04:00:00.000Z'),
  });

  assert.match(textOf(result.order[0].reason), /18:00/);
  assert.equal(modelClient.calls.length, 2);
});

test('无明确期限的第四象限任务仍可建议推迟或取消', async () => {
  const tasks = [task('optional', { name: '整理旧标签', due: '待确认' })];
  const modelClient = queuedModel([reportFor(tasks, {
    order: [{ taskId: 'optional', reason: '可推迟或取消整理旧标签' }],
  })]);
  const result = await generateReport({
    tasks,
    matrix: { quadrants: [{ name: '第四象限', taskIds: ['optional'] }] },
    goals: { 昨天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-07-20T04:00:00.000Z'),
  });
  assert.equal(result.order[0].reason, '可推迟或取消整理旧标签');
});

test('报告入口接受任务验收标准并保持外部响应结构', async () => {
  const tasks = [task('smart', {
    source: '短期目标',
    acceptanceCriteria: ['形成 4 个模块', '完成 2 次模拟', '评分不低于 80 分'],
    nextAction: '先列出模块清单',
  })];
  const modelClient = queuedModel([reportFor(tasks)]);
  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
  });
  assert.deepEqual(result, expectedReport(tasks));
});

test('当前任务 UUID 前缀泄漏时重试并返回纯业务文字', async () => {
  const id = '9a38e8c3-1111-4111-8111-111111111111';
  const tasks = [task(id, { name: '完成客户方案' })];
  const invalid = reportFor(tasks, { energyRules: [`优先处理 ${id.slice(0, 8)}`] });
  const valid = reportFor(tasks, { energyRules: ['优先完成完成客户方案'] });
  const modelClient = queuedModel([invalid, valid]);
  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
  });
  assert.equal(modelClient.calls.length, 2);
  const visibleText = [
    ...result.order.map(item => item.reason),
    ...result.energyRules.map(textOf),
    ...result.adjustments.map(textOf),
  ].join('\n');
  assert.doesNotMatch(visibleText, new RegExp(id.slice(0, 8), 'i'));
});

test('完整 UUID 和九位以上前缀在全部用户可见字段中都会触发重试', async () => {
  const id = '9a38e8c3-1111-4111-8111-111111111111';
  const tasks = [task(id, { name: '完成客户方案' })];
  const clean = reportFor(tasks);
  const leaks = [
    reportFor(tasks, { order: [{ taskId: id, reason: `优先完成 ${id}` }] }),
    reportFor(tasks, { energyRules: [`集中精力处理 ${id.slice(0, 12)}`] }),
    reportFor(tasks, { adjustments: [`复盘 ${id}`] }),
  ];

  for (const leak of leaks) {
    const modelClient = queuedModel([leak, clean]);
    await generateReport({
      tasks,
      matrix: matrixFor(tasks),
      goals: { 昨天: '', 后天: '' },
      modelClient,
    });
    assert.equal(modelClient.calls.length, 2);
  }
});

test('连续两次返回当前任务 ID 泄漏时降级为基础报告且不泄漏 ID', async () => {
  const id = '9a38e8c3-1111-4111-8111-111111111111';
  const tasks = [task(id, { name: '完成客户方案' })];
  const invalid = reportFor(tasks, {
    adjustments: [`检查内部任务 ${id.slice(0, 9)}`],
  });
  const modelClient = queuedModel([invalid, invalid]);
  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
  });
  assert.equal(modelClient.calls.length, 2);
  assert.equal(result.degraded, true);
  const visible = [
    ...result.order.map(item => item.reason),
    ...result.energyRules.map(textOf),
    ...result.adjustments.map(textOf),
  ].join('\n');
  assert.doesNotMatch(visible, new RegExp(id.slice(0, 9), 'i'));
});

test('时间比例日期指标和无关业务编号不会被误判为任务 ID', async () => {
  const id = '9a38e8c3-1111-4111-8111-111111111111';
  const tasks = [task(id, { name: '完成客户方案' })];
  const modelClient = queuedModel([reportFor(tasks, {
    order: [{ taskId: id, reason: '11:00 前先完成完成客户方案' }],
    energyRules: ['投入 55% 精力，优先完成完成客户方案'],
    adjustments: ['2026-07-20 前整理不少于10个案例，围绕完成客户方案'],
  })]);
  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
  });
  assert.equal(modelClient.calls.length, 1);
  assert.match(textOf(result.adjustments[0]), /10个案例/);
});

test('当天第三象限任务缺少授权语义时重试', async () => {
  const tasks = [task('delegate', {
    name: '发送项目会议纪要',
    due: '2026-07-20 18:00',
  })];
  const invalid = reportFor(tasks, {
    order: [{ taskId: 'delegate', reason: '今天尽快处理发送项目会议纪要' }],
  });
  const valid = reportFor(tasks, {
    order: [{ taskId: 'delegate', reason: '立即委派他人发送项目会议纪要' }],
  });
  const modelClient = queuedModel([invalid, valid]);
  const result = await generateReport({
    tasks,
    matrix: { quadrants: [{ name: '第三象限', taskIds: ['delegate'] }] },
    goals: { 昨天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-07-20T04:00:00.000Z'),
  });
  assert.match(result.order[0].reason, /委派/);
  assert.equal(modelClient.calls.length, 2);
});

test('超过五条当天任务时调整建议必须覆盖剩余任务', async () => {
  const tasks = Array.from({ length: 6 }, (_, index) => task(`due-${index + 1}`, {
    name: `当天任务 ${index + 1}`,
    due: `2026-07-20 ${String(13 + index).padStart(2, '0')}:00`,
  }));
  const invalid = reportFor(tasks);
  const valid = reportFor(tasks, {
    adjustments: ['当天任务 6 安排在 18:30 完成'],
  });
  const modelClient = queuedModel([invalid, valid]);
  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-07-20T04:00:00.000Z'),
  });
  assert.match(textOf(result.adjustments[0]), /当天任务 6.*18:30/);
  assert.equal(modelClient.calls.length, 2);
});

test('报告时间建议首次冲突时携带调度上下文并重试成功', async () => {
  const tasks = [
    task('review', { name: '审核方案', due: '2026-07-20 17:00', est: '1h' }),
    task('meeting', { name: '召开风险会议', due: '2026-07-20 18:00', est: '30分钟' }),
  ];
  const invalid = reportFor(tasks, {
    energyRules: ['17:00-18:30 集中推进审核方案'],
  });
  const valid = reportFor(tasks, {
    energyRules: ['19:00-20:00 集中推进审核方案'],
  });
  const modelClient = queuedModel([invalid, valid]);

  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-07-20T04:00:00.000Z'),
  });

  assert.equal(textOf(result.energyRules[0]), '19:00-20:00 集中推进审核方案');
  assert.equal(modelClient.calls.length, 2);
  assert.deepEqual(JSON.parse(modelClient.calls[0].user).scheduleContext, {
    fixedPoints: [
      { taskId: 'review', taskName: '审核方案', time: '17:00', minute: 1020 },
      { taskId: 'meeting', taskName: '召开风险会议', time: '18:00', minute: 1080 },
    ],
    protectedWindows: [
      {
        taskId: 'review', taskName: '审核方案', startMinute: 960, endMinute: 1020,
        due: '17:00',
      },
      {
        taskId: 'meeting', taskName: '召开风险会议', startMinute: 1050, endMinute: 1080,
        due: '18:00',
      },
    ],
  });
});

test('报告连续两次建议冲突时间时返回安全回退或降级且不含冲突时段', async () => {
  const tasks = [task('meeting', {
    name: '召开风险会议',
    due: '今天18:00',
    est: '30分钟',
  })];
  const invalid = reportFor(tasks, {
    adjustments: ['17:45-18:30集中推进另一项方案'],
  });
  const modelClient = queuedModel([invalid, invalid]);

  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-07-20T04:00:00.000Z'),
  });

  assert.equal(modelClient.calls.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /17:45|18:30/);
  assert.equal(
    hasScheduleConflict(
      result,
      buildReportScheduleContext({
        tasks,
        now: () => new Date('2026-07-20T04:00:00.000Z'),
        timeZone: 'Asia/Shanghai',
      }),
    ),
    false,
  );
});

test('时间冲突回退导致剩余保护任务安排丢失时仍降级', async () => {
  const tasks = Array.from({ length: 6 }, (_, index) => task(`due-${index + 1}`, {
    name: `任务 ${index + 1}`,
    due: `2026-07-20 ${String(13 + index).padStart(2, '0')}:00`,
    est: '30分钟',
  }));
  const invalid = reportFor(tasks, {
    adjustments: ['16:45-17:15安排紧急方案'],
  });
  const modelClient = queuedModel([invalid, invalid]);

  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-07-20T04:00:00.000Z'),
  });
  assert.equal(modelClient.calls.length, 2);
  assert.equal(result.degraded, true);
  assert.equal(result.degradedReason, 'REPORT_REMAINING_PROTECTED_UNSCHEDULED');
});

test('报告 API 连续时间冲突时返回安全内容且日志记录降级原因', async () => {
  const { createApp } = require('../../server/app');
  const entries = [];
  const tasks = [task('meeting', {
    name: '召开风险会议',
    due: '今天18:00',
    est: '30分钟',
  })];
  const marker = '17:45-18:30-PRIVATE-CONFLICT';
  const invalid = reportFor(tasks, { adjustments: [marker] });
  const modelClient = queuedModel([invalid, invalid]);
  const app = createApp({
    authBoundary: createTestAuthBoundary(),
    modelClient,
    logger: entry => entries.push(entry),
    now: () => new Date('2026-07-20T04:00:00.000Z'),
  });
  const server = await listen(app);

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/time-management/report/generate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tasks,
          matrix: matrixFor(tasks),
          goals: { 昨天: '', 后天: '' },
        }),
      },
    );
    const body = await response.json();
    await new Promise(resolve => setImmediate(resolve));
    const reportEntry = entries.find(
      entry => entry.path === '/api/time-management/report/generate',
    );

    assert.equal(response.status, 200);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE-CONFLICT/);
    assert.equal(modelClient.calls.length, 2);
    assert.equal(body.degraded, true);
    assert.equal(reportEntry.modelOutputReason, 'REPORT_UNATTRIBUTED_SUGGESTION');
    assert.equal(reportEntry.modelAttempts, 2);
    assert.equal(reportEntry.status, 200);
  } finally {
    await close(server);
  }
});

test('含原始 HTML 的字符串无法通过证据门禁，降级且不输出原始内容', async () => {
  const tasks = [task('task-a')];
  const modelClient = queuedModel([reportFor(tasks, {
    energyRules: ['<img src=x onerror=alert(1)>', '**保留 Markdown**'],
  })]);
  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
  });
  assert.equal(result.degraded, true);
  assert.equal(result.degradedReason, 'REPORT_UNATTRIBUTED_SUGGESTION');
  assert.doesNotMatch(JSON.stringify(result), /onerror/);
});

test('POST /api/time-management/report/generate 返回结构化报告', async () => {
  const { createApp } = require('../../server/app');
  const tasks = [task('task-a')];
  const matrix = matrixFor(tasks);
  const app = createApp({
    authBoundary: createTestAuthBoundary(),
    modelClient: queuedModel([reportFor(tasks)]),
  });
  const server = await listen(app);

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/time-management/report/generate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tasks, matrix, goals: { 昨天: '', 后天: '' } }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expectedReport(tasks));
  } finally {
    await close(server);
  }
});

test('报告语义失败后第二次请求携带安全定向反馈', async () => {
  const tasks = [
    task('later', { due: '2026-07-27 17:00' }),
    task('earlier', { due: '2026-07-27 16:00' }),
  ];
  const invalid = reportFor(tasks);
  const valid = reportFor(tasks, {
    order: [
      { taskId: 'earlier', reason: '16:00 前完成' },
      { taskId: 'later', reason: '17:00 前完成' },
    ],
  });
  const modelClient = queuedModel([invalid, valid]);

  await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-07-27T04:00:00.000Z'),
  });

  const firstInput = JSON.parse(modelClient.calls[0].user);
  const secondInput = JSON.parse(modelClient.calls[1].user);
  assert.equal(firstInput.retryFeedback, undefined);
  assert.deepEqual(secondInput.retryFeedback, {
    failedRule: 'REPORT_ORDER_PRIORITY_MISMATCH',
    correction: 'order.taskId 必须与 priorityContext.recommendedTaskIds 完全同序。',
  });
});

test('报告连续两次语义失败时降级为基础报告并保留诊断码', async () => {
  const tasks = [task('current')];
  const invalid = reportFor(tasks, {
    order: [{ taskId: 'deleted', reason: '旧任务' }],
  });
  const modelClient = queuedModel([invalid, invalid]);
  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
  });
  assert.equal(modelClient.calls.length, 2);
  assert.equal(result.degraded, true);
  assert.equal(result.degradedReason, 'REPORT_ORDER_REFERENCE_INVALID');
  assert.deepEqual(result.order.map(item => item.taskId), ['current']);
});

test('报告 Schema 失败时第二次请求收到结构纠错', async () => {
  const tasks = [task('task-a')];
  const modelClient = queuedModel([
    { order: [], energyRules: [], adjustments: [] },
    reportFor(tasks),
  ]);

  await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
  });

  const retry = JSON.parse(modelClient.calls[1].user).retryFeedback;
  assert.equal(retry.failedRule, 'REPORT_SCHEMA_INVALID');
  assert.match(retry.correction, /order|energyRules|adjustments/);
});

test('报告 API 连续失败时降级为 200 基础报告且日志记录诊断元数据', async () => {
  const { createApp } = require('../../server/app');
  const entries = [];
  const tasks = [task('current')];
  const invalid = reportFor(tasks, {
    order: [{ taskId: 'deleted', reason: '旧任务' }],
  });
  const marker = 'SENSITIVE-MODEL-OUTPUT-12345';
  invalid.order[0].reason = marker;
  const modelClient = queuedModel([invalid, invalid]);
  const app = createApp({
    authBoundary: createTestAuthBoundary(),
    modelClient,
    logger: entry => entries.push(entry),
  });
  const server = await listen(app);

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/time-management/report/generate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tasks,
          matrix: matrixFor(tasks),
          goals: { 昨天: '', 后天: '' },
        }),
      },
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.degraded, true);
    assert.doesNotMatch(JSON.stringify(body), /deleted/);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(marker));

    assert.equal(entries.length, 1);
    const logEntry = entries[0];
    assert.equal(logEntry.modelOutputReason, 'REPORT_ORDER_REFERENCE_INVALID');
    assert.equal(logEntry.modelAttempts, 2);
    assert.doesNotMatch(JSON.stringify(logEntry), new RegExp(marker));
    assert.doesNotMatch(JSON.stringify(logEntry), /deleted/);
    assert.equal(modelClient.calls.length, 2);
  } finally {
    await close(server);
  }
});

test('模型持续失败或超时时返回确定性基础报告，不抛错不阻塞', async () => {
  const tasks = [
    task('task-a', { name: '提交排期表', due: '2026-07-20', owner: '王芳' }),
    task('task-b', { name: '采集日志', source: '今天' }),
  ];
  const matrix = matrixFor(tasks);
  const goals = { 昨天: '', 今天: '今日事项', 明天: '', 后天: '' };
  const distribution = {
    totalMinutes: 120,
    totalHours: 2,
    validTaskCount: 2,
    invalidTasks: [],
    percentages: { 昨天: 0, 今天: 100, 明天: 0, 后天: 0 },
    categories: [
      { key: '昨天', percent: 0, status: 'under' },
      { key: '今天', percent: 100, status: 'over' },
      { key: '明天', percent: 0, status: 'under' },
      { key: '后天', percent: 0, status: 'under' },
    ],
    diagnosis: ['今天投入偏高。'],
    recommendations: ['适当授权。'],
  };

  const result = await generateReport({
    tasks,
    matrix,
    goals,
    distribution,
    modelClient: rejectingModel('MODEL_TIMEOUT'),
    now: () => new Date('2026-07-20T04:00:00.000Z'),
  });

  assert.equal(result.degraded, true);
  assert.equal(result.degradedReason, 'MODEL_TIMEOUT');
  // 今日执行顺序：引用真实任务并带期限与责任人
  assert.deepEqual(result.order.map(item => item.taskId), ['task-a', 'task-b']);
  assert.match(result.order[0].reason, /2026-07-20 前完成/);
  assert.match(result.order[0].reason, /责任人 王芳/);
  // 时间分布：只来自确定性分布事实
  assert.ok(result.energyRules.length >= 1);
  assert.ok(result.adjustments.includes('适当授权。'));
  // 空栏只生成确认句式，不编造目标；分布建议不引用空维度；调整建议不超过 3 条（历史契约上限）
  assert.ok(result.adjustments.length <= 3);
  const emptyNotes = result.adjustments.filter(item => /^当前没有填写.*可确认是否需要补充。$/.test(item));
  assert.ok(emptyNotes.length >= 1);
  for (const item of emptyNotes) assert.match(item, /^当前没有填写(昨天|明天|后天)事项，可确认是否需要补充。$/);
  assert.ok(!result.adjustments.some(item => /明天|后天/.test(item) && !/^当前没有填写/.test(item)));
});

// --- 阶段2.2：四条语义拒绝规则 ---

test('规则1：引用空的明天/后天目标时拒绝并降级', async () => {
  const tasks = [task('task-a', { name: '提交排期表' })];
  const invalid = reportFor(tasks, {
    adjustments: ['将后天目标拆解成每周里程碑。'],
  });
  const modelClient = queuedModel([invalid, invalid]);
  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 明天: '', 后天: '' },
    modelClient,
  });
  assert.equal(modelClient.calls.length, 2);
  assert.equal(result.degraded, true);
  assert.equal(result.degradedReason, 'REPORT_EMPTY_DIMENSION_REFERENCE');
});

test('规则1：空栏引用出现在 order 理由中同样拒绝', async () => {
  const tasks = [task('task-a', { name: '提交排期表' })];
  const invalid = reportFor(tasks, {
    order: [{ taskId: 'task-a', reason: '与后天目标衔接后执行' }],
  });
  const valid = reportFor(tasks);
  const modelClient = queuedModel([invalid, valid]);
  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 明天: '', 后天: '' },
    modelClient,
  });
  assert.equal(modelClient.calls.length, 2);
  assert.equal(result.order[0].taskId, 'task-a');
});

test('规则2：建议授权给现有责任人时拒绝并降级', async () => {
  const tasks = [task('task-a', { name: '提交排期表', owner: '王芳' })];
  const invalid = reportFor(tasks, {
    adjustments: ['今天立即授权提交排期表给王芳处理。'],
  });
  const modelClient = queuedModel([invalid, invalid]);
  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
  });
  assert.equal(modelClient.calls.length, 2);
  assert.equal(result.degraded, true);
  assert.equal(result.degradedReason, 'REPORT_REASSIGN_TO_EXISTING_OWNER');
});

test('规则2：陈述既有责任人（不含授权语义）不拒绝', async () => {
  const tasks = [task('task-a', { name: '提交排期表', owner: '王芳' })];
  const modelClient = queuedModel([reportFor(tasks, {
    adjustments: ['由王芳今天18:00前完成提交排期表。'],
  })]);
  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
  });
  assert.equal(modelClient.calls.length, 1);
  assert.match(textOf(result.adjustments[0]), /王芳/);
});

test('规则3：无法归因到任务/维度/分布事实的建议被拒绝', async () => {
  const tasks = [task('task-a', { name: '提交排期表' })];
  const invalid = reportFor(tasks, {
    energyRules: ['每天冥想十分钟提升状态。'],
  });
  const modelClient = queuedModel([invalid, invalid]);
  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
  });
  assert.equal(result.degraded, true);
  assert.equal(result.degradedReason, 'REPORT_UNATTRIBUTED_SUGGESTION');
});

test('规则4：无明确依据修改/推迟当天到期任务时拒绝并降级', async () => {
  const tasks = [task('task-a', {
    name: '发布灰度',
    due: '2026-07-20 18:00',
  })];
  const invalid = reportFor(tasks, {
    adjustments: ['建议将发布灰度修改为下周进行。'],
  });
  const modelClient = queuedModel([invalid, invalid]);
  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-07-20T04:00:00.000Z'),
  });
  assert.equal(result.degraded, true);
  assert.equal(result.degradedReason, 'REPORT_TODAY_TASK_CHANGED_WITHOUT_BASIS');
});

test('规则4：带明确时刻的当天任务调整不被拒绝', async () => {
  const tasks = [task('task-a', {
    name: '发布灰度',
    due: '2026-07-20 18:00',
  })];
  const modelClient = queuedModel([reportFor(tasks, {
    adjustments: ['将发布灰度安排在 16:00-17:00 完成。'],
  })]);
  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-07-20T04:00:00.000Z'),
  });
  assert.equal(modelClient.calls.length, 1);
  assert.match(textOf(result.adjustments[0]), /16:00-17:00/);
});

// --- Fix 3: generate-report entry normalizes missing due/owner ---

test('report entry normalizes missing due and owner to 待确认 before model call', async () => {
  const tasks = [task('t1', { name: '任务', source: '今天' })];
  delete tasks[0].due;
  delete tasks[0].owner;
  const modelClient = queuedModel([reportFor(tasks)]);

  await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
  });

  const sent = JSON.parse(modelClient.calls[0].user);
  assert.equal(sent.tasks[0].due, '待确认');
  assert.equal(sent.tasks[0].owner, '待确认');
});

test('report entry preserves distribution and retry feedback after normalization', async () => {
  const tasks = [
    task('later', { due: '2026-07-27 17:00' }),
    task('earlier', { due: '2026-07-27 16:00' }),
  ];
  const invalid = reportFor(tasks);
  const valid = reportFor(tasks, {
    order: [
      { taskId: 'earlier', reason: '16:00 前完成' },
      { taskId: 'later', reason: '17:00 前完成' },
    ],
  });
  const modelClient = queuedModel([invalid, valid]);
  const distribution = {
    totalMinutes: 120,
    totalHours: 2,
    validTaskCount: 2,
    invalidTasks: [],
    percentages: { 昨天: 0, 今天: 100, 明天: 0, 后天: 0 },
    categories: [
      { key: '昨天', percent: 0, status: 'under' },
      { key: '今天', percent: 100, status: 'over' },
      { key: '明天', percent: 0, status: 'under' },
      { key: '后天', percent: 0, status: 'under' },
    ],
    diagnosis: ['今天投入偏高。'],
    recommendations: ['适当授权。'],
  };

  await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    distribution,
    modelClient,
    now: () => new Date('2026-07-27T04:00:00.000Z'),
  });

  assert.equal(modelClient.calls.length, 2);
  const firstInput = JSON.parse(modelClient.calls[0].user);
  assert.deepEqual(firstInput.distribution, distribution);
  const secondInput = JSON.parse(modelClient.calls[1].user);
  assert.equal(secondInput.retryFeedback.failedRule, 'REPORT_ORDER_PRIORITY_MISMATCH');
});

test('report entry normalization does not break existing safety diagnostics or fallback', async () => {
  const tasks = [task('meeting', {
    name: '召开风险会议',
    due: '今天18:00',
    est: '30分钟',
  })];
  const invalid = reportFor(tasks, {
    adjustments: ['17:45-18:30集中推进另一项方案'],
  });
  const modelClient = queuedModel([invalid, invalid]);

  const result = await generateReport({
    tasks,
    matrix: matrixFor(tasks),
    goals: { 昨天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-07-20T04:00:00.000Z'),
  });

  assert.equal(modelClient.calls.length, 2);
  assert.equal(
    hasScheduleConflict(
      result,
      buildReportScheduleContext({
        tasks,
        now: () => new Date('2026-07-20T04:00:00.000Z'),
        timeZone: 'Asia/Shanghai',
      }),
    ),
    false,
  );
});
