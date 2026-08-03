const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const { loadVersionedPrompt } = require('../../server/prompts/load-versioned-prompt');
const { decomposeTasks } = require('../../server/workflows/decompose-tasks');

function evidence(overrides = {}) {
  return {
    id: 'E1',
    dimension: '昨天',
    sourceLineIndex: 0,
    quote: '昨天未完成审核方案',
    observation: '审核方案尚未完成',
    kind: 'work',
    status: 'unfinished',
    owner: '待确认',
    due: '待确认',
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    name: '审核方案',
    importance: '中',
    urgency: '高',
    source: '复盘',
    due: '待确认',
    est: '1h',
    owner: '待确认',
    acceptanceCriteria: [],
    nextAction: '',
    status: 'pending',
    evidenceIds: ['E1'],
    ...overrides,
  };
}

function taskFirst(overrides = {}) {
  return {
    evidence: [evidence()],
    tasks: [task()],
    ...overrides,
  };
}

function queuedModel(outputs) {
  const calls = [];
  return {
    calls,
    async completeJson(input) {
      calls.push(input);
      const output = outputs[Math.min(calls.length - 1, outputs.length - 1)];
      return typeof output === 'function' ? output(input) : output;
    },
  };
}

test('正常拆解一次模型调用返回可追溯任务', async () => {
  const modelClient = queuedModel([taskFirst()]);
  const result = await decomposeTasks({
    entries: { 昨天: '昨天未完成审核方案', 今天: '', 明天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-07-28T04:00:00.000Z'),
  });

  assert.equal(modelClient.calls.length, 1);
  assert.equal(
    modelClient.calls[0].responseSchemaName,
    'time_evidence_task_generation_v2',
  );
  assert.doesNotMatch(modelClient.calls[0].system, /昨天未完成审核方案/);
  assert.match(modelClient.calls[0].user, /昨天未完成审核方案/);
  assert.equal(result.tasks[0].source, '复盘');
  assert.equal(result.tasks[0].name, '审核方案');
  assert.equal(result.decomposition.pipelineVersion, 'task-first-v2');
  assert.match(result.decomposition.decompositionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(result.decomposition.taskEvidence, [{
    taskId: result.tasks[0].id,
    evidenceIds: ['E1'],
  }]);
  assert.equal(result.decomposition.stages[0].name, 'evidence-task-generation');
});

test('evidence 合法但任务遗漏时只重试冻结 evidence 的任务', async () => {
  const frozenEvidence = [evidence()];
  const modelClient = queuedModel([
    { evidence: frozenEvidence, tasks: [] },
    { tasks: [task()] },
  ]);

  const result = await decomposeTasks({
    entries: { 昨天: '昨天未完成审核方案', 今天: '', 明天: '', 后天: '' },
    modelClient,
  });

  assert.equal(modelClient.calls.length, 2);
  assert.equal(modelClient.calls[1].responseSchemaName, 'time_task_generation_v2');
  assert.deepEqual(JSON.parse(modelClient.calls[1].user).evidence, frozenEvidence);
  assert.deepEqual(result.decomposition.stages[0].output.evidence, frozenEvidence);
  assert.deepEqual(result.decomposition.stages[0].correctionPrompt, {
    id: 'decomposition.task-generation',
    version: '1.1.0',
    sha256: loadVersionedPrompt('decomposition.task-generation').sha256,
  });
});

test('evidence quote 不在指定行时联合重试后拒绝', async () => {
  const invalid = taskFirst({
    evidence: [evidence({ quote: '原文不存在的内容' })],
  });
  const modelClient = queuedModel([invalid, invalid]);

  await assert.rejects(
    decomposeTasks({
      entries: { 昨天: '昨天未完成审核方案', 今天: '', 明天: '', 后天: '' },
      modelClient,
    }),
    error => error.code === 'MODEL_OUTPUT_INVALID'
      && error.stage === 'evidence-task-generation'
      && error.failedRules.includes('EVIDENCE_QUOTE_NOT_IN_SOURCE_LINE'),
  );
  assert.equal(modelClient.calls.length, 2);
  assert.equal(
    modelClient.calls[1].responseSchemaName,
    'time_evidence_task_generation_v2',
  );
});

test('owner 不得从同栏另一行借用', async () => {
  const invalid = {
    evidence: [
      evidence({ owner: '张三' }),
      evidence({
        id: 'E2',
        sourceLineIndex: 1,
        quote: '张三跟进供应商',
        observation: '跟进供应商',
        status: 'planned',
        owner: '张三',
      }),
    ],
    tasks: [task()],
  };
  const modelClient = queuedModel([invalid, invalid]);

  await assert.rejects(
    decomposeTasks({
      entries: {
        昨天: '昨天未完成审核方案\n张三跟进供应商',
        今天: '',
        明天: '',
        后天: '',
      },
      modelClient,
    }),
    error => error.failedRules.includes('EVIDENCE_OWNER_NOT_IN_SOURCE_LINE'),
  );
});

test('今天 planned evidence 必须成为主任务', async () => {
  const modelClient = queuedModel([
    {
      evidence: [
        evidence(),
        evidence({
          id: 'E2',
          dimension: '今天',
          quote: '今天提交汇总结果',
          observation: '提交汇总结果',
          status: 'planned',
        }),
      ],
      tasks: [task()],
    },
    { tasks: [task()] },
  ]);

  await assert.rejects(
    decomposeTasks({
      entries: {
        昨天: '昨天未完成审核方案',
        今天: '今天提交汇总结果',
        明天: '',
        后天: '',
      },
      modelClient,
    }),
    error => error.failedRules.includes('ACTIONABLE_EVIDENCE_NOT_COVERED'),
  );
});

test('今天行动作为主要证据时可关联覆盖昨天遗留与计划', async () => {
  const modelClient = queuedModel([{
    evidence: [
      evidence({
        id: 'E1',
        quote: '目前还有2项措施没有明确负责人',
        observation: '仍有2项措施未明确负责人',
      }),
      evidence({
        id: 'E2',
        quote: '今天上午收集负责人意向',
        observation: '收集负责人意向',
        status: 'planned',
      }),
      evidence({
        id: 'E3',
        dimension: '今天',
        quote: '今天11:30前确认剩余2项措施负责人',
        observation: '确认剩余2项措施负责人',
        status: 'planned',
        due: '今天11:30前',
      }),
    ],
    tasks: [task({
      name: '确认剩余2项措施负责人',
      source: '今天',
      due: '2030-01-01',
      est: '30分钟',
      evidenceIds: ['E3', 'E1', 'E2'],
    })],
  }]);

  const result = await decomposeTasks({
    entries: {
      昨天: '目前还有2项措施没有明确负责人，今天上午收集负责人意向',
      今天: '今天11:30前确认剩余2项措施负责人',
      明天: '',
      后天: '',
    },
    modelClient,
    now: () => new Date('2026-07-29T04:00:00.000Z'),
  });

  assert.equal(modelClient.calls.length, 1);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].source, '今天');
  assert.equal(result.tasks[0].due, '2026-07-29');
  assert.equal(result.decomposition.stages[0].output.tasks[0].due, '今天11:30前');
  assert.deepEqual(result.decomposition.taskEvidence[0].evidenceIds, ['E3', 'E1', 'E2']);
});

