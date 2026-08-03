const test = require('node:test');
const assert = require('node:assert/strict');

const { MANUAL_FLAGS } = require('../../server/contracts/time-management');
const { extractTasks } = require('../../server/workflows/extract-tasks');
const { createTestAuthBoundary } = require('../helpers/test-auth-boundary');

function goals(overrides = {}) {
  return { 昨天: '', 今天: '', 明天: '', 后天: '', ...overrides };
}

function directTasks(taskOverridesArray) {
  return {
    tasks: taskOverridesArray.map((overrides) => ({
      name: '提交方案',
      importance: '中',
      urgency: '高',
      source: '今天',
      due: '待确认',
      est: '约1h',
      owner: '待确认',
      acceptanceCriteria: [],
      nextAction: '',
      status: 'pending',
      ...overrides,
    })),
  };
}

function queuedModel(outputs) {
  const calls = [];
  return {
    calls,
    completeJson: async (input) => {
      calls.push(input);
      const next = outputs[Math.min(calls.length - 1, outputs.length - 1)];
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(input) : next;
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
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

// --- Basic task extraction ---

test('并列事项拆为两条独立任务并生成不同 UUID', async () => {
  const modelClient = queuedModel([directTasks([
    { name: '校对方案' },
    { name: '跟进投诉', importance: '高' },
  ])]);
  const input = goals({ 今天: '①校对方案；②跟进投诉' });

  const result = await extractTasks({ goals: input, modelClient });
  assert.deepEqual(result.tasks.map((task) => task.name), ['校对方案', '跟进投诉']);
  assert.notEqual(result.tasks[0].id, result.tasks[1].id);
  assert.equal(result.tasks[0].classificationSource, 'ai-extraction');
  assert.equal(modelClient.calls.length, 1);
  assert.equal(modelClient.calls[0].maxAttempts, 1);
  assert.match(modelClient.calls[0].system, /任务拆解/);
  assert.deepEqual(JSON.parse(modelClient.calls[0].user), { goals: input });
});

test('同名任务不按名称去重并保持不同 ID', async () => {
  const result = await extractTasks({
    goals: goals({ 今天: '分别向两个对象提交方案' }),
    modelClient: queuedModel([directTasks([{}, {}])]),
  });
  assert.equal(result.tasks.length, 2);
  assert.notEqual(result.tasks[0].id, result.tasks[1].id);
});

test('明天为空时不得出现短期目标来源', async () => {
  const invalid = directTasks([{ source: '短期目标' }]);
  const modelClient = queuedModel([invalid, invalid]);
  await assert.rejects(
    extractTasks({ goals: goals({ 今天: '提交方案' }), modelClient }),
    (error) => error.code === 'MODEL_OUTPUT_INVALID',
  );
  assert.equal(modelClient.calls.length, 2);
});

test('已完成复盘事实且无后续动作时不生成待办', async () => {
  const invalid = directTasks([{
    name: '完成季度复盘',
    source: '复盘',
  }]);
  const modelClient = queuedModel([invalid, invalid]);
  await assert.rejects(
    extractTasks({ goals: goals({ 昨天: '已完成季度复盘' }), modelClient }),
    (error) => error.code === 'MODEL_OUTPUT_INVALID',
  );
  assert.equal(modelClient.calls.length, 2);

  const result = await extractTasks({
    goals: goals({ 昨天: '已完成季度复盘' }),
    modelClient: queuedModel([directTasks([])]),
  });
  assert.deepEqual(result.tasks, []);
});

test('模型用待确认表示缺少截止时间', async () => {
  const result = await extractTasks({
    goals: goals({ 今天: '提交方案' }),
    modelClient: queuedModel([directTasks([{ due: '待确认' }])]),
  });
  assert.equal(result.tasks[0].due, '待确认');
  assert.equal(result.tasks[0].status, 'pending');
  assert.match(result.tasks[0].id, /^[0-9a-f-]{36}$/i);
});

test('模型相对截止时间转换为具体上海日期且模糊期限变为待确认', async () => {
  const now = () => new Date('2026-07-20T04:00:00.000Z');
  const input = goals({
    今天: '今天提交方案，另有事项尽快处理',
    明天: '明天提交验收清单',
    后天: '后天完成复盘',
  });
  const result = await extractTasks({
    goals: input,
    now,
    modelClient: queuedModel([directTasks([
      { name: '提交方案', due: '今天18:00' },
      { name: '处理模糊事项', due: '尽快' },
      { name: '提交验收清单', source: '短期目标', due: '明天', acceptanceCriteria: ['清单已提交'] },
      { name: '完成复盘', source: '中长期', due: '后天 09:30', acceptanceCriteria: ['复盘已记录'] },
    ])]),
  });

  assert.deepEqual(result.tasks.map((item) => item.due), [
    '2026-07-20',
    '待确认',
    '2026-07-21',
    '2026-07-22',
  ]);
});

test('任务提取后按期限、来源和压力统一纠偏紧急度', async () => {
  const result = await extractTasks({
    goals: goals({
      昨天: '复盘改进待落实，截止待确认；另有本周五需要完成的协调事项',
      今天: '今天处理当前行动',
      明天: '明天提交短期方案',
      后天: '未来推进长期机制建设',
    }),
    now: () => new Date('2026-07-20T04:00:00.000Z'),
    modelClient: queuedModel([directTasks([
      { name: '处理当前行动', source: '今天', due: '待确认', urgency: '低' },
      { name: '落实复盘改进', source: '复盘', due: '待确认', urgency: '高' },
      { name: '完成协调事项', source: '复盘', due: '本周五', urgency: '高' },
      { name: '提交短期方案', source: '短期目标', due: '明天', urgency: '低', acceptanceCriteria: ['方案已提交'] },
      { name: '建设长期机制', source: '中长期', due: '2026-09-30', urgency: '高', acceptanceCriteria: ['机制已试运行'] },
    ])]),
  });

  assert.deepEqual(result.tasks.map((item) => item.urgency), [
    '高',
    '低',
    '低',
    '中',
    '低',
  ]);
});

test('任务提取用对应原始目标纠正未来高紧急度', async () => {
  const now = () => new Date('2026-07-20T04:00:00.000Z');
  const ordinary = await extractTasks({
    goals: goals({ 明天: '明天 09:00 提交发布准备清单' }),
    now,
    modelClient: queuedModel([directTasks([{
      name: '提交发布准备清单',
      source: '短期目标',
      due: '明天 09:00',
      urgency: '高',
      acceptanceCriteria: ['清单已提交'],
    }])]),
  });
  assert.equal(ordinary.tasks[0].urgency, '中');

  const blocked = await extractTasks({
    goals: goals({ 明天: '发布准备已阻塞，明天 09:00 前必须尽快提交清单' }),
    now,
    modelClient: queuedModel([directTasks([{
      name: '提交发布准备清单',
      source: '短期目标',
      due: '明天 09:00',
      urgency: '高',
      acceptanceCriteria: ['清单已提交'],
    }])]),
  });
  assert.equal(blocked.tasks[0].urgency, '高');
});

test('SMART 任务保留模块、模拟次数和评分验收标准', async () => {
  const criteria = ['形成 4 个模块', '完成 2 次模拟', '评分不低于 80 分'];
  const result = await extractTasks({
    goals: goals({ 明天: '2026-07-31 前形成 4 个模块，完成 2 次模拟，评分不低于 80 分' }),
    modelClient: queuedModel([directTasks([{
      name: '完成管理课程训练材料',
      source: '短期目标',
      due: '2026-07-31',
      acceptanceCriteria: criteria,
    }])]),
  });
  assert.deepEqual(result.tasks[0].acceptanceCriteria, criteria);
});

test('中短期任务缺少验收标准时重试一次', async () => {
  const invalid = directTasks([{ source: '短期目标' }]);
  const valid = directTasks([{
    source: '短期目标',
    acceptanceCriteria: ['交付 1 份可评审方案'],
  }]);
  const modelClient = queuedModel([invalid, valid]);
  const result = await extractTasks({
    goals: goals({ 明天: '本月底前交付 1 份可评审方案' }),
    modelClient,
  });
  assert.deepEqual(result.tasks[0].acceptanceCriteria, ['交付 1 份可评审方案']);
  assert.equal(modelClient.calls.length, 2);
});

test('今天来源的 12h 大任务被拒绝并要求模型拆分', async () => {
  const invalid = directTasks([{ est: '12h' }]);
  const modelClient = queuedModel([invalid, invalid]);
  await assert.rejects(
    extractTasks({ goals: goals({ 今天: '今天完成预计 12h 的发布工作' }), modelClient }),
    (error) => error.code === 'MODEL_OUTPUT_INVALID',
  );
  assert.equal(modelClient.calls.length, 2);
});

test('中长期 16h 里程碑有下一步时接受且无下一步时重试', async () => {
  const invalid = directTasks([{
    source: '中长期',
    est: '16h',
    acceptanceCriteria: ['完成第一阶段里程碑'],
  }]);
  const valid = directTasks([{
    source: '中长期',
    est: '16h',
    acceptanceCriteria: ['完成第一阶段里程碑'],
    nextAction: '今天先列出里程碑所需的 4 个模块',
  }]);
  const modelClient = queuedModel([invalid, valid]);
  const result = await extractTasks({
    goals: goals({ 后天: '推进长期项目第一阶段里程碑' }),
    modelClient,
  });
  assert.equal(result.tasks[0].nextAction, '今天先列出里程碑所需的 4 个模块');
  assert.equal(modelClient.calls.length, 2);
});

test('不可解析耗时原样保留且不猜测任务粒度', async () => {
  const result = await extractTasks({
    goals: goals({ 今天: '今天梳理需求，预计半天' }),
    modelClient: queuedModel([directTasks([{ est: '半天' }])]),
  });
  assert.equal(result.tasks[0].est, '半天');
  assert.equal(result.tasks[0].nextAction, '');
});

test('超过 100 条任务时重试一次后拒绝', async () => {
  const invalid = directTasks(Array.from({ length: 101 }, (_, index) => ({
    name: `任务${index}`,
  })));
  const modelClient = queuedModel([invalid, invalid]);
  await assert.rejects(
    extractTasks({ goals: goals({ 今天: '很多事项' }), modelClient }),
    (error) => error.code === 'MODEL_OUTPUT_INVALID',
  );
  assert.equal(modelClient.calls.length, 2);
});

test('非法枚举会触发一次重试并接受第二次合法输出', async () => {
  const modelClient = queuedModel([
    directTasks([{ importance: '非常高' }]),
    directTasks([{}]),
  ]);
  const result = await extractTasks({ goals: goals({ 今天: '提交方案' }), modelClient });
  assert.equal(result.tasks[0].importance, '中');
  assert.equal(modelClient.calls.length, 2);
});

test('空任务名连续两次出现时最终失败', async () => {
  const invalid = directTasks([{ name: '   ' }]);
  const modelClient = queuedModel([invalid, invalid]);
  await assert.rejects(
    extractTasks({ goals: goals({ 今天: '提交方案' }), modelClient }),
    (error) => error.code === 'MODEL_OUTPUT_INVALID',
  );
  assert.equal(modelClient.calls.length, 2);
});

test('手动任务四种标注映射保留未标注 null/null', () => {
  assert.deepEqual(MANUAL_FLAGS, {
    imp: { importance: '高', urgency: '低', classificationSource: 'manual' },
    urg: { importance: '低', urgency: '高', classificationSource: 'manual' },
    both: { importance: '高', urgency: '高', classificationSource: 'manual' },
    unclassified: {
      importance: null,
      urgency: null,
      classificationSource: 'unclassified',
    },
  });
});

test('原文明确责任人时提取 owner，未给时为待确认', async () => {
  const result = await extractTasks({
    goals: goals({ 今天: '张三负责提交方案' }),
    modelClient: queuedModel([directTasks([{ owner: '张三' }])]),
  });
  assert.equal(result.tasks[0].owner, '张三');

  const noOwner = await extractTasks({
    goals: goals({ 今天: '提交方案' }),
    modelClient: queuedModel([directTasks([{}])]),
  });
  assert.equal(noOwner.tasks[0].owner, '待确认');
});

test('输入含今天18:00时新任务 due 为当天日期', async () => {
  const result = await extractTasks({
    goals: goals({ 今天: '今天18:00提交方案' }),
    now: () => new Date('2026-07-20T04:00:00.000Z'),
    modelClient: queuedModel([directTasks([{ due: '今天18:00' }])]),
  });
  assert.equal(result.tasks[0].due, '2026-07-20');
});

test('昨天未完成事项生成复盘来源任务', async () => {
  const result = await extractTasks({
    goals: goals({ 昨天: '昨天未完成审核方案' }),
    modelClient: queuedModel([directTasks([{
      name: '审核方案',
      source: '复盘',
    }])]),
  });
  assert.equal(result.tasks[0].source, '复盘');
  assert.equal(result.tasks[0].name, '审核方案');
});

test('已完成事实仍不生成任务', async () => {
  const result = await extractTasks({
    goals: goals({ 昨天: '已完成季度复盘' }),
    modelClient: queuedModel([directTasks([])]),
  });
  assert.equal(result.tasks.length, 0);
});

test('POST /api/time-management/tasks/extract 返回标准任务', async () => {
  const { createApp } = require('../../server/app');
  const app = createApp({
    authBoundary: createTestAuthBoundary(),
    modelClient: queuedModel([directTasks([{}])]),
  });
  const server = await listen(app);

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/time-management/tasks/extract`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goals: goals({ 今天: '提交方案' }) }),
      },
    );
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.tasks[0].name, '提交方案');
    assert.equal(payload.tasks[0].classificationSource, 'ai-extraction');
  } finally {
    await close(server);
  }
});

test('提取 API 使用注入的服务端时钟且拒绝客户端 referenceDate', async () => {
  const { createApp } = require('../../server/app');
  const modelClient = queuedModel([directTasks([{
    due: '2026-07-20 17:00',
    urgency: '中',
  }])]);
  const app = createApp({
    authBoundary: createTestAuthBoundary(),
    modelClient,
    now: () => new Date('2026-07-20T04:00:00.000Z'),
  });
  const server = await listen(app);

  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/api/time-management/tasks/extract`;
    const accepted = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goals: goals({ 今天: '提交方案' }) }),
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).tasks[0].urgency, '高');

    const rejected = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goals: goals({ 今天: '提交方案' }),
        referenceDate: '2099-01-01',
      }),
    });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error.code, 'INPUT_INVALID');
    assert.equal(modelClient.calls.length, 1);
  } finally {
    await close(server);
  }
});

