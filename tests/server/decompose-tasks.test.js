const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const { loadVersionedPrompt } = require('../../server/prompts/load-versioned-prompt');
const {
  applyCriticFindings,
  compileTasksFromClusters,
  decomposeTasks,
} = require('../../server/workflows/decompose-tasks');

// 单个 FactAtom：quote 必须是 entries 对应行原文的子串，且该行必须被至少一个 atom 覆盖
function atom(dimension, overrides = {}) {
  return {
    id: `atom-${dimension}-${overrides.sourceLineIndex ?? 0}`,
    dimension,
    sourceLineIndex: 0,
    quote: '',
    kind: 'work',
    action: '',
    actor: { role: 'unknown', name: '' },
    dueRef: '',
    status: 'planned',
    relatedTo: '',
    confidence: { actor: 0, due: 0, status: 0 },
    ...overrides,
  };
}

// 按维度返回 atoms 的模型客户端，同时处理 reconciliation 调用
function evidenceModel(byDimension = {}, { delayMs = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async completeJson(request) {
      calls.push(request);
      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      const input = JSON.parse(request.user);
      // Evidence agent call: has dimension field
      if (input.dimension !== undefined) {
        return { dimension: input.dimension, atoms: byDimension[input.dimension] || [] };
      }
      // Reconciliation call: has atoms field
      if (input.atoms !== undefined) {
        return { clusters: [], conflicts: [] };
      }
      // Critic call: has tasks field → return empty findings
      return { findings: [] };
    },
  };
}

// 按维度返回 atoms 的模型客户端（仅 evidence，不含 reconciliation）
function evidenceOnlyModel(byDimension = {}, opts = {}) {
  const model = evidenceModel(byDimension, opts);
  const orig = model.completeJson.bind(model);
  model.completeJson = async function (request) {
    const input = JSON.parse(request.user);
    if (input.dimension === undefined) {
      throw new Error('Unexpected non-evidence call');
    }
    return orig(request);
  };
  return model;
}

test('正常拆解每个非空维度一次模型调用返回可追溯任务', async () => {
  const modelClient = evidenceModel({
    昨天: [atom('昨天', { quote: '昨天未完成审核方案', action: '审核方案' })],
  });
  const result = await decomposeTasks({
    entries: { 昨天: '昨天未完成审核方案', 今天: '', 明天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-08-03T04:00:00.000Z'),
  });

  const evidenceCalls = modelClient.calls.filter(c => c.responseSchemaName === 'time_evidence_atomization_v1');
  assert.equal(evidenceCalls.length, 1);
  assert.equal(evidenceCalls[0].responseSchemaName, 'time_evidence_atomization_v1');
  assert.doesNotMatch(evidenceCalls[0].system, /昨天未完成审核方案/);
  assert.match(evidenceCalls[0].user, /昨天未完成审核方案/);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].source, '复盘');
  assert.equal(result.tasks[0].name, '审核方案');
  assert.equal(result.tasks[0].owner, '待确认');
  assert.equal(result.tasks[0].due, '待确认');
  assert.equal(result.decomposition.pipelineVersion, 'multi-agent-v2-phase3');
  assert.equal(result.decomposition.businessDate, '2026-08-03');
  assert.match(result.decomposition.decompositionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(result.decomposition.taskAtoms, [{
    taskId: result.tasks[0].id,
    atomId: 'atom-昨天-0',
  }]);
  assert.equal(result.decomposition.stages[0].name, 'evidence-agents');
  assert.equal(result.decomposition.stages[0].status, 'succeeded');
  assert.equal(result.decomposition.stages[0].attempts, 1);
  assert.deepEqual(
    Object.keys(result.decomposition.stages[0].output),
    ['昨天', '今天', '明天', '后天'],
  );
  assert.equal(result.decomposition.stages[0].output['昨天'].length, 1);
  assert.deepEqual(result.decomposition.stages[0].output['今天'], []);
});