test('无关的昨天 evidence 不能作为辅助证据规避覆盖校验', async () => {
  const invalidTask = task({
    name: '联系供应商',
    source: '今天',
    evidenceIds: ['E2', 'E1'],
  });
  const modelClient = queuedModel([
    {
      evidence: [
        evidence({
          id: 'E1',
          quote: '昨天未完成审核方案',
          observation: '审核方案尚未完成',
        }),
        evidence({
          id: 'E2',
          dimension: '今天',
          quote: '今天联系供应商',
          observation: '联系供应商',
          status: 'planned',
        }),
      ],
      tasks: [invalidTask],
    },
    { tasks: [invalidTask] },
  ]);

  await assert.rejects(
    decomposeTasks({
      entries: {
        昨天: '昨天未完成审核方案',
        今天: '今天联系供应商',
        明天: '',
        后天: '',
      },
      modelClient,
    }),
    error => error.failedRules.includes('TASK_AUXILIARY_EVIDENCE_UNRELATED'),
  );
});

test('owner 与 due 由主要 evidence 落地且不再要求模型生成', async () => {
  const { owner, due, ...modelTask } = task({
    name: '提交项目方案',
    source: '今天',
    evidenceIds: ['E1'],
  });
  const modelClient = queuedModel([{
    evidence: [evidence({
      dimension: '今天',
      quote: '张三今天18:00前提交项目方案',
      observation: '提交项目方案',
      status: 'planned',
      owner: '张三',
      due: '今天18:00前',
    })],
    tasks: [modelTask],
  }]);

  const result = await decomposeTasks({
    entries: {
      昨天: '',
      今天: '张三今天18:00前提交项目方案',
      明天: '',
      后天: '',
    },
    modelClient,
    now: () => new Date('2026-07-29T04:00:00.000Z'),
  });

  const modelTaskSchema = modelClient.calls[0].responseSchema.properties.tasks.items;
  assert.equal(modelTaskSchema.properties.owner, undefined);
  assert.equal(modelTaskSchema.properties.due, undefined);
  assert.equal(result.decomposition.stages[0].output.tasks[0].owner, '张三');
  assert.equal(result.decomposition.stages[0].output.tasks[0].due, '今天18:00前');
  assert.equal(result.tasks[0].owner, '张三');
  assert.equal(result.tasks[0].due, '2026-07-29');
});