// --- Completed/unfinished yesterday semantics ---

test('mixed completed and unfinished yesterday text keeps only the unfinished action', async () => {
  const result = await extractTasks({
    goals: goals({ 昨天: '已完成季度复盘，但未完成审核方案' }),
    modelClient: queuedModel([directTasks([{
      name: '审核方案',
      source: '复盘',
      due: '待确认',
      owner: '待确认',
    }])]),
  });

  assert.deepEqual(result.tasks.map((task) => task.name), ['审核方案']);
});

test('completed yesterday facts remain forbidden when today also has content', async () => {
  const modelClient = queuedModel([
    directTasks([{
      name: '季度复盘',
      source: '复盘',
      due: '待确认',
      owner: '待确认',
    }]),
    directTasks([{
      name: '提交今日方案',
      source: '今天',
      due: '待确认',
      owner: '待确认',
    }]),
  ]);

  const result = await extractTasks({
    goals: goals({ 昨天: '已完成季度复盘', 今天: '提交今日方案' }),
    modelClient,
  });

  assert.equal(modelClient.calls.length, 2);
  assert.deepEqual(result.tasks.map((task) => task.name), ['提交今日方案']);
});

test('completed fact followed by an explicit improvement action allows only that action', async () => {
  const result = await extractTasks({
    goals: goals({ 昨天: '已完成季度复盘；后续补充风险清单' }),
    modelClient: queuedModel([directTasks([{
      name: '补充风险清单',
      source: '复盘',
      due: '待确认',
      owner: '待确认',
    }])]),
  });

  assert.deepEqual(result.tasks.map((task) => task.name), ['补充风险清单']);
});

