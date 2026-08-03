const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyMatrix } = require('../../server/workflows/classify-matrix');
const { createTestAuthBoundary } = require('../helpers/test-auth-boundary');

function task(overrides = {}) {
  return {
    id: 'task-a',
    name: '处理投诉',
    importance: '高',
    urgency: '高',
    classificationSource: 'ai-extraction',
    ...overrides,
  };
}

function classification(item, overrides = {}) {
  return {
    taskId: item.id,
    importance: item.importance,
    urgency: item.urgency,
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

test('每条任务只出现一次且精力比例合计 100', async () => {
  const tasks = [
    task({ id: 'a' }),
    task({ id: 'b', name: '安排复盘', urgency: '低' }),
    task({
      id: 'c',
      name: '准备临时会议材料',
      importance: null,
      urgency: null,
      classificationSource: 'unclassified',
    }),
  ];
  const modelClient = queuedModel([{
    classifications: [
      classification(tasks[0]),
      classification(tasks[1]),
      classification(tasks[2], { importance: '中', urgency: '高' }),
    ],
    note: '',
  }]);

  const result = await classifyMatrix({ tasks, modelClient });
  assert.deepEqual(result.quadrants.flatMap(item => item.taskIds).sort(), ['a', 'b', 'c']);
  assert.equal(result.quadrants.reduce((sum, item) => sum + item.energyPercent, 0), 100);
  assert.equal(
    result.classifications.find(item => item.taskId === 'c').classificationSource,
    'ai-matrix',
  );
  assert.equal(modelClient.calls[0].maxAttempts, 1);
  assert.match(modelClient.calls[0].system, /重要-紧急矩阵分类模块/);
  const sentTasks = JSON.parse(modelClient.calls[0].user).tasks;
  assert.equal(sentTasks[0].due, '待确认');
  assert.equal(sentTasks[0].owner, '待确认');
});

test('两个同名不同 ID 的任务均被保留', async () => {
  const tasks = [task({ id: 'a', name: '提交方案' }), task({ id: 'b', name: '提交方案' })];
  const result = await classifyMatrix({
    tasks,
    modelClient: queuedModel([{
      classifications: tasks.map(item => classification(item)),
      note: '',
    }]),
  });
  assert.deepEqual(result.quadrants[0].taskIds, ['a', 'b']);
});

test('缺少或重复 taskId 时重试一次后拒绝', async () => {
  const tasks = [task({ id: 'a', classificationSource: 'unclassified', importance: null, urgency: null }),
    task({ id: 'b', classificationSource: 'unclassified', importance: null, urgency: null })];
  for (const invalid of [
    { classifications: [classification(tasks[0])], note: '' },
    {
      classifications: [classification(tasks[0]), classification(tasks[0])],
      note: '',
    },
  ]) {
    const modelClient = queuedModel([invalid, invalid]);
    await assert.rejects(
      classifyMatrix({ tasks, modelClient }),
      error => error.code === 'MODEL_OUTPUT_INVALID',
    );
    assert.equal(modelClient.calls.length, 2);
  }
});

test('单任务只占一个象限且其他三个象限为空', async () => {
  const onlyTask = task({ urgency: '低' });
  const result = await classifyMatrix({
    tasks: [onlyTask],
    modelClient: queuedModel([{
      classifications: [classification(onlyTask)],
      note: '',
    }]),
  });
  assert.deepEqual(result.quadrants.map(item => item.taskIds), [[], ['task-a'], [], []]);
});

test('五个第一象限任务产生过载提示', async () => {
  const tasks = Array.from({ length: 5 }, (_, index) => task({ id: `task-${index}` }));
  const result = await classifyMatrix({
    tasks,
    modelClient: queuedModel([{
      classifications: tasks.map(item => classification(item)),
      note: '',
    }]),
  });
  assert.match(result.note, /二次筛选|授权/);
});

test('四象限数值固定为 55、25、15、5', async () => {
  const tasks = [
    task({ id: 'q1' }),
    task({ id: 'q2', urgency: '中' }),
    task({ id: 'q3', importance: '中' }),
    task({ id: 'q4', importance: '低', urgency: '低' }),
  ];
  const result = await classifyMatrix({
    tasks,
    modelClient: queuedModel([{
      classifications: tasks.map(item => classification(item)),
      note: '',
    }]),
  });
  assert.deepEqual(result.quadrants.map(item => item.energyPercent), [55, 25, 15, 5]);
  assert.deepEqual(result.quadrants.map(item => item.taskIds), [['q1'], ['q2'], ['q3'], ['q4']]);
});

test('全部已分类时不调用模型，标签与象限由服务端确定性计算', async () => {
  const tasks = [
    task({ id: 'ai', importance: '高', urgency: '高', classificationSource: 'ai-extraction' }),
    task({ id: 'manual', importance: '低', urgency: '高', classificationSource: 'manual' }),
  ];
  const modelClient = queuedModel([]);
  const result = await classifyMatrix({ tasks, modelClient });
  assert.equal(modelClient.calls.length, 0);
  assert.deepEqual(result.classifications.map(item => item.taskId), ['ai', 'manual']);
  assert.deepEqual(result.quadrants.map(item => item.taskIds), [['ai'], [], ['manual'], []]);
});

test('日期纠偏后的高紧急度进入第一或第三象限且标签保持不变', async () => {
  const tasks = [
    task({ id: 'important-due', importance: '高', urgency: '高' }),
    task({ id: 'delegated-due', importance: '低', urgency: '高' }),
  ];
  const result = await classifyMatrix({
    tasks,
    modelClient: queuedModel([{
      classifications: tasks.map(item => classification(item)),
      note: '',
    }]),
  });

  assert.deepEqual(result.quadrants[0].taskIds, ['important-due']);
  assert.deepEqual(result.quadrants[2].taskIds, ['delegated-due']);
  assert.deepEqual(
    result.classifications.map(item => [item.importance, item.urgency]),
    [['高', '高'], ['低', '高']],
  );
});

test('矩阵入口接受任务验收标准但不修改其分类契约', async () => {
  const item = task({
    acceptanceCriteria: ['形成 4 个模块'],
    nextAction: '先列出模块清单',
  });
  const result = await classifyMatrix({
    tasks: [item],
    modelClient: queuedModel([{
      classifications: [classification(item)],
      note: '',
    }]),
  });
  assert.deepEqual(result.quadrants[0].taskIds, ['task-a']);
});

test('未标注任务在模型返回后仍缺等级时拒绝结果', async () => {
  const tasks = [task({
    importance: null,
    urgency: null,
    classificationSource: 'unclassified',
  })];
  const invalid = {
    classifications: [{ taskId: 'task-a', importance: null, urgency: '高' }],
    note: '',
  };
  const modelClient = queuedModel([invalid, invalid]);
  await assert.rejects(
    classifyMatrix({ tasks, modelClient }),
    error => error.code === 'MODEL_OUTPUT_INVALID',
  );
});

test('输入中的标签来源与空值组合不一致时在模型前拒绝', async () => {
  const modelClient = queuedModel([{ classifications: [], note: '' }]);
  await assert.rejects(
    classifyMatrix({
      tasks: [task({ importance: null, classificationSource: 'ai-extraction' })],
      modelClient,
    }),
    error => error.code === 'INPUT_INVALID',
  );
  assert.equal(modelClient.calls.length, 0);
});

test('POST /api/time-management/matrix/classify 返回确定性矩阵', async () => {
  const { createApp } = require('../../server/app');
  const tasks = [task()];
  const app = createApp({ authBoundary: createTestAuthBoundary(), modelClient: queuedModel([{
    classifications: tasks.map(item => classification(item)),
    note: '',
  }]) });
  const server = await listen(app);

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/time-management/matrix/classify`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tasks }),
      },
    );
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload.quadrants[0].taskIds, ['task-a']);
  } finally {
    await close(server);
  }
});