test('主要 evidence 未提供截止时间时忽略模型虚构日期', async () => {
  const modelClient = queuedModel([{
    evidence: [evidence({
      dimension: '今天',
      quote: '提交项目方案',
      observation: '提交项目方案',
      status: 'planned',
    })],
    tasks: [task({
      name: '提交项目方案',
      source: '今天',
      due: '2030-01-01',
    })],
  }]);

  const result = await decomposeTasks({
    entries: { 昨天: '', 今天: '提交项目方案', 明天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-07-29T04:00:00.000Z'),
  });

  assert.equal(result.tasks[0].due, '待确认');
  assert.equal(result.decomposition.stages[0].output.tasks[0].due, '待确认');
});

test('completed evidence 不得出现在任务任一证据位置', async () => {
  const modelClient = queuedModel([
    {
      evidence: [
        evidence({
          quote: '昨天已完成审核方案',
          observation: '审核方案已完成',
          status: 'completed',
        }),
        evidence({
          id: 'E2',
          dimension: '今天',
          quote: '今天提交汇总结果',
          observation: '提交汇总结果',
          status: 'planned',
        }),
      ],
      tasks: [task({
        name: '提交汇总结果',
        source: '今天',
        evidenceIds: ['E2', 'E1'],
      })],
    },
    { tasks: [task({
      name: '提交汇总结果',
      source: '今天',
      evidenceIds: ['E2', 'E1'],
    })] },
  ]);

  await assert.rejects(
    decomposeTasks({
      entries: {
        昨天: '昨天已完成审核方案',
        今天: '今天提交汇总结果',
        明天: '',
        后天: '',
      },
      modelClient,
    }),
    error => error.failedRules.includes('NON_ACTIONABLE_EVIDENCE_USED'),
  );
});

test('快速拆解最多接受 12 个非空行', async () => {
  const modelClient = queuedModel([taskFirst()]);
  await assert.rejects(
    decomposeTasks({
      entries: {
        昨天: Array.from({ length: 13 }, (_, index) => `事项${index}`).join('\n'),
        今天: '',
        明天: '',
        后天: '',
      },
      modelClient,
    }),
    error => error.code === 'DECOMPOSITION_ITEM_LIMIT_EXCEEDED'
      && error.status === 422,
  );
  assert.equal(modelClient.calls.length, 0);
});

test('versioned prompts expose stable identity, version and content hash', () => {
  const tasks = loadVersionedPrompt('decomposition.evidence-task-generation');
  const correction = loadVersionedPrompt('decomposition.task-generation');
  const coaching = loadVersionedPrompt('decomposition.coaching-analysis');
  assert.equal(tasks.version, '2.1.0');
  assert.equal(correction.version, '1.1.0');
  assert.equal(coaching.version, '2.0.0');
  assert.match(tasks.sha256, /^[0-9a-f]{64}$/);
  assert.match(correction.sha256, /^[0-9a-f]{64}$/);
  assert.match(coaching.sha256, /^[0-9a-f]{64}$/);
  assert.match(tasks.text, /sourceLineIndex/);
  assert.match(tasks.text, /同一事项时，只生成一条任务/);
  assert.match(tasks.text, /不要求把每个修饰性原子事实单独拆出/);
  assert.match(tasks.text, /acceptanceCriteria 最多 3 条/);
  assert.match(tasks.text, /不要在 task 中输出 owner 或 due/);
  assert.match(correction.text, /与主要证据描述同一事项/);
  assert.doesNotMatch(tasks.text, /\{\{include:/);
  assert.doesNotMatch(correction.text, /\{\{include:/);
  const taskProtocol = tasks.text.match(/<task_protocol>[\s\S]*<\/task_protocol>/)?.[0];
  const correctionProtocol = correction.text.match(/<task_protocol>[\s\S]*<\/task_protocol>/)?.[0];
  assert.equal(taskProtocol, correctionProtocol);
  const promptRoot = path.join(__dirname, '..', '..', 'prompts', 'decomposition');
  assert.match(
    readFileSync(path.join(promptRoot, 'evidence-task-generation.v2.1.md'), 'utf8'),
    /\{\{include:decomposition\/task-policy\.v1\.1\.md\}\}/,
  );
  assert.match(
    readFileSync(path.join(promptRoot, 'task-generation.v1.1.md'), 'utf8'),
    /\{\{include:decomposition\/task-policy\.v1\.1\.md\}\}/,
  );
  assert.match(coaching.text, /证据不足/);
  assert.strictEqual(
    loadVersionedPrompt('decomposition.evidence-task-generation'),
    tasks,
  );
});

function todayCoach({ quote = '王芳今天18:00前提交新版排期表。', owner = '待确认', due = '待确认' } = {}) {
  return {
    evidence: [{
      id: 'E1',
      dimension: '今天',
      quote,
      observation: '提交新版排期表',
      kind: 'work',
      status: 'planned',
      owner,
      due,
    }],
    coachingAnalysis: analysisFor(['E1']),
  };
}

test('模型遗漏时服务端确定性恢复：王芳今天18:00前 → owner=王芳 due=当天', async () => {
  const modelClient = queuedModel([
    todayCoach(),
    generatedTasks([task({
      name: '提交新版排期表',
      source: '今天',
      due: '待确认',
      owner: '待确认',
    })]),
  ]);
  const result = await decomposeTasks({
    entries: { 昨天: '', 今天: '王芳今天18:00前提交新版排期表。', 明天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-08-03T04:00:00.000Z'), // 2026-08-03 上海周一
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].owner, '王芳');
  assert.equal(result.tasks[0].due, '2026-08-03');
});

test('模型给出明确期限时保留模型结果，服务端不覆盖', async () => {
  const modelClient = queuedModel([
    todayCoach({ owner: '王芳', due: '今天' }),
    generatedTasks([task({
      name: '提交新版排期表',
      source: '今天',
      due: '今天',
      owner: '王芳',
    })]),
  ]);
  const result = await decomposeTasks({
    entries: { 昨天: '', 今天: '王芳今天18:00前提交新版排期表。', 明天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-08-03T04:00:00.000Z'),
  });

  assert.equal(result.tasks[0].owner, '王芳');
  assert.equal(result.tasks[0].due, '2026-08-03');
});