test('an owner absent from the corresponding source text triggers retry', async () => {
  const modelClient = queuedModel([
    directTasks([{ owner: '李四' }]),
    directTasks([{ owner: '待确认' }]),
  ]);

  const result = await extractTasks({
    goals: goals({ 今天: '提交方案' }),
    modelClient,
  });

  assert.equal(modelClient.calls.length, 2);
  assert.equal(result.tasks[0].owner, '待确认');
});

test('an inferred owner is rejected after both model attempts', async () => {
  const modelClient = queuedModel([
    directTasks([{ owner: '李四' }]),
    directTasks([{ owner: '李四' }]),
  ]);

  await assert.rejects(
    () => extractTasks({
      goals: goals({ 今天: '提交方案' }),
      modelClient,
    }),
    (error) => error.code === 'MODEL_OUTPUT_INVALID' && error.status === 502,
  );
});

test('a model cannot remove the completed verb and repeat the completed object', async () => {
  await assert.rejects(
    () => extractTasks({
      goals: goals({ 昨天: '已完成季度复盘' }),
      modelClient: queuedModel([
        directTasks([{
          name: '季度复盘',
          source: '复盘',
        }]),
        directTasks([{
          name: '季度复盘',
          source: '复盘',
        }]),
      ]),
    }),
    (error) => error.code === 'MODEL_OUTPUT_INVALID',
  );
});

