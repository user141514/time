const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const { loadVersionedPrompt } = require('../../server/prompts/load-versioned-prompt');
const {
  applyCriticFindings,
  compileTasksFromClusters,
  decomposeTasks,
  filterGroundedCriticFindings,
  mergeCrossSourceCompiledItems,
  normalizeReconciliationClusters,
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

test('模型删除 HTML 标签时服务端恢复原文连续 quote 并继续拆解', async () => {
  const modelClient = evidenceModel({
    今天: [atom('今天', {
      id: 'atom-html-quote',
      quote: '把API文档第5节翻译完',
      action: '翻译API文档第5节',
      dueRef: '今天18:00前',
      status: 'planned',
    })],
  });
  const source = "今天18:00前把<span class='urgent'>API文档</span>第5节翻译完并提交到共享目录";

  const result = await decomposeTasks({
    entries: { 昨天: '', 今天: source, 明天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  const evidence = result.decomposition.stages[0].output['今天'];
  assert.equal(evidence[0].quote, "把<span class='urgent'>API文档</span>第5节翻译完");
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].due, '2026-08-04');
  assert.equal(result.tasks[0].dueTime, '18:00');
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

test('并行 evidence agent 返回重复 atom id 时由服务端统一改写为唯一 ID', async () => {
  const modelClient = evidenceModel({
    昨天: [atom('昨天', { quote: '昨天未完成审核方案', action: '审核方案', id: 'dup' })],
    今天: [atom('今天', { quote: '今天18:00前提交排期表', action: '提交排期表', id: 'dup' })],
  });

  const result = await decomposeTasks({
    entries: {
      昨天: '昨天未完成审核方案',
      今天: '今天18:00前提交排期表',
      明天: '',
      后天: '',
    },
    modelClient,
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  const atomIds = result.decomposition.stages[0].output['昨天']
    .concat(result.decomposition.stages[0].output['今天'])
    .map(item => item.id);
  assert.equal(new Set(atomIds).size, 2);
  assert.equal(result.tasks.length, 2);
  assert.deepEqual(
    new Set(result.decomposition.taskAtoms.map(item => item.atomId)),
    new Set(atomIds),
  );
});

test('Evidence 模型把已完成事实误标为 unfinished work 时服务端阻止任务泄漏', async () => {
  const modelClient = evidenceModel({
    今天: [
      atom('今天', {
        id: 'completed-submit',
        quote: '今天已提交月度考勤汇总表',
        action: '提交月度考勤汇总表',
        dueRef: '今天',
        status: 'unfinished',
      }),
      atom('今天', {
        id: 'completed-review',
        quote: '全员绩效初评也已完成',
        action: '完成全员绩效初评',
        dueRef: '今天',
        status: 'unfinished',
      }),
    ],
  });

  await assert.rejects(
    decomposeTasks({
      entries: {
        昨天: '',
        今天: '今天已提交月度考勤汇总表，全员绩效初评也已完成。',
        明天: '',
        后天: '',
      },
      modelClient,
      now: () => new Date('2026-08-04T02:00:00.000Z'),
    }),
    error => error.code === 'NO_ACTIONABLE_TASKS',
  );
});

test('今天维度的裸时刻期限锚定到当天业务日期', async () => {
  const modelClient = evidenceModel({
    今天: [atom('今天', {
      id: 'today-bare-clock',
      quote: '下午4:30前把采购比价表发给财务部李总',
      action: '把采购比价表发给财务部李总',
      dueRef: '下午4:30前',
      status: 'planned',
    })],
  });

  const result = await decomposeTasks({
    entries: {
      昨天: '',
      今天: '下午4:30前把采购比价表发给财务部李总',
      明天: '',
      后天: '',
    },
    modelClient,
    now: () => new Date('2026-12-28T04:00:00.000Z'),
  });

  assert.equal(result.tasks[0].due, '2026-12-28');
  assert.equal(result.tasks[0].dueTime, '16:30');
});

test('明天维度的裸时刻期限锚定到下一业务日', async () => {
  const modelClient = evidenceModel({
    明天: [atom('明天', {
      id: 'tomorrow-bare-clock',
      quote: '下午3点前发送修改后的方案',
      action: '发送修改后的方案',
      dueRef: '下午3点前',
      status: 'planned',
    })],
  });

  const result = await decomposeTasks({
    entries: { 昨天: '', 今天: '', 明天: '下午3点前发送修改后的方案', 后天: '' },
    modelClient,
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  assert.equal(result.tasks[0].due, '2026-08-05');
  assert.equal(result.tasks[0].dueTime, '15:00');
});

test('Evidence 模型把今天栏句首标签误写为 dueRef 时服务端清除期限污染', async () => {
  const modelClient = evidenceModel({
    今天: [atom('今天', {
      id: 'today-prefix',
      quote: '今天整理知识库文章分类',
      action: '整理知识库文章分类',
      dueRef: '今天',
      status: 'planned',
    })],
  });

  const result = await decomposeTasks({
    entries: { 昨天: '', 今天: '今天整理知识库文章分类，预计2小时。', 明天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].due, '待确认');
  assert.equal(result.decomposition.stages[0].output['今天'][0].dueRef, '');
});

test('Evidence 模型错误状态由明确进行中信号纠正', async () => {
  const modelClient = evidenceModel({
    今天: [atom('今天', {
      id: 'in-progress',
      quote: '正在编写Q3运营分析报告',
      action: '编写Q3运营分析报告',
      status: 'unfinished',
    })],
  });

  const result = await decomposeTasks({
    entries: { 昨天: '', 今天: '正在编写Q3运营分析报告，目前已完成数据采集。', 明天: '', 后天: '' },
    modelClient,
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.decomposition.stages[0].output['今天'][0].status, 'in_progress');
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

test('cluster 中 note atom 的工时、验收条件和下一步会合并回规范任务', () => {
  const atoms = [
    atom('今天', {
      id: 'atom-work',
      quote: '今天由王芳负责在18:00前提交新版排期表',
      action: '提交新版排期表',
      actor: { role: 'explicit', name: '王芳' },
      dueRef: '18:00前',
    }),
    atom('今天', {
      id: 'atom-estimate-note',
      quote: '预计1小时',
      kind: 'note',
      action: '',
      estimateRef: '预计1小时',
      status: 'unknown',
    }),
    atom('今天', {
      id: 'atom-acceptance-note',
      quote: '验收标准：包含风险项和负责人',
      kind: 'note',
      action: '',
      acceptanceCriteria: ['包含风险项和负责人'],
      nextActionRef: '先核对风险项',
      status: 'unknown',
    }),
  ];

  const result = compileTasksFromClusters({
    clusters: [{
      id: 'cluster-metadata',
      label: '新版排期表',
      atomIds: atoms.map(item => item.id),
      relations: [],
      mergedOwner: { name: '王芳', source: 'explicit' },
      mergedDueRef: '18:00前',
      mergedStatus: 'planned',
    }],
    conflicts: [],
    atoms,
    byDimension: { 昨天: [], 今天: atoms, 明天: [], 后天: [] },
    entries: {
      昨天: '',
      今天: '今天由王芳负责在18:00前提交新版排期表，预计1小时，验收标准：包含风险项和负责人，下一步：先核对风险项',
      明天: '',
      后天: '',
    },
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  assert.equal(result.tasks[0].owner, '王芳');
  assert.equal(result.tasks[0].due, '2026-08-04');
  assert.equal(result.tasks[0].dueTime, '18:00');
  assert.equal(result.tasks[0].est, '1h');
  assert.deepEqual(result.tasks[0].acceptanceCriteria, ['包含风险项和负责人']);
  assert.equal(result.tasks[0].nextAction, '先核对风险项');
});

test('同维度 dependency 或 continuation work atoms 被拆成独立 clusters', () => {
  const atoms = [
    atom('今天', {
      id: 'atom-step-1',
      quote: '跟产品经理对齐需求',
      action: '跟产品经理对齐需求',
    }),
    atom('今天', {
      id: 'atom-step-2',
      quote: '找后端确认接口方案',
      action: '找后端确认接口方案',
    }),
    atom('今天', {
      id: 'atom-step-3',
      quote: '把排期同步给全员',
      action: '把排期同步给全员',
    }),
  ];
  const result = normalizeReconciliationClusters({
    atoms,
    conflicts: [],
    clusters: [{
      id: 'cluster-chain',
      label: '需求对齐与排期同步',
      atomIds: atoms.map(item => item.id),
      relations: [
        { fromAtom: 'atom-step-1', toAtom: 'atom-step-2', type: 'dependency', rationale: '先对齐再确认' },
        { fromAtom: 'atom-step-2', toAtom: 'atom-step-3', type: 'continuation', rationale: '最后同步' },
      ],
      mergedOwner: { name: '', source: 'implied' },
      mergedDueRef: '',
      mergedStatus: 'planned',
    }],
  });

  assert.equal(result.clusters.length, 3);
  assert.deepEqual(
    result.clusters.map(cluster => cluster.atomIds),
    [['atom-step-1'], ['atom-step-2'], ['atom-step-3']],
  );
});

test('内容产出与提交到存储位置保持同一任务并继承提交期限', () => {
  const atoms = [
    atom('今天', {
      id: 'atom-translate-main',
      quote: "把<span class='urgent'>API文档</span>第5节翻译完",
      action: '翻译API文档第5节',
      status: 'planned',
    }),
    atom('今天', {
      id: 'atom-translate-submit',
      quote: '今天18:00前提交到共享目录',
      action: '提交到共享目录',
      dueRef: '今天18:00前',
      status: 'planned',
    }),
  ];
  const normalized = normalizeReconciliationClusters({
    atoms,
    conflicts: [],
    clusters: [{
      id: 'cluster-translate-delivery',
      label: '翻译API文档第5节',
      atomIds: atoms.map(item => item.id),
      relations: [{
        fromAtom: 'atom-translate-main',
        toAtom: 'atom-translate-submit',
        type: 'dependency',
        rationale: '提交依赖翻译完成',
      }],
      mergedOwner: { name: '', source: 'implied' },
      mergedDueRef: '今天18:00前',
      mergedStatus: 'planned',
    }],
  });
  const result = compileTasksFromClusters({
    ...normalized,
    atoms,
    byDimension: { 昨天: [], 今天: atoms, 明天: [], 后天: [] },
    entries: {
      昨天: '',
      今天: "把<span class='urgent'>API文档</span>第5节翻译完，今天18:00前提交到共享目录",
      明天: '',
      后天: '',
    },
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].name, '翻译API文档第5节并提交到共享目录');
  assert.equal(result.tasks[0].due, '2026-08-04');
  assert.equal(result.tasks[0].dueTime, '18:00');
});

test('主交付与发邮件审阅附加动作保持同一任务并继承附加动作期限', () => {
  const atoms = [
    atom('今天', {
      id: 'atom-report-main',
      quote: '今天完成竞品分析报告',
      action: '完成竞品分析报告',
      status: 'planned',
    }),
    atom('今天', {
      id: 'atom-report-review',
      quote: '下午4点前发邮件给赵总监审阅',
      action: '发邮件给赵总监审阅',
      dueRef: '下午4点前',
      status: 'planned',
    }),
  ];
  const normalized = normalizeReconciliationClusters({
    atoms,
    conflicts: [],
    clusters: [{
      id: 'cluster-report-review',
      label: '竞品分析报告',
      atomIds: atoms.map(item => item.id),
      relations: [{
        fromAtom: 'atom-report-main',
        toAtom: 'atom-report-review',
        type: 'dependency',
        rationale: '审阅依赖报告完成',
      }],
      mergedOwner: { name: '', source: 'implied' },
      mergedDueRef: '下午4点前',
      mergedStatus: 'planned',
    }],
  });
  const result = compileTasksFromClusters({
    ...normalized,
    atoms,
    byDimension: { 昨天: [], 今天: atoms, 明天: [], 后天: [] },
    entries: {
      昨天: '',
      今天: '今天完成竞品分析报告，下午4点前发邮件给赵总监审阅。',
      明天: '',
      后天: '',
    },
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].name, '完成竞品分析报告并发邮件给赵总监审阅');
  assert.equal(result.tasks[0].owner, '待确认');
  assert.equal(result.tasks[0].due, '2026-08-04');
  assert.equal(result.tasks[0].dueTime, '16:00');
});

test('模型将抄送附加动作标成 note 时任务名仍保留该动作', () => {
  const compiled = compileTasksFromClusters({
    atoms: [
      atom('今天', { id: 'atom-report', quote: '提交Q3预算方案', action: '提交Q3预算方案' }),
      atom('今天', { id: 'atom-cc-note', quote: '并抄送财务部', kind: 'note', action: '', status: 'unknown' }),
    ],
    byDimension: {},
    entries: { 昨天: '', 今天: '提交Q3预算方案，并抄送财务部。', 明天: '', 后天: '' },
    now: () => new Date('2026-08-04T02:00:00.000Z'),
    conflicts: [],
    clusters: [{
      id: 'cluster-report-note',
      label: 'Q3预算方案提交',
      atomIds: ['atom-report', 'atom-cc-note'],
      relations: [{ fromAtom: 'atom-report', toAtom: 'atom-cc-note', type: 'same_work_item', rationale: '抄送是提交附加动作' }],
      mergedOwner: { name: '', source: 'implied' },
      mergedDueRef: '',
      mergedStatus: 'planned',
    }],
  });

  assert.equal(compiled.tasks.length, 1);
  assert.equal(compiled.tasks[0].name, '提交Q3预算方案并抄送财务部');
});

test('同维度主动作与抄送附加动作保持同一 cluster 并合并任务名', () => {
  const atoms = [
    atom('今天', {
      id: 'atom-budget-submit',
      quote: '提交Q3预算方案（含人力成本和设备采购明细）',
      action: '提交Q3预算方案',
      acceptanceCriteria: ['含人力成本和设备采购明细'],
    }),
    atom('今天', {
      id: 'atom-budget-copy',
      quote: '并抄送财务部',
      action: '抄送财务部',
    }),
  ];
  const normalized = normalizeReconciliationClusters({
    atoms,
    conflicts: [],
    clusters: [{
      id: 'cluster-budget',
      label: '提交Q3预算方案',
      atomIds: atoms.map(item => item.id),
      relations: [{
        fromAtom: 'atom-budget-submit',
        toAtom: 'atom-budget-copy',
        type: 'dependency',
        rationale: '抄送依赖提交',
      }],
      mergedOwner: { name: '', source: 'implied' },
      mergedDueRef: '',
      mergedStatus: 'planned',
    }],
  });

  assert.equal(normalized.clusters.length, 1);
  const result = compileTasksFromClusters({
    ...normalized,
    atoms,
    byDimension: { 昨天: [], 今天: atoms, 明天: [], 后天: [] },
    entries: {
      昨天: '',
      今天: '提交Q3预算方案（含人力成本和设备采购明细），并抄送财务部',
      明天: '',
      后天: '',
    },
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].name, '提交Q3预算方案并抄送财务部');
  assert.deepEqual(result.tasks[0].acceptanceCriteria, ['含人力成本和设备采购明细']);
});

test('同维度 duplicate 或 same_work_item atoms 保持同一 cluster', () => {
  const atoms = [
    atom('今天', { id: 'atom-dup-1', quote: '提交周报', action: '提交周报' }),
    atom('今天', { id: 'atom-dup-2', quote: '再次提交周报', action: '提交周报' }),
  ];
  const result = normalizeReconciliationClusters({
    atoms,
    conflicts: [],
    clusters: [{
      id: 'cluster-duplicate',
      label: '提交周报',
      atomIds: atoms.map(item => item.id),
      relations: [{
        fromAtom: 'atom-dup-1',
        toAtom: 'atom-dup-2',
        type: 'duplicate',
        rationale: '同一事项重复表达',
      }],
      mergedOwner: { name: '', source: 'implied' },
      mergedDueRef: '',
      mergedStatus: 'planned',
    }],
  });

  assert.equal(result.clusters.length, 1);
  assert.deepEqual(result.clusters[0].atomIds, ['atom-dup-1', 'atom-dup-2']);
});

test('跨维度互斥范围词阻止前端与后端任务错误合并', () => {
  const atoms = [
    atom('昨天', {
      id: 'atom-frontend',
      quote: '前端性能优化还没做完',
      action: '完成前端性能优化',
      status: 'unfinished',
    }),
    atom('今天', {
      id: 'atom-backend',
      quote: '完成后端性能优化',
      action: '完成后端性能优化',
      status: 'planned',
    }),
  ];
  const result = normalizeReconciliationClusters({
    atoms,
    conflicts: [],
    clusters: [{
      id: 'cluster-performance',
      label: '性能优化',
      atomIds: atoms.map(item => item.id),
      relations: [{
        fromAtom: 'atom-frontend',
        toAtom: 'atom-backend',
        type: 'continuation',
        rationale: '模型错误认为同属性能优化',
      }],
      mergedOwner: { name: '', source: 'implied' },
      mergedDueRef: '',
      mergedStatus: 'both',
    }],
  });

  assert.equal(result.clusters.length, 2);
  assert.deepEqual(result.clusters.map(cluster => cluster.atomIds), [
    ['atom-frontend'],
    ['atom-backend'],
  ]);
});

test('umbrella note 下的多个具体子动作即使被模型标为 same_work_item 也拆分', () => {
  const atoms = [
    atom('后天', {
      id: 'atom-umbrella',
      quote: '2027-03-31前完成研发效能提升',
      kind: 'note',
      action: '',
      status: 'unknown',
      dueRef: '2027-03-31前',
    }),
    atom('后天', {
      id: 'atom-dashboard',
      quote: '建立代码质量度量看板',
      action: '建立代码质量度量看板',
      dueRef: '2027-03-31前',
    }),
    atom('后天', {
      id: 'atom-review-system',
      quote: '推行技术方案评审制度',
      action: '推行技术方案评审制度',
      dueRef: '2027-03-31前',
    }),
  ];
  const result = normalizeReconciliationClusters({
    atoms,
    conflicts: [],
    clusters: [{
      id: 'cluster-umbrella',
      label: '研发效能提升',
      atomIds: atoms.map(item => item.id),
      relations: [
        { fromAtom: 'atom-umbrella', toAtom: 'atom-dashboard', type: 'same_work_item', rationale: '同一项目' },
        { fromAtom: 'atom-umbrella', toAtom: 'atom-review-system', type: 'same_work_item', rationale: '同一项目' },
        { fromAtom: 'atom-dashboard', toAtom: 'atom-review-system', type: 'same_work_item', rationale: '模型错误合并并行动作' },
      ],
      mergedOwner: { name: '', source: 'implied' },
      mergedDueRef: '2027-03-31前',
      mergedStatus: 'planned',
    }],
  });

  assert.equal(result.clusters.length, 2);
  assert.deepEqual(result.clusters.map(cluster => (
    cluster.atomIds.filter(id => id !== 'atom-umbrella')
  )), [
    ['atom-dashboard'],
    ['atom-review-system'],
  ]);
});

test('跨来源语义重复任务优先保留今天任务并合并 lineage', () => {
  const merged = mergeCrossSourceCompiledItems([
    {
      task: { id: 'task-yesterday-budget', name: '补充预算明细和风险清单', source: '复盘', due: '待确认', est: '', owner: '待确认', acceptanceCriteria: [], nextAction: '' },
      clusterId: null,
      atomIds: ['atom-yesterday-budget'],
      reviewRequired: false,
      unresolvedFields: [],
    },
    {
      task: { id: 'task-today-budget', name: '补充项目计划书的预算明细和风险清单', source: '今天', due: '待确认', est: '', owner: '待确认', acceptanceCriteria: [], nextAction: '' },
      clusterId: null,
      atomIds: ['atom-today-budget'],
      reviewRequired: false,
      unresolvedFields: [],
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].task.source, '今天');
  assert.equal(merged[0].task.name, '补充项目计划书的预算明细和风险清单');
  assert.deepEqual(merged[0].atomIds, ['atom-today-budget', 'atom-yesterday-budget']);
});

test('跨来源互斥范围任务不会被语义去重', () => {
  const merged = mergeCrossSourceCompiledItems([
    {
      task: { id: 'task-frontend', name: '完成前端性能优化', source: '复盘', due: '待确认', est: '', owner: '待确认', acceptanceCriteria: [], nextAction: '' },
      clusterId: null,
      atomIds: ['atom-frontend'],
      reviewRequired: false,
      unresolvedFields: [],
    },
    {
      task: { id: 'task-backend', name: '完成后端性能优化', source: '今天', due: '待确认', est: '', owner: '待确认', acceptanceCriteria: [], nextAction: '' },
      clusterId: null,
      atomIds: ['atom-backend'],
      reviewRequired: false,
      unresolvedFields: [],
    },
  ]);

  assert.equal(merged.length, 2);
});

test('跨维度 continuation atoms 仍保持同一 cluster', () => {
  const atoms = [
    atom('昨天', { id: 'atom-y', quote: '项目总结报告还没完成', action: '完成项目总结报告', status: 'unfinished' }),
    atom('今天', { id: 'atom-t', quote: '今天交付项目总结报告', action: '交付项目总结报告' }),
  ];
  const result = normalizeReconciliationClusters({
    atoms,
    conflicts: [],
    clusters: [{
      id: 'cluster-cross-day',
      label: '项目总结报告',
      atomIds: atoms.map(item => item.id),
      relations: [{
        fromAtom: 'atom-y',
        toAtom: 'atom-t',
        type: 'continuation',
        rationale: '今天继续昨天遗留',
      }],
      mergedOwner: { name: '', source: 'implied' },
      mergedDueRef: '',
      mergedStatus: 'both',
    }],
  });

  assert.equal(result.clusters.length, 1);
  assert.deepEqual(result.clusters[0].atomIds, ['atom-y', 'atom-t']);
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

test('cluster label 省略动作动词时优先保留 primary action 作为任务名', () => {
  const atoms = [atom('今天', {
    id: 'atom-action-name',
    quote: '正在编写Q3运营分析报告',
    action: '编写Q3运营分析报告',
    status: 'in_progress',
  })];
  const result = compileTasksFromClusters({
    clusters: [{
      id: 'cluster-action-name',
      label: 'Q3运营分析报告',
      atomIds: ['atom-action-name'],
      relations: [],
      mergedOwner: { name: '', source: 'implied' },
      mergedDueRef: '',
      mergedStatus: 'planned',
    }],
    conflicts: [],
    atoms,
    byDimension: { 昨天: [], 今天: atoms, 明天: [], 后天: [] },
    entries: { 昨天: '', 今天: '正在编写Q3运营分析报告', 明天: '', 后天: '' },
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  assert.equal(result.tasks[0].name, '编写Q3运营分析报告');
});

test('continuation 链末端行动成为主任务并排在 lineage 第一位', () => {
  const atoms = [
    atom('昨天', {
      id: 'atom-draft-yesterday',
      quote: '昨天开始编写技术方案',
      action: '编写技术方案',
      status: 'unfinished',
    }),
    atom('今天', {
      id: 'atom-draft-continue',
      quote: '今天继续编写技术方案',
      action: '继续编写技术方案',
      status: 'planned',
    }),
    atom('今天', {
      id: 'atom-draft-finish',
      quote: '下午完成初稿',
      action: '完成初稿',
      status: 'planned',
    }),
  ];
  const result = compileTasksFromClusters({
    clusters: [{
      id: 'cluster-draft-chain',
      label: '编写技术方案',
      atomIds: atoms.map(item => item.id),
      relations: [
        {
          fromAtom: 'atom-draft-yesterday',
          toAtom: 'atom-draft-continue',
          type: 'continuation',
          rationale: '今天继续昨天工作',
        },
        {
          fromAtom: 'atom-draft-continue',
          toAtom: 'atom-draft-finish',
          type: 'continuation',
          rationale: '继续编写后完成初稿',
        },
      ],
      mergedOwner: { name: '', source: 'implied' },
      mergedDueRef: '',
      mergedStatus: 'both',
    }],
    conflicts: [],
    atoms,
    byDimension: { 昨天: [atoms[0]], 今天: atoms.slice(1), 明天: [], 后天: [] },
    entries: {
      昨天: '昨天开始编写技术方案',
      今天: '今天继续编写技术方案，下午完成初稿',
      明天: '',
      后天: '',
    },
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  assert.equal(result.tasks[0].source, '今天');
  assert.equal(result.tasks[0].name, '编写技术方案初稿');
  assert.equal(result.compiledItems[0].atomIds[0], 'atom-draft-finish');
  assert.equal(result.taskAtoms[0].atomId, 'atom-draft-finish');
});

test('存在今天主交付时明天 refinement 不得抢占 primary', () => {
  const atoms = [
    atom('昨天', {
      id: 'atom-deploy-yesterday',
      quote: '周磊开始写部署自动化方案',
      action: '写部署自动化方案',
      actor: { role: 'explicit', name: '周磊' },
      status: 'unfinished',
    }),
    atom('今天', {
      id: 'atom-deploy-today',
      quote: '今天周磊继续写部署自动化方案',
      action: '继续写部署自动化方案',
      actor: { role: 'explicit', name: '周磊' },
      status: 'in_progress',
    }),
    atom('今天', {
      id: 'atom-deploy-draft',
      quote: '下午4点前完成初稿',
      action: '完成初稿',
      actor: { role: 'unknown', name: '' },
      dueRef: '下午4点前',
      status: 'planned',
    }),
    atom('明天', {
      id: 'atom-deploy-refine',
      quote: '明天周磊根据反馈修改部署自动化方案',
      action: '修改部署自动化方案',
      actor: { role: 'explicit', name: '周磊' },
      status: 'planned',
    }),
  ];
  const result = compileTasksFromClusters({
    clusters: [{
      id: 'cluster-deploy',
      label: '部署自动化方案',
      atomIds: atoms.map(item => item.id),
      relations: [
        { fromAtom: 'atom-deploy-yesterday', toAtom: 'atom-deploy-today', type: 'continuation', rationale: '今天继续' },
        { fromAtom: 'atom-deploy-today', toAtom: 'atom-deploy-draft', type: 'continuation', rationale: '完成初稿' },
        { fromAtom: 'atom-deploy-draft', toAtom: 'atom-deploy-refine', type: 'continuation', rationale: '明天修改' },
      ],
      mergedOwner: { name: '周磊', source: 'explicit' },
      mergedDueRef: '下午4点前',
      mergedStatus: 'both',
    }],
    conflicts: [],
    atoms,
    byDimension: {
      昨天: [atoms[0]], 今天: atoms.slice(1, 3), 明天: [atoms[3]], 后天: [],
    },
    entries: {
      昨天: '周磊开始写部署自动化方案',
      今天: '今天周磊继续写部署自动化方案，下午4点前完成初稿',
      明天: '明天周磊根据反馈修改部署自动化方案',
      后天: '',
    },
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  assert.equal(result.tasks[0].source, '今天');
  assert.equal(result.tasks[0].name, '编写部署自动化方案初稿');
  assert.equal(result.tasks[0].due, '2026-08-04');
  assert.equal(result.tasks[0].dueTime, '16:00');
  assert.equal(result.tasks[0].owner, '周磊');
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

test('cluster 内多个不同明确 owner 即使模型未报告 conflict 也回退待确认', () => {
  const atoms = [
    atom('昨天', {
      id: 'atom-owner-old',
      quote: '王磊负责整理客户反馈清单，还没完成',
      action: '整理客户反馈清单',
      actor: { role: 'explicit', name: '王磊' },
      status: 'unfinished',
    }),
    atom('今天', {
      id: 'atom-owner-new',
      quote: '李明接手整理客户反馈清单',
      action: '整理客户反馈清单',
      actor: { role: 'explicit', name: '李明' },
      status: 'planned',
    }),
  ];
  const result = compileTasksFromClusters({
    clusters: [{
      id: 'cluster-owner-derived-conflict',
      label: '整理客户反馈清单',
      atomIds: atoms.map(item => item.id),
      relations: [{
        fromAtom: 'atom-owner-old',
        toAtom: 'atom-owner-new',
        type: 'continuation',
        rationale: '今天接手昨天遗留',
      }],
      mergedOwner: { name: '李明', source: 'explicit' },
      mergedDueRef: '',
      mergedStatus: 'both',
    }],
    conflicts: [],
    atoms,
    byDimension: { 昨天: [atoms[0]], 今天: [atoms[1]], 明天: [], 后天: [] },
    entries: {
      昨天: '王磊负责整理客户反馈清单，还没完成',
      今天: '李明接手整理客户反馈清单',
      明天: '',
      后天: '',
    },
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  assert.equal(result.tasks[0].owner, '待确认');
  assert.equal(result.compiledItems[0].reviewRequired, true);
  assert.ok(result.compiledItems[0].unresolvedFields.includes('owner'));
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

test('Critic 不得把已在 lineage 中的 metadata note 误报为 orphan_evidence', () => {
  const atoms = [
    atom('后天', {
      id: 'atom-governance-work',
      quote: '完成技术债务治理',
      action: '完成技术债务治理',
      status: 'planned',
    }),
    atom('后天', {
      id: 'atom-governance-criteria',
      quote: '治理成果需通过架构委员会评审',
      kind: 'note',
      action: '',
      acceptanceCriteria: ['治理成果需通过架构委员会评审'],
      status: 'unknown',
    }),
  ];
  const compiled = compileTasksFromClusters({
    clusters: [{
      id: 'cluster-governance',
      label: '技术债务治理',
      atomIds: atoms.map(item => item.id),
      relations: [{
        fromAtom: 'atom-governance-work',
        toAtom: 'atom-governance-criteria',
        type: 'dependency',
        rationale: '评审是验收条件',
      }],
      mergedOwner: { name: '', source: 'implied' },
      mergedDueRef: '',
      mergedStatus: 'planned',
    }],
    conflicts: [],
    atoms,
    byDimension: { 昨天: [], 今天: [], 明天: [], 后天: atoms },
    entries: {
      昨天: '', 今天: '', 明天: '',
      后天: '完成技术债务治理，治理成果需通过架构委员会评审',
    },
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });
  const findings = [{
    severity: 'warning',
    category: 'orphan_evidence',
    description: '错误认为 metadata note 不应作为任务证据',
    atomIds: ['atom-governance-criteria'],
    taskIds: [compiled.tasks[0].id],
  }];

  const filtered = filterGroundedCriticFindings({
    findings,
    compiled,
    atoms,
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  assert.deepEqual(filtered, []);
});

test('Critic 不得把已经引用的 work atom 误报为 orphan_evidence', () => {
  const atoms = [atom('后天', {
    id: 'atom-referenced-work',
    quote: '建立知识管理机制',
    action: '建立知识管理机制',
    status: 'planned',
  })];
  const compiled = compileTasksFromClusters({
    clusters: [],
    conflicts: [],
    atoms,
    byDimension: { 昨天: [], 今天: [], 明天: [], 后天: atoms },
    entries: { 昨天: '', 今天: '', 明天: '', 后天: '建立知识管理机制' },
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });
  const findings = [{
    severity: 'info',
    category: 'orphan_evidence',
    description: '错误认为 work atom 未被任何任务引用',
    atomIds: ['atom-referenced-work'],
    taskIds: [],
  }];

  const filtered = filterGroundedCriticFindings({
    findings,
    compiled,
    atoms,
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  assert.deepEqual(filtered, []);
});

test('Critic 的真实 orphan_evidence 仍然保留', () => {
  const atoms = [
    atom('今天', {
      id: 'atom-task-work',
      quote: '提交排期表',
      action: '提交排期表',
    }),
    atom('今天', {
      id: 'atom-real-orphan',
      quote: '额外上下文',
      kind: 'note',
      action: '',
      status: 'unknown',
    }),
  ];
  const compiled = compileTasksFromClusters({
    clusters: [],
    conflicts: [],
    atoms: [atoms[0]],
    byDimension: { 昨天: [], 今天: [atoms[0]], 明天: [], 后天: [] },
    entries: { 昨天: '', 今天: '提交排期表', 明天: '', 后天: '' },
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });
  const findings = [{
    severity: 'warning',
    category: 'orphan_evidence',
    description: '该 atom 确实没有进入 lineage',
    atomIds: ['atom-real-orphan'],
    taskIds: [],
  }];

  const filtered = filterGroundedCriticFindings({
    findings,
    compiled,
    atoms,
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  assert.equal(filtered.length, 1);
});

test('Critic 不得把正式维度来源映射误报为 wrong_source', () => {
  const atoms = [atom('后天', {
    id: 'atom-long-term-source',
    quote: '完成全链路压测体系建设',
    action: '完成全链路压测体系建设',
    status: 'planned',
  })];
  const compiled = compileTasksFromClusters({
    clusters: [],
    conflicts: [],
    atoms,
    byDimension: { 昨天: [], 今天: [], 明天: [], 后天: atoms },
    entries: { 昨天: '', 今天: '', 明天: '', 后天: '完成全链路压测体系建设' },
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });
  const findings = [{
    severity: 'warning',
    category: 'wrong_source',
    description: '错误认为后天与中长期不一致',
    atomIds: ['atom-long-term-source'],
    taskIds: [compiled.tasks[0].id],
  }];

  const filtered = filterGroundedCriticFindings({
    findings,
    compiled,
    atoms,
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  assert.deepEqual(filtered, []);
});

test('Critic 的真实 wrong_source 仍然保留', () => {
  const atoms = [atom('后天', {
    id: 'atom-wrong-source',
    quote: '完成全链路压测体系建设',
    action: '完成全链路压测体系建设',
    status: 'planned',
  })];
  const compiled = compileTasksFromClusters({
    clusters: [],
    conflicts: [],
    atoms,
    byDimension: { 昨天: [], 今天: [], 明天: [], 后天: atoms },
    entries: { 昨天: '', 今天: '', 明天: '', 后天: '完成全链路压测体系建设' },
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });
  compiled.tasks[0].source = '今天';
  compiled.compiledItems[0].task.source = '今天';
  const findings = [{
    severity: 'warning',
    category: 'wrong_source',
    description: '来源确实错误',
    atomIds: ['atom-wrong-source'],
    taskIds: [compiled.tasks[0].id],
  }];

  const filtered = filterGroundedCriticFindings({
    findings,
    compiled,
    atoms,
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  assert.equal(filtered.length, 1);
});

test('Critic 不得用 due_contamination 清除 lineage 明确支持的相对期限', () => {
  const atoms = [atom('今天', {
    id: 'atom-grounded-due',
    quote: '发现两个安全漏洞需要今天修复',
    action: '修复两个安全漏洞',
    dueRef: '今天',
  })];
  const compiled = compileTasksFromClusters({
    clusters: [],
    conflicts: [],
    atoms,
    byDimension: { 昨天: [], 今天: atoms, 明天: [], 后天: [] },
    entries: { 昨天: '', 今天: '发现两个安全漏洞需要今天修复', 明天: '', 后天: '' },
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });
  const findings = [{
    severity: 'blocker',
    category: 'due_contamination',
    description: '错误认为相对日期不可信',
    atomIds: ['atom-grounded-due'],
    taskIds: [compiled.tasks[0].id],
  }];

  const filtered = filterGroundedCriticFindings({
    findings,
    compiled,
    atoms,
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  assert.deepEqual(filtered, []);
});

test('Critic 的无证据 due_contamination 仍然保留', () => {
  const atoms = [atom('今天', {
    id: 'atom-ungrounded-due',
    quote: '提交排期表',
    action: '提交排期表',
  })];
  const compiled = compileTasksFromClusters({
    clusters: [],
    conflicts: [],
    atoms,
    byDimension: { 昨天: [], 今天: atoms, 明天: [], 后天: [] },
    entries: { 昨天: '', 今天: '提交排期表', 明天: '', 后天: '' },
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });
  compiled.tasks[0].due = '2026-08-04';
  compiled.compiledItems[0].task.due = '2026-08-04';
  const findings = [{
    severity: 'blocker',
    category: 'due_contamination',
    description: '期限没有证据',
    atomIds: ['atom-ungrounded-due'],
    taskIds: [compiled.tasks[0].id],
  }];

  const filtered = filterGroundedCriticFindings({
    findings,
    compiled,
    atoms,
    now: () => new Date('2026-08-04T02:00:00.000Z'),
  });

  assert.equal(filtered.length, 1);
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
  assert.deepEqual(result.compiledItems[0].atomIds, ['atom-today', 'atom-yesterday']);
  assert.equal(result.compiledItems[0].clusterId, 'cluster-schedule');
  assert.deepEqual(result.taskAtoms, [
    {
      taskId: result.tasks[0].id,
      clusterId: 'cluster-schedule',
      atomId: 'atom-today',
    },
    {
      taskId: result.tasks[0].id,
      clusterId: 'cluster-schedule',
      atomId: 'atom-yesterday',
    },
  ]);
});