test('四个维度的证据 agent 并行执行', async () => {
  const byDimension = {
    昨天: [atom('昨天', { quote: '昨天未完成审核方案', action: '审核方案' })],
    今天: [atom('今天', {
      quote: '今天18:00前提交排期表',
      action: '提交排期表',
      dueRef: '今天18:00前',
    })],
    明天: [atom('明天', { quote: '明天完成市场调研', action: '完成市场调研' })],
    后天: [atom('后天', { quote: '后天输出年度规划', action: '输出年度规划' })],
  };
  const modelClient = evidenceModel(byDimension, { delayMs: 60 });
  const startedAt = Date.now();
  const result = await decomposeTasks({
    entries: {
      昨天: '昨天未完成审核方案',
      今天: '今天18:00前提交排期表',
      明天: '明天完成市场调研',
      后天: '后天输出年度规划',
    },
    modelClient,
    now: () => new Date('2026-08-03T04:00:00.000Z'),
  });
  const elapsedMs = Date.now() - startedAt;

  const evidenceCalls2 = modelClient.calls.filter(c => c.responseSchemaName === 'time_evidence_atomization_v1');
  assert.equal(evidenceCalls2.length, 4);
  assert.deepEqual(
    new Set(evidenceCalls2.map(call => JSON.parse(call.user).dimension)),
    new Set(['昨天', '今天', '明天', '后天']),
  );
  // 并行证据(60ms) + reconciliation(~60ms) + 并行 critic(~60ms) ≈ 180ms
  assert.ok(elapsedMs < 400, `并行耗时异常：${elapsedMs}ms`);
  assert.equal(result.decomposition.stages[0].name, 'evidence-agents');
  assert.equal(result.decomposition.stages[0].attempts, 4);
  assert.equal(result.tasks.length, 4);
  assert.deepEqual(
    new Set(result.decomposition.taskAtoms.map(item => item.atomId)),
    new Set(['atom-昨天-0', 'atom-今天-0', 'atom-明天-0', 'atom-后天-0']),
  );
});

test('atom quote 不在指定行时重试一次后拒绝', async () => {
  const modelClient = evidenceModel({
    昨天: [atom('昨天', { quote: '原文不存在的内容' })],
  });

  await assert.rejects(
    decomposeTasks({
      entries: { 昨天: '昨天未完成审核方案', 今天: '', 明天: '', 后天: '' },
      modelClient,
    }),
    error => error.code === 'MODEL_OUTPUT_INVALID'
      && error.stage === 'evidence-agent'
      && error.failedRules.includes('EVIDENCE_QUOTE_NOT_IN_SOURCE_LINE'),
  );
  assert.equal(modelClient.calls.length, 2);
  assert.equal(modelClient.calls[1].responseSchemaName, 'time_evidence_atomization_v1');
  assert.deepEqual(
    JSON.parse(modelClient.calls[1].user).retryFeedback.failedRules,
    ['EVIDENCE_QUOTE_NOT_IN_SOURCE_LINE'],
  );
});

test('输入行未被任何 atom 覆盖时重试后拒绝', async () => {
  const modelClient = evidenceModel({
    昨天: [atom('昨天', { quote: '昨天未完成审核方案', action: '审核方案' })],
  });

  await assert.rejects(
    decomposeTasks({
      entries: { 昨天: '昨天未完成审核方案\n补充事项', 今天: '', 明天: '', 后天: '' },
      modelClient,
    }),
    error => error.code === 'MODEL_OUTPUT_INVALID'
      && error.failedRules.includes('INPUT_LINE_NOT_COVERED'),
  );
  assert.equal(modelClient.calls.length, 2);
});

test('跨维度 atom id 重复时拒绝', async () => {
  const modelClient = evidenceModel({
    昨天: [atom('昨天', { quote: '昨天未完成审核方案', action: '审核方案', id: 'dup' })],
    今天: [atom('今天', { quote: '今天18:00前提交排期表', action: '提交排期表', id: 'dup' })],
  });

  await assert.rejects(
    decomposeTasks({
      entries: {
        昨天: '昨天未完成审核方案',
        今天: '今天18:00前提交排期表',
        明天: '',
        后天: '',
      },
      modelClient,
    }),
    error => error.code === 'MODEL_OUTPUT_INVALID'
      && error.failedRules.includes('EVIDENCE_ID_DUPLICATED'),
  );
  assert.equal(modelClient.calls.length, 2);
});