test('postfix completed fact "季度复盘已经完成" rejects repeat of the object', async () => {
  await assert.rejects(
    () => extractTasks({
      goals: goals({ 昨天: '季度复盘已经完成，但未完成审核方案' }),
      modelClient: queuedModel([
        directTasks([{ name: '季度复盘', source: '复盘' }]),
        directTasks([{ name: '季度复盘', source: '复盘' }]),
      ]),
    }),
    (error) => error.code === 'MODEL_OUTPUT_INVALID',
  );
});

test('postfix completed fact with mixed input accepts only the unfinished task', async () => {
  const result = await extractTasks({
    goals: goals({ 昨天: '季度复盘已经完成，但未完成审核方案' }),
    modelClient: queuedModel([directTasks([{
      name: '审核方案', source: '复盘', due: '待确认', owner: '待确认',
    }])]),
  });
  assert.deepEqual(result.tasks.map((task) => task.name), ['审核方案']);
});

test('postfix completed fact "季度复盘已完成" with follow-up allows supplement but not the object', async () => {
  const result = await extractTasks({
    goals: goals({ 昨天: '季度复盘已完成，但需要补充结论' }),
    modelClient: queuedModel([directTasks([{
      name: '补充季度复盘结论', source: '复盘', due: '待确认', owner: '待确认',
    }])]),
  });
  assert.deepEqual(result.tasks.map((task) => task.name), ['补充季度复盘结论']);

  await assert.rejects(
    () => extractTasks({
      goals: goals({ 昨天: '季度复盘已完成，但需要补充结论' }),
      modelClient: queuedModel([
        directTasks([{ name: '季度复盘', source: '复盘' }]),
        directTasks([{ name: '季度复盘', source: '复盘' }]),
      ]),
    }),
    (error) => error.code === 'MODEL_OUTPUT_INVALID',
  );
});

test('today tasks are not rejected when yesterday only has completed facts', async () => {
  const result = await extractTasks({
    goals: goals({ 昨天: '季度复盘已经完成', 今天: '提交今日方案' }),
    modelClient: queuedModel([directTasks([
      { name: '提交今日方案', source: '今天', due: '待确认', owner: '待确认' },
    ])]),
  });
  assert.deepEqual(result.tasks.map((task) => task.name), ['提交今日方案']);
});

test('unpunctuated postfix completed fact cannot be repeated', async () => {
  const modelClient = queuedModel([
    directTasks([{ name: '季度复盘', source: '复盘' }]),
    directTasks([{ name: '季度复盘', source: '复盘' }]),
  ]);

  await assert.rejects(
    () => extractTasks({
      goals: goals({ 昨天: '季度复盘已经完成但未完成审核方案' }),
      modelClient,
    }),
    (error) => error.code === 'MODEL_OUTPUT_INVALID' && error.status === 502,
  );
  assert.equal(modelClient.calls.length, 2);
});

test('unpunctuated mixed yesterday text keeps only the unfinished action', async () => {
  const result = await extractTasks({
    goals: goals({ 昨天: '季度复盘已经完成但未完成审核方案' }),
    modelClient: queuedModel([directTasks([{
      name: '审核方案', source: '复盘', due: '待确认', owner: '待确认',
    }])]),
  });

  assert.deepEqual(result.tasks.map((task) => task.name), ['审核方案']);
});

test('postfix 完成了 form cannot repeat the completed object', async () => {
  const modelClient = queuedModel([
    directTasks([{ name: '季度复盘', source: '复盘' }]),
    directTasks([{ name: '季度复盘', source: '复盘' }]),
  ]);

  await assert.rejects(
    () => extractTasks({
      goals: goals({ 昨天: '季度复盘完成了，但未完成审核方案' }),
      modelClient,
    }),
    (error) => error.code === 'MODEL_OUTPUT_INVALID' && error.status === 502,
  );
  assert.equal(modelClient.calls.length, 2);
});

async function assertSubjectContrastRejectsCompletedFact(yesterday) {
  const modelClient = queuedModel([
    directTasks([{ name: '季度复盘', source: '复盘' }]),
    directTasks([{ name: '季度复盘', source: '复盘' }]),
  ]);

  await assert.rejects(
    () => extractTasks({ goals: goals({ 昨天: yesterday }), modelClient }),
    (error) => error.code === 'MODEL_OUTPUT_INVALID' && error.status === 502,
  );
  assert.equal(modelClient.calls.length, 2);
}