test('reconciliation 失败时明确记录 one-to-one 回退模式', async () => {
  const modelClient = evidenceOnlyModel({
    今天: [atom('今天', {
      id: 'atom-fallback',
      quote: '今天提交排期表',
      action: '提交排期表',
    })],
  });
  const result = await decomposeTasks({
    entries: { 昨天: '', 今天: '今天提交排期表', 明天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  const stage = result.decomposition.stages.find(item => item.name === 'reconciliation');
  assert.equal(stage.status, 'degraded');
  assert.equal(stage.fallbackMode, 'one-to-one');
  assert.equal(result.tasks.length, 1);
});

test('kind=goal 与 kind=note 的原子不生成任务', async () => {
  const modelClient = evidenceModel({
    今天: [
      atom('今天', { quote: '本季度完成产品重构', action: '', kind: 'goal' }),
      atom('今天', {
        quote: '今天18:00前提交排期表',
        action: '提交排期表',
        sourceLineIndex: 1,
        dueRef: '今天18:00前',
      }),
      atom('今天', {
        quote: '备注：测试环境已恢复',
        action: '',
        kind: 'note',
        sourceLineIndex: 2,
      }),
    ],
  });

  const result = await decomposeTasks({
    entries: {
      昨天: '',
      今天: '本季度完成产品重构\n今天18:00前提交排期表\n备注：测试环境已恢复',
      明天: '',
      后天: '',
    },
    modelClient,
    now: () => new Date('2026-08-03T04:00:00.000Z'),
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].name, '提交排期表');
  assert.deepEqual(result.decomposition.taskAtoms, [{
    taskId: result.tasks[0].id,
    atomId: 'atom-今天-1',
  }]);
});

test('taskAtoms 对 work 原子 1:1 映射', async () => {
  const modelClient = evidenceModel({
    昨天: [atom('昨天', { quote: '昨天未完成审核方案', action: '审核方案' })],
    今天: [atom('今天', {
      quote: '今天18:00前提交排期表',
      action: '提交排期表',
      dueRef: '今天18:00前',
    })],
  });

  const result = await decomposeTasks({
    entries: {
      昨天: '昨天未完成审核方案',
      今天: '今天18:00前提交排期表',
      明天: '',
      后天: '',
    },
    modelClient,
    now: () => new Date('2026-08-03T04:00:00.000Z'),
  });

  assert.equal(result.tasks.length, 2);
  assert.deepEqual(result.decomposition.taskAtoms, result.tasks.map((task, index) => ({
    taskId: task.id,
    atomId: index === 0 ? 'atom-昨天-0' : 'atom-今天-0',
  })));
  assert.equal(result.tasks[0].source, '复盘');
  assert.equal(result.tasks[1].source, '今天');
});

test('全部原子均非 work 时返回 NO_ACTIONABLE_TASKS', async () => {
  const modelClient = evidenceModel({
    今天: [atom('今天', { quote: '本季度完成产品重构', action: '', kind: 'goal' })],
  });

  await assert.rejects(
    decomposeTasks({
      entries: { 昨天: '', 今天: '本季度完成产品重构', 明天: '', 后天: '' },
      modelClient,
    }),
    error => error.code === 'NO_ACTIONABLE_TASKS' && error.status === 422,
  );
});

test('快速拆解最多接受 12 个非空行', async () => {
  const modelClient = evidenceModel({});
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
  const agent = loadVersionedPrompt('decomposition.evidence-agent');
  assert.equal(agent.version, '1.0.0');
  assert.match(agent.sha256, /^[0-9a-f]{64}$/);
  assert.match(agent.text, /sourceLineIndex/);
  assert.match(agent.text, /kind/);
  assert.match(agent.text, /retryFeedback/);
  assert.doesNotMatch(agent.text, /\{\{include:/);
  const promptRoot = path.join(__dirname, '..', '..', 'prompts');
  assert.match(
    readFileSync(path.join(promptRoot, 'decomposition', 'evidence-agent.v1.md'), 'utf8'),
    /FactAtom/,
  );
  assert.strictEqual(
    loadVersionedPrompt('decomposition.evidence-agent'),
    agent,
  );
});

// multi-agent Phase 1 流水线：每个维度一个证据 agent 返回 FactAtom，任务由服务端确定性编译
function factAtomOutput(overrides = {}) {
  const dimension = overrides.dimension || '今天';
  return {
    dimension,
    atoms: [{
      id: 'atom-1',
      dimension,
      sourceLineIndex: 0,
      quote: '由王芳负责今天18:00前提交新版排期表。',
      kind: 'work',
      action: '提交新版排期表',
      actor: { role: 'explicit', name: '王芳' },
      dueRef: '今天18:00前',
      status: 'planned',
      relatedTo: '',
      confidence: { actor: 1, due: 1, status: 1 },
      ...overrides,
    }],
  };
}

test('证据 agent 遗漏 owner 时服务端确定性恢复：由王芳负责 → owner=王芳 due=当天', async () => {
  const output = factAtomOutput({ actor: { role: 'unknown', name: '' } });
  const modelClient = evidenceModel({ 今天: output.atoms });
  const result = await decomposeTasks({
    entries: { 昨天: '', 今天: '由王芳负责今天18:00前提交新版排期表。', 明天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-08-03T04:00:00.000Z'), // 2026-08-03 上海周一
  });

  const evCalls = modelClient.calls.filter(c => c.responseSchemaName === 'time_evidence_atomization_v1');
  assert.equal(evCalls.length, 1);
  assert.equal(evCalls[0].responseSchemaName, 'time_evidence_atomization_v1');
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].owner, '王芳');
  assert.equal(result.tasks[0].due, '2026-08-03');
  assert.equal(result.tasks[0].dueTime, '18:00');
});

test('证据 agent 无明确 owner 语法时 owner 保持待确认', async () => {
  const output = factAtomOutput({
    quote: '今天18:00前提交新版排期表。',
    actor: { role: 'unknown', name: '' },
  });
  const modelClient = evidenceModel({ 今天: output.atoms });
  const result = await decomposeTasks({
    entries: { 昨天: '', 今天: '今天18:00前提交新版排期表。', 明天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-08-03T04:00:00.000Z'),
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].owner, '待确认');
  assert.equal(result.tasks[0].due, '2026-08-03');
});

test('证据 agent 明确给出 actor 时保留，服务端不覆盖', async () => {
  const output = factAtomOutput({ quote: '王芳今天18:00前提交新版排期表。' });
  const modelClient = evidenceModel({ 今天: output.atoms });
  const result = await decomposeTasks({
    entries: { 昨天: '', 今天: '王芳今天18:00前提交新版排期表。', 明天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-08-03T04:00:00.000Z'),
  });

  assert.equal(result.tasks[0].owner, '王芳');
  assert.equal(result.tasks[0].due, '2026-08-03');
});

test('明确工时表达从 FactAtom 保留到规范任务', async () => {
  const modelClient = evidenceModel({
    今天: [
      atom('今天', {
        id: 'atom-hours',
        sourceLineIndex: 0,
        quote: '今天完成排期表，预计1.5小时',
        action: '完成排期表',
        estimateRef: '预计1.5小时',
      }),
      atom('今天', {
        id: 'atom-minutes',
        sourceLineIndex: 1,
        quote: '今天回复客户，预计30分钟',
        action: '回复客户',
        estimateRef: '预计30分钟',
      }),
    ],
  });

  const result = await decomposeTasks({
    entries: {
      昨天: '',
      今天: '今天完成排期表，预计1.5小时\n今天回复客户，预计30分钟',
      明天: '',
      后天: '',
    },
    modelClient,
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  assert.deepEqual(result.tasks.map(task => task.est), ['1.5h', '30分钟']);
});

test('未来明确行动保留验收条件和下一步', async () => {
  const modelClient = evidenceModel({
    明天: [atom('明天', {
      id: 'atom-acceptance',
      quote: '明天提交验收清单，清单需覆盖接口、性能和回滚方案',
      action: '提交验收清单',
      dueRef: '明天',
      acceptanceCriteria: ['覆盖接口、性能和回滚方案'],
    })],
    后天: [atom('后天', {
      id: 'atom-next-action',
      quote: '2026-12-31前建立人才梯队机制，预计16h，先列出4个关键岗位和备份人选',
      action: '建立人才梯队机制',
      dueRef: '2026-12-31',
      estimateRef: '预计16h',
      nextActionRef: '先列出4个关键岗位和备份人选',
    })],
  });

  const result = await decomposeTasks({
    entries: {
      昨天: '',
      今天: '',
      明天: '明天提交验收清单，清单需覆盖接口、性能和回滚方案',
      后天: '2026-12-31前建立人才梯队机制，预计16h，先列出4个关键岗位和备份人选',
    },
    modelClient,
    now: () => new Date('2026-07-28T04:00:00.000Z'),
  });

  const checklist = result.tasks.find(task => task.name === '提交验收清单');
  assert.equal(checklist.source, '短期目标');
  assert.equal(checklist.due, '2026-07-29');
  assert.deepEqual(checklist.acceptanceCriteria, ['覆盖接口、性能和回滚方案']);

  const pipeline = result.tasks.find(task => task.name === '建立人才梯队机制');
  assert.equal(pipeline.source, '中长期');
  assert.equal(pipeline.due, '2026-12-31');
  assert.equal(pipeline.est, '16h');
  assert.equal(pipeline.nextAction, '先列出4个关键岗位和备份人选');
});

test('同一行多个独立动作由多个 FactAtom 编译为多条任务', async () => {
  const source = '2026-07-31前完成管理课程训练材料：形成4个模块，组织2次模拟，结业评分不低于80分';
  const modelClient = evidenceModel({
    明天: [
      atom('明天', {
        id: 'atom-modules',
        quote: '形成4个模块',
        action: '形成管理课程4个模块',
        dueRef: '2026-07-31',
        acceptanceCriteria: ['形成4个模块'],
      }),
      atom('明天', {
        id: 'atom-simulations',
        quote: '组织2次模拟，结业评分不低于80分',
        action: '组织2次课程模拟',
        dueRef: '2026-07-31',
        acceptanceCriteria: ['组织2次模拟', '结业评分不低于80分'],
      }),
    ],
  });

  const result = await decomposeTasks({
    entries: { 昨天: '', 今天: '', 明天: source, 后天: '' },
    modelClient,
    now: () => new Date('2026-07-28T04:00:00.000Z'),
  });

  assert.deepEqual(result.tasks.map(task => task.name), [
    '形成管理课程4个模块',
    '组织2次课程模拟',
  ]);
  assert.deepEqual(result.tasks[1].acceptanceCriteria, [
    '组织2次模拟',
    '结业评分不低于80分',
  ]);
});

test('cluster 编译优先选择今天的计划行动而不是昨天遗留作为主任务', () => {
  const atoms = [
    atom('昨天', {
      id: 'atom-yesterday-primary',
      quote: '昨天排期表未完成',
      action: '完成排期表',
      status: 'unfinished',
    }),
    atom('今天', {
      id: 'atom-today-primary',
      quote: '今天由王芳继续完成排期表',
      action: '完成排期表',
      actor: { role: 'explicit', name: '王芳' },
      status: 'planned',
    }),
  ];
  const result = compileTasksFromClusters({
    clusters: [{
      id: 'cluster-primary',
      label: '完成排期表',
      atomIds: ['atom-yesterday-primary', 'atom-today-primary'],
      relations: [{
        fromAtom: 'atom-yesterday-primary',
        toAtom: 'atom-today-primary',
        type: 'continuation',
        rationale: '今天继续昨天遗留',
      }],
      mergedOwner: { name: '王芳', source: 'explicit' },
      mergedDueRef: '',
      mergedStatus: 'both',
    }],
    conflicts: [],
    atoms,
    byDimension: {
      昨天: [atoms[0]], 今天: [atoms[1]], 明天: [], 后天: [],
    },
    entries: {
      昨天: '昨天排期表未完成',
      今天: '今天由王芳继续完成排期表',
      明天: '',
      后天: '',
    },
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  assert.equal(result.tasks[0].source, '今天');
  assert.equal(result.tasks[0].owner, '王芳');
});

test('human_needed 的 owner 与 due 冲突不会被编译成确定事实', () => {
  const atoms = [
    atom('今天', {
      id: 'atom-owner-a',
      quote: '由王芳负责今天18:00前提交排期表',
      action: '提交排期表',
      actor: { role: 'explicit', name: '王芳' },
      dueRef: '今天18:00前',
    }),
    atom('明天', {
      id: 'atom-owner-b',
      quote: '由李明负责明天10:00前提交排期表',
      action: '提交排期表',
      actor: { role: 'explicit', name: '李明' },
      dueRef: '明天10:00前',
    }),
  ];
  const conflicts = [
    {
      atomIds: ['atom-owner-a', 'atom-owner-b'],
      field: 'owner',
      description: '存在两个明确责任人',
      resolution: 'human_needed',
    },
    {
      atomIds: ['atom-owner-a', 'atom-owner-b'],
      field: 'due',
      description: '存在两个不同期限',
      resolution: 'human_needed',
    },
  ];
  const result = compileTasksFromClusters({
    clusters: [{
      id: 'cluster-conflict',
      label: '提交排期表',
      atomIds: ['atom-owner-a', 'atom-owner-b'],
      relations: [{
        fromAtom: 'atom-owner-a',
        toAtom: 'atom-owner-b',
        type: 'conflict',
        rationale: '责任人和期限冲突',
      }],
      mergedOwner: { name: '', source: 'conflict' },
      mergedDueRef: '今天18:00前',
      mergedStatus: 'planned',
    }],
    conflicts,
    atoms,
    byDimension: {
      昨天: [], 今天: [atoms[0]], 明天: [atoms[1]], 后天: [],
    },
    entries: {
      昨天: '',
      今天: '由王芳负责今天18:00前提交排期表',
      明天: '由李明负责明天10:00前提交排期表',
      后天: '',
    },
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  assert.equal(result.tasks[0].owner, '待确认');
  assert.equal(result.tasks[0].due, '待确认');
  assert.equal(result.tasks[0].dueTime, undefined);
  assert.equal(result.compiledItems[0].reviewRequired, true);
  assert.deepEqual(result.compiledItems[0].unresolvedFields, ['owner', 'due']);
});

test('critic blocker 会清除错误 owner/due 并标记任务需要确认', () => {
  const task = {
    id: 'task-governed',
    name: '提交排期表',
    source: '今天',
    due: '2026-08-04',
    dueTime: '18:00',
    est: '1h',
    owner: '王芳',
    importance: null,
    urgency: null,
    acceptanceCriteria: [],
    nextAction: '',
    status: 'pending',
    classificationSource: 'unclassified',
  };
  const compiled = {
    tasks: [task],
    compiledItems: [{
      task,
      clusterId: 'cluster-governed',
      atomIds: ['atom-governed'],
      reviewRequired: false,
      unresolvedFields: [],
    }],
    taskAtoms: [{
      taskId: task.id,
      clusterId: 'cluster-governed',
      atomId: 'atom-governed',
    }],
  };
  const result = applyCriticFindings(compiled, [
    {
      severity: 'blocker',
      category: 'owner_hallucination',
      description: '责任人不是执行者',
      taskIds: [task.id],
      atomIds: ['atom-governed'],
    },
    {
      severity: 'blocker',
      category: 'due_contamination',
      description: '期限来自其他任务',
      taskIds: [task.id],
      atomIds: ['atom-governed'],
    },
    {
      severity: 'blocker',
      category: 'missing_evidence',
      description: '任务证据不足',
      taskIds: [task.id],
      atomIds: [],
    },
  ]);

  assert.equal(result.governanceStatus, 'needs_confirmation');
  assert.equal(result.tasks[0].owner, '待确认');
  assert.equal(result.tasks[0].due, '待确认');
  assert.equal(result.tasks[0].dueTime, undefined);
  assert.equal(result.compiledItems[0].reviewRequired, true);
  assert.deepEqual(result.compiledItems[0].unresolvedFields, ['owner', 'due', 'evidence']);
});

test('cluster 编译保留全部 atom lineage 且未完整分类的任务标记为 unclassified', () => {
  const atoms = [
    atom('昨天', {
      id: 'atom-yesterday',
      quote: '昨天排期表未完成',
      action: '完成排期表',
      status: 'unfinished',
    }),
    atom('今天', {
      id: 'atom-today',
      quote: '今天继续完成排期表',
      action: '完成排期表',
      status: 'planned',
    }),
  ];
  const result = compileTasksFromClusters({
    clusters: [{
      id: 'cluster-schedule',
      label: '完成排期表',
      atomIds: ['atom-yesterday', 'atom-today'],
      relations: [{
        fromAtom: 'atom-yesterday',
        toAtom: 'atom-today',
        type: 'continuation',
        rationale: '今天继续昨天未完成事项',
      }],
      mergedOwner: { name: '', source: 'implied' },
      mergedDueRef: '',
      mergedStatus: 'both',
    }],
    atoms,
    byDimension: {
      昨天: [atoms[0]], 今天: [atoms[1]], 明天: [], 后天: [],
    },
    entries: {
      昨天: '昨天排期表未完成',
      今天: '今天继续完成排期表',
      明天: '',
      后天: '',
    },
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].classificationSource, 'unclassified');
  assert.equal(result.compiledItems.length, 1);
  assert.deepEqual(result.compiledItems[0].atomIds, ['atom-yesterday', 'atom-today']);
  assert.equal(result.compiledItems[0].clusterId, 'cluster-schedule');
  assert.deepEqual(result.taskAtoms, [
    {
      taskId: result.tasks[0].id,
      clusterId: 'cluster-schedule',
      atomId: 'atom-yesterday',
    },
    {
      taskId: result.tasks[0].id,
      clusterId: 'cluster-schedule',
      atomId: 'atom-today',
    },
  ]);
});