test('带主语无标点转折：已经完成但审核方案未完成', async () => {
  await assertSubjectContrastRejectsCompletedFact('季度复盘已经完成但审核方案未完成');
});

test('带主语无标点转折：完成了但是审核方案尚未完成', async () => {
  await assertSubjectContrastRejectsCompletedFact('季度复盘完成了但是审核方案尚未完成');
});

test('带主语无标点转折：已经完成但是审核方案还未完成', async () => {
  await assertSubjectContrastRejectsCompletedFact('季度复盘已经完成但是审核方案还未完成');
});

test('带主语无标点转折：已经完成不过审核方案仍未完成', async () => {
  await assertSubjectContrastRejectsCompletedFact('季度复盘已经完成不过审核方案仍未完成');
});

test('带主语无标点转折合法返回审核方案', async () => {
  const modelClient = queuedModel([directTasks([{
    name: '审核方案', source: '复盘',
  }])]);

  const result = await extractTasks({
    goals: goals({ 昨天: '季度复盘已经完成但审核方案未完成' }),
    modelClient,
  });

  assert.deepEqual(result.tasks.map((task) => task.name), ['审核方案']);
  assert.equal(modelClient.calls.length, 1);
});

test('不但结构保持为同一可执行语义，不产生错误拒绝', async () => {
  const result = await extractTasks({
    goals: goals({ 昨天: '审核方案未完成不但需要补充证据而且需要补充结论' }),
    modelClient: queuedModel([directTasks([{
      name: '补充审核方案证据', source: '复盘',
    }])]),
  });

  assert.deepEqual(result.tasks.map((task) => task.name), ['补充审核方案证据']);
});

test('但愿结构保持为同一可执行语义，不产生错误拒绝', async () => {
  const result = await extractTasks({
    goals: goals({ 昨天: '但愿审核方案顺利完成，后续继续跟进' }),
    modelClient: queuedModel([directTasks([{
      name: '继续跟进审核方案', source: '复盘',
    }])]),
  });

  assert.deepEqual(result.tasks.map((task) => task.name), ['继续跟进审核方案']);
});

test('owner 不在来源文本时首次错误后重试并接受待确认', async () => {
  const modelClient = queuedModel([
    directTasks([{ owner: '王五' }]),
    directTasks([{ owner: '待确认' }]),
  ]);

  const result = await extractTasks({
    goals: goals({ 今天: '提交方案' }),
    modelClient,
  });

  assert.equal(modelClient.calls.length, 2);
  assert.equal(result.tasks[0].owner, '待确认');
});

test('owner 不在来源文本连续两次出现时最终拒绝', async () => {
  const modelClient = queuedModel([
    directTasks([{ owner: '王五' }]),
    directTasks([{ owner: '王五' }]),
  ]);

  await assert.rejects(
    () => extractTasks({
      goals: goals({ 今天: '整理方案' }),
      modelClient,
    }),
    (error) => error.code === 'MODEL_OUTPUT_INVALID' && error.status === 502,
  );
  assert.equal(modelClient.calls.length, 2);
});

test('责任主体"张三负责"允许 owner 完全匹配张三', async () => {
  const result = await extractTasks({
    goals: goals({ 今天: '张三负责提交方案' }),
    modelClient: queuedModel([directTasks([{ owner: '张三' }])]),
  });

  assert.equal(result.tasks[0].owner, '张三');
});

test('责任人标签允许 owner 完全匹配李四', async () => {
  const result = await extractTasks({
    goals: goals({ 今天: '负责人：李四，提交验收材料' }),
    modelClient: queuedModel([directTasks([{
      name: '提交验收材料', owner: '李四',
    }])]),
  });

  assert.equal(result.tasks[0].owner, '李四');
});

test('责任主体"由研发组牵头"允许 owner 完全匹配研发组', async () => {
  const result = await extractTasks({
    goals: goals({ 今天: '由研发组牵头完成复盘' }),
    modelClient: queuedModel([directTasks([{
      name: '完成复盘', owner: '研发组',
    }])]),
  });

  assert.equal(result.tasks[0].owner, '研发组');
});

test('owner 不在来源文本时被拒绝（轻量校验）', async () => {
  const modelClient = queuedModel([
    directTasks([{ owner: '王五' }]),
    directTasks([{ owner: '王五' }]),
  ]);

  await assert.rejects(
    () => extractTasks({
      goals: goals({ 今天: '提交方案给李四评审' }),
      modelClient,
    }),
    (error) => error.code === 'MODEL_OUTPUT_INVALID' && error.status === 502,
  );
  assert.equal(modelClient.calls.length, 2);
});

// --- Model call count boundaries (new for direct-task mode) ---

test('合法输出时模型调用次数严格为 1', async () => {
  const modelClient = queuedModel([directTasks([{}])]);
  const result = await extractTasks({
    goals: goals({ 今天: '提交方案' }),
    modelClient,
  });

  assert.equal(modelClient.calls.length, 1);
  // 返回对象只有 tasks
  assert.deepEqual(Object.keys(result), ['tasks']);
  assert.equal(result.tasks.length, 1);
});

test('返回对象只有 tasks，没有 warnings 或 analysisVersion', async () => {
  const result = await extractTasks({
    goals: goals({ 今天: '提交方案' }),
    modelClient: queuedModel([directTasks([{}])]),
  });

  assert.equal('warnings' in result, false);
  assert.equal('analysisVersion' in result, false);
  assert.deepEqual(Object.keys(result), ['tasks']);
});

test('返回任务没有 claim 或 evidence 字段', async () => {
  const result = await extractTasks({
    goals: goals({ 今天: '提交方案' }),
    modelClient: queuedModel([directTasks([{}])]),
  });

  const serialized = JSON.stringify(result.tasks);
  assert.doesNotMatch(
    serialized,
    /"(?:claimId|sourceHint|actionEvidence|dispositionEvidence|ownerRelation|dueEvidence|start|end|quote|claims|candidateTasks)"\s*:/,
  );
  assert.deepEqual(Object.keys(result.tasks[0]).sort(), [
    'acceptanceCriteria',
    'classificationSource',
    'due',
    'est',
    'id',
    'importance',
    'name',
    'nextAction',
    'owner',
    'source',
    'status',
    'urgency',
  ]);
});

test('首次 claims+candidateTasks 格式非法，第二次合法 tasks 格式成功', async () => {
  const modelClient = queuedModel([
    { claims: [], candidateTasks: [] },
    directTasks([{}]),
  ]);

  const result = await extractTasks({
    goals: goals({ 今天: '提交方案' }),
    modelClient,
  });

  assert.equal(modelClient.calls.length, 2);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].name, '提交方案');
});

test('连续两次非法输出返回 MODEL_OUTPUT_INVALID', async () => {
  const modelClient = queuedModel([
    { claims: [], candidateTasks: [] },
    { claims: [], candidateTasks: [] },
  ]);

  await assert.rejects(
    () => extractTasks({
      goals: goals({ 今天: '提交方案' }),
      modelClient,
    }),
    (error) => error.code === 'MODEL_OUTPUT_INVALID',
  );
  assert.equal(modelClient.calls.length, 2);
});

test('MODEL_TIMEOUT 只调用一次且不重试', async () => {
  const timeoutError = Object.assign(new Error('timeout'), { code: 'MODEL_TIMEOUT' });
  const modelClient = queuedModel([timeoutError, directTasks([{}])]);

  await assert.rejects(
    () => extractTasks({
      goals: goals({ 今天: '提交方案' }),
      modelClient,
    }),
    (error) => error.code === 'MODEL_TIMEOUT' && error.status === 504,
  );
  assert.equal(modelClient.calls.length, 1);
});

test('MODEL_UPSTREAM_ERROR 只调用一次且不重试', async () => {
  const upstreamError = Object.assign(new Error('upstream'), { code: 'MODEL_UPSTREAM_ERROR' });
  const modelClient = queuedModel([upstreamError, directTasks([{}])]);

  await assert.rejects(
    () => extractTasks({
      goals: goals({ 今天: '提交方案' }),
      modelClient,
    }),
    (error) => error.code === 'MODEL_UPSTREAM_ERROR' && error.status === 502,
  );
  assert.equal(modelClient.calls.length, 1);
});

test('zero tasks returns empty array with no error', async () => {
  const result = await extractTasks({
    goals: goals({ 昨天: '已完成季度复盘' }),
    modelClient: queuedModel([directTasks([])]),
  });

  assert.deepEqual(result, { tasks: [] });
});

test('owner、due、classificationSource 均正确标准化', async () => {
  const result = await extractTasks({
    goals: goals({ 今天: '张三负责今天18:00前提交方案' }),
    now: () => new Date('2026-07-20T04:00:00.000Z'),
    modelClient: queuedModel([directTasks([{
      name: '提交方案',
      owner: '张三',
      due: '今天18:00',
    }])]),
  });

  assert.equal(result.tasks[0].owner, '张三');
  assert.equal(result.tasks[0].due, '2026-07-20');
  assert.equal(result.tasks[0].classificationSource, 'ai-extraction');
});

// --- Training document regression (测试文档.md) ---

test('已完成复盘报告不进入任务', async () => {
  const result = await extractTasks({
    goals: goals({ 昨天: '复盘报告已经完成并发送给团队' }),
    modelClient: queuedModel([directTasks([])]),
  });
  assert.equal(result.tasks.length, 0);
});

test('确认剩余 2 项负责人进入任务', async () => {
  const result = await extractTasks({
    goals: goals({
      昨天: '确认剩余2项改进措施的负责人',
      今天: '',
      明天: '',
      后天: '',
    }),
    modelClient: queuedModel([directTasks([{
      name: '确认剩余2项改进措施的负责人',
      importance: '高',
      urgency: '高',
      source: '复盘',
      due: '今天11:30前',
      est: '30分钟',
      owner: '待确认',
      acceptanceCriteria: ['2项措施均登记责任人'],
      nextAction: '',
      status: 'pending',
    }])]),
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].name, '确认剩余2项改进措施的负责人');
  assert.equal(result.tasks[0].importance, '高');
  assert.equal(result.tasks[0].owner, '待确认');
  assert.ok(result.tasks[0].due);
  assert.ok(result.tasks[0].acceptanceCriteria.length > 0);
});

test('任务对象包含 due 和 owner', async () => {
  const result = await extractTasks({
    goals: goals({ 今天: '张三在今天12:00前提交方案' }),
    now: () => new Date('2026-07-20T04:00:00.000Z'),
    modelClient: queuedModel([directTasks([{
      name: '提交方案',
      owner: '张三',
      due: '今天12:00',
    }])]),
  });

  assert.equal(result.tasks[0].owner, '张三');
  assert.equal(result.tasks[0].due, '2026-07-20');
  assert.equal('claimId' in result.tasks[0], false);
  assert.equal('evidence' in result.tasks[0], false);
});

// --- Unfinished evidence cue regression (adapted for direct-task mode) ---

for (const unfinishedCue of [
  '未完成',
  '尚未完成',
  '仍未完成',
  '还没完成',
  '没有完成',
  '没完成',
  '待补充',
  '需要继续',
]) {
  test(`unfinished cue "${unfinishedCue}" produces an actionable task`, async () => {
    const text = `审核方案${unfinishedCue}`;
    const modelClient = queuedModel([directTasks([{
      name: '审核方案',
      source: '复盘',
    }])]);

    const result = await extractTasks({
      goals: goals({ 昨天: text }),
      modelClient,
    });

    assert.deepEqual(
      result.tasks.map((task) => [task.name, task.source]),
      [['审核方案', '复盘']],
    );
    assert.equal(modelClient.calls.length, 1);
  });
}

test('单行三个并列事项拆为三条独立任务', async () => {
  const modelClient = queuedModel([directTasks([
    { name: '校对方案' },
    { name: '跟进投诉', importance: '高' },
    { name: '回写记录', urgency: '低' },
  ])]);
  const input = goals({ 今天: '①校对方案；②跟进投诉；③回写记录' });

  const result = await extractTasks({ goals: input, modelClient });
  assert.deepEqual(result.tasks.map((task) => task.name), ['校对方案', '跟进投诉', '回写记录']);
  assert.equal(new Set(result.tasks.map(task => task.id)).size, 3);
});

test('重复的昨天遗留与今天行动只生成一条任务', async () => {
  const modelClient = queuedModel([directTasks([
    { name: '完成支付回调日志采集', source: '复盘' },
    { name: '完成支付回调日志采集', source: '今天' },
  ])]);
  const input = goals({ 昨天: '支付回调日志采集尚未完成', 今天: '完成支付回调日志采集' });

  const result = await extractTasks({ goals: input, modelClient });
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].source, '今天');
});

test('同名同来源任务不按名称去重', async () => {
  const result = await extractTasks({
    goals: goals({ 今天: '分别向两个对象提交方案' }),
    modelClient: queuedModel([directTasks([{}, {}])]),
  });
  assert.equal(result.tasks.length, 2);
  assert.notEqual(result.tasks[0].id, result.tasks[1].id);
});
