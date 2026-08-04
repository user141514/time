const test = require('node:test');
const assert = require('node:assert/strict');

const { hardenFactAtoms } = require('../../server/workflows/evidence-hardening');

function atom(overrides = {}) {
  return {
    id: 'atom-1',
    dimension: '今天',
    sourceLineIndex: 0,
    quote: '',
    kind: 'work',
    action: '',
    actor: { role: 'unknown', name: '' },
    dueRef: '',
    estimateRef: '',
    acceptanceCriteria: [],
    nextActionRef: '',
    status: 'planned',
    relatedTo: '',
    confidence: { actor: 0, due: 0, estimate: 0, status: 1 },
    ...overrides,
  };
}

test('明确完成事实被降为非任务事实并清除期限污染', () => {
  const result = hardenFactAtoms([
    atom({
      quote: '今天已提交月度考勤汇总表',
      action: '提交月度考勤汇总表',
      dueRef: '今天',
      status: 'unfinished',
    }),
    atom({
      id: 'atom-2',
      quote: '全员绩效初评也已完成',
      action: '完成全员绩效初评',
      dueRef: '今天',
      status: 'unfinished',
    }),
  ]);

  assert.deepEqual(result.map(item => ({
    kind: item.kind,
    action: item.action,
    status: item.status,
    dueRef: item.dueRef,
  })), [
    { kind: 'note', action: '', status: 'unknown', dueRef: '' },
    { kind: 'note', action: '', status: 'unknown', dueRef: '' },
  ]);
});

test('同一行 goal 加部分完成 note 时提升为未完成 work', () => {
  const result = hardenFactAtoms([
    atom({
      id: 'goal-atom',
      dimension: '昨天',
      quote: '昨天计划完成竞品分析报告',
      kind: 'goal',
      action: '',
      status: 'planned',
    }),
    atom({
      id: 'partial-note',
      dimension: '昨天',
      quote: '实际只完成了数据收集和框架搭建',
      kind: 'note',
      action: '',
      status: 'unknown',
    }),
  ]);

  assert.equal(result[0].kind, 'work');
  assert.equal(result[0].action, '完成竞品分析报告');
  assert.equal(result[0].status, 'unfinished');
  assert.equal(result[1].kind, 'note');
  assert.equal(result[1].status, 'unknown');
});

test('部分完成整句仍保留未完成主任务', () => {
  const result = hardenFactAtoms([
    atom({
      dimension: '昨天',
      quote: '昨天计划完成竞品分析报告，实际只完成了数据收集和框架搭建',
      action: '完成竞品分析报告',
      status: 'planned',
    }),
  ]);

  assert.equal(result[0].kind, 'work');
  assert.equal(result[0].action, '完成竞品分析报告');
  assert.equal(result[0].status, 'unfinished');
});

test('进行中和未完成信号确定性覆盖模型错误状态', () => {
  const result = hardenFactAtoms([
    atom({ quote: '正在编写Q3运营分析报告', status: 'unfinished' }),
    atom({
      id: 'atom-2',
      dimension: '昨天',
      quote: '前端性能优化还没做完',
      status: 'planned',
    }),
  ]);

  assert.equal(result[0].status, 'in_progress');
  assert.equal(result[1].status, 'unfinished');
});

test('纯指标结果、否定准备和已实施临时替代方案不生成任务', () => {
  const result = hardenFactAtoms([
    atom({ quote: '注册用户新增320人', action: '新增注册用户' }),
    atom({ id: 'atom-2', quote: '付费转化率提升至8.5%', action: '提升付费转化率' }),
    atom({ id: 'atom-3', quote: '无需特别准备材料', action: '准备材料' }),
    atom({ id: 'atom-4', quote: '暂时改用人工汇总代替', action: '改用人工汇总' }),
    atom({ id: 'atom-5', quote: '销售报表导出功能报错', action: '处理销售报表导出报错' }),
  ]);

  assert.ok(result.every(item => item.kind === 'note'));
  assert.ok(result.every(item => item.action === ''));
});

test('今天栏的句首维度标签不是截止期限，但显式今天承诺仍保留', () => {
  const result = hardenFactAtoms([
    atom({ quote: '今天完成知识库文章分类', dueRef: '今天' }),
    atom({ id: 'atom-2', quote: '今天由王芳负责提交排期表', dueRef: '今天' }),
    atom({ id: 'atom-3', quote: '尽量今天把客户合同模板库整理完', dueRef: '今天' }),
    atom({ id: 'atom-4', quote: '今天18:00前提交联调报告', dueRef: '今天18:00前' }),
    atom({ id: 'atom-5', quote: '下午需验证所有服务正常运行', dueRef: '下午' }),
    atom({ id: 'atom-6', quote: '下午4点前提交报告', dueRef: '下午4点前' }),
  ]);

  assert.deepEqual(result.map(item => item.dueRef), [
    '',
    '',
    '今天',
    '今天18:00前',
    '',
    '下午4点前',
  ]);
});

test('执行者语法可确定性补全团队、接手人和被请求执行者', () => {
  const result = hardenFactAtoms([
    atom({
      quote: '今天运维组完成服务器迁移',
      action: '完成服务器迁移',
      actor: { role: 'unknown', name: '' },
    }),
    atom({
      id: 'atom-2',
      quote: '今天李明接手整理客户反馈清单',
      action: '整理客户反馈清单',
      actor: { role: 'unknown', name: '' },
    }),
    atom({
      id: 'atom-3',
      quote: '请陈工在今天17:00前完成数据库备份',
      action: '完成数据库备份',
      actor: { role: 'unknown', name: '' },
    }),
    atom({
      id: 'atom-4',
      quote: '今天由赵敏负责提交项目验收报告',
      action: '提交项目验收报告',
      actor: { role: 'explicit', name: '赵敏负责' },
    }),
  ]);

  assert.deepEqual(result.map(item => item.actor), [
    { role: 'explicit', name: '运维组' },
    { role: 'explicit', name: '李明' },
    { role: 'explicit', name: '陈工' },
    { role: 'explicit', name: '赵敏' },
  ]);
});

test('明确执行者和动作可把模型 note 提升为 planned work', () => {
  const result = hardenFactAtoms([
    atom({
      quote: '今天运维组完成服务器迁移',
      kind: 'note',
      action: '',
      actor: { role: 'unknown', name: '' },
      status: 'unknown',
    }),
  ]);

  assert.equal(result[0].kind, 'work');
  assert.equal(result[0].action, '完成服务器迁移');
  assert.equal(result[0].status, 'planned');
  assert.deepEqual(result[0].actor, { role: 'explicit', name: '运维组' });
});

test('从同一原始行补回模型遗漏的自然语言工时', () => {
  const result = hardenFactAtoms([
    atom({
      quote: '今天同步本周需求变更给测试组',
      action: '同步本周需求变更给测试组',
      estimateRef: '',
    }),
  ], ['今天同步本周需求变更给测试组，大概30分钟。']);

  assert.equal(result[0].estimateRef, '大概30分钟');
  assert.equal(result[0].confidence.estimate, 1);
});

test('同一行中的显式下一步降为 metadata note 而不是额外任务', () => {
  const result = hardenFactAtoms([
    atom({
      id: 'main-work',
      quote: '完成自动化部署流水线搭建',
      action: '完成自动化部署流水线搭建',
    }),
    atom({
      id: 'next-step',
      quote: '先完成GitHub Actions基础配置',
      action: '完成GitHub Actions基础配置',
      nextActionRef: '先完成GitHub Actions基础配置',
    }),
  ], ['完成自动化部署流水线搭建，先完成GitHub Actions基础配置。']);

  assert.equal(result[0].kind, 'work');
  assert.equal(result[1].kind, 'note');
  assert.equal(result[1].action, '');
  assert.equal(result[1].status, 'unknown');
  assert.equal(result[1].nextActionRef, '先完成GitHub Actions基础配置');
});

test('同一行中的验收要求降为 metadata note 并保留 criteria', () => {
  const result = hardenFactAtoms([
    atom({
      id: 'main-work',
      quote: '完成客户onboarding流程优化',
      action: '完成客户onboarding流程优化',
    }),
    atom({
      id: 'criteria-work',
      quote: '要求将首次登录到核心功能使用缩短到5分钟内',
      action: '将首次登录到核心功能使用缩短到5分钟内',
      acceptanceCriteria: ['首次登录到核心功能使用缩短到5分钟内'],
    }),
  ], ['完成客户onboarding流程优化，要求将首次登录到核心功能使用缩短到5分钟内。']);

  assert.equal(result[1].kind, 'note');
  assert.equal(result[1].action, '');
  assert.deepEqual(result[1].acceptanceCriteria, ['首次登录到核心功能使用缩短到5分钟内']);
});

test('逗号后的先行动即使模型只给短 nextActionRef 也降为完整 metadata', () => {
  const result = hardenFactAtoms([
    atom({ quote: '明天组织跨部门协作培训', action: '组织跨部门协作培训' }),
    atom({
      id: 'step-note',
      quote: '先收集各部门的协作痛点',
      action: '收集各部门的协作痛点',
      nextActionRef: '先',
    }),
  ], ['明天组织跨部门协作培训，预计2.5h，先收集各部门的协作痛点。']);

  assert.equal(result[0].kind, 'work');
  assert.equal(result[0].estimateRef, '预计2.5h');
  assert.equal(result[1].kind, 'note');
  assert.equal(result[1].nextActionRef, '先收集各部门的协作痛点');
});

test('第一步 note 的截断 nextActionRef 从原 quote 恢复完整文本', () => {
  const result = hardenFactAtoms([
    atom({ quote: '建立知识管理机制', action: '建立知识管理机制' }),
    atom({
      id: 'first-step-note',
      quote: '第一步先盘点各部门现有知识资产',
      kind: 'note',
      action: '',
      nextActionRef: '第一步',
      status: 'unknown',
    }),
  ], ['建立知识管理机制，第一步先盘点各部门现有知识资产。']);

  assert.equal(result[1].kind, 'note');
  assert.equal(result[1].nextActionRef, '第一步先盘点各部门现有知识资产');
});

test('方案需包含类验收 work 降为 metadata 并挂到最近的前置任务', () => {
  const result = hardenFactAtoms([
    atom({ quote: '梳理客户onboarding流程中的断点', action: '梳理客户onboarding流程中的断点' }),
    atom({ id: 'output-plan', quote: '输出优化方案', action: '输出优化方案' }),
    atom({
      id: 'plan-criteria',
      quote: '方案需包含优先级排序和预期收益',
      action: '方案需包含优先级排序和预期收益',
      acceptanceCriteria: ['包含优先级排序和预期收益'],
    }),
  ], ['明天梳理客户onboarding流程中的断点，输出优化方案，方案需包含优先级排序和预期收益。']);

  assert.equal(result[2].kind, 'note');
  assert.deepEqual(result[1].acceptanceCriteria, ['包含优先级排序和预期收益']);
});

test('完成审批类期限要求降为 metadata 并把期限与验收条件挂回主任务', () => {
  const result = hardenFactAtoms([
    atom({ quote: '今天处理采购申请', action: '处理采购申请' }),
    atom({
      id: 'approval-requirement',
      quote: '需在明天前完成审批',
      action: '完成审批',
      dueRef: '明天前',
      actor: { role: 'explicit', name: '需在' },
    }),
  ], ['今天处理采购申请：{"item":"服务器"}，需在明天前完成审批。']);

  assert.equal(result[1].kind, 'note');
  assert.deepEqual(result[1].actor, { role: 'unknown', name: '' });
  assert.equal(result[0].dueRef, '明天前');
  assert.deepEqual(result[0].acceptanceCriteria, ['需在明天前完成审批']);
});

test('冒号前总目标在存在多个具体子动作时降为 umbrella note 并传播期限', () => {
  const result = hardenFactAtoms([
    atom({ quote: '2027-03-31前完成研发效能提升', action: '完成研发效能提升', dueRef: '2027-03-31前' }),
    atom({ id: 'dashboard', quote: '建立代码质量度量看板', action: '建立代码质量度量看板', dueRef: '' }),
    atom({ id: 'review-system', quote: '推行技术方案评审制度', action: '推行技术方案评审制度', dueRef: '' }),
  ], ['2027-03-31前完成研发效能提升：建立代码质量度量看板，推行技术方案评审制度。']);

  assert.equal(result[0].kind, 'note');
  assert.equal(result[1].dueRef, '2027-03-31前');
  assert.equal(result[2].dueRef, '2027-03-31前');
});

test('验收 note 未提供 criteria 时从原 quote 保留明确评审条件', () => {
  const result = hardenFactAtoms([
    atom({ quote: '完成技术债务治理', action: '完成技术债务治理' }),
    atom({
      id: 'review-note',
      quote: '治理成果需通过架构委员会评审',
      kind: 'note',
      action: '',
      acceptanceCriteria: [],
      status: 'unknown',
    }),
  ], ['完成技术债务治理，治理成果需通过架构委员会评审。']);

  assert.deepEqual(result[1].acceptanceCriteria, ['治理成果需通过架构委员会评审']);
});

test('只有短连接词的 nextActionRef 不会吞掉独立动作链', () => {
  const result = hardenFactAtoms([
    atom({ quote: '先确认客户需求', action: '确认客户需求', nextActionRef: '先' }),
    atom({ id: 'step-2', quote: '然后联系研发', action: '联系研发', nextActionRef: '然后' }),
  ], ['先确认客户需求然后联系研发']);

  assert.ok(result.every(item => item.kind === 'work'));
});

test('唯一 work 可从同一原始行补回 quote 外的明确执行者', () => {
  const result = hardenFactAtoms([
    atom({
      quote: '今天安排修复安全扫描发现的3个高危漏洞',
      action: '修复安全扫描发现的3个高危漏洞',
      actor: { role: 'unknown', name: '' },
    }),
    atom({
      id: 'responsible-before-deadline',
      sourceLineIndex: 1,
      quote: '继续整理供应商准入清单',
      action: '整理供应商准入清单',
      actor: { role: 'unknown', name: '' },
    }),
  ], [
    '今天安排修复安全扫描发现的3个高危漏洞，赵敏负责，预计2h。',
    '今天继续整理供应商准入清单，张莉负责在今天17:00前完成。',
  ]);

  assert.deepEqual(result[0].actor, { role: 'explicit', name: '赵敏' });
  assert.equal(result[0].estimateRef, '预计2h');
  assert.deepEqual(result[1].actor, { role: 'explicit', name: '张莉' });
});

test('开始或继续执行的明确人名可从原始行补回', () => {
  const result = hardenFactAtoms([
    atom({
      quote: '今天周磊继续写部署自动化方案',
      action: '继续写部署自动化方案',
      actor: { role: 'unknown', name: '' },
    }),
  ], ['今天周磊继续写部署自动化方案，下午4点前完成初稿。']);

  assert.deepEqual(result[0].actor, { role: 'explicit', name: '周磊' });
});

test('同一原始行只有一个明确执行者时传播到该行全部 work atoms', () => {
  const result = hardenFactAtoms([
    atom({ quote: '今天周磊继续写部署自动化方案', action: '继续写部署自动化方案', actor: { role: 'unknown', name: '' } }),
    atom({ id: 'finish-draft', quote: '下午4点前完成初稿', action: '完成初稿', actor: { role: 'unknown', name: '' } }),
  ], ['今天周磊继续写部署自动化方案，下午4点前完成初稿。']);

  assert.deepEqual(result[0].actor, { role: 'explicit', name: '周磊' });
  assert.deepEqual(result[1].actor, { role: 'explicit', name: '周磊' });
});

test('同一原始行存在多个明确执行者时禁止跨 atom 传播', () => {
  const result = hardenFactAtoms([
    atom({ quote: '张伟负责整理客户需求文档', action: '整理客户需求文档', actor: { role: 'explicit', name: '张伟' } }),
    atom({ id: 'owner-2', quote: '李娜负责确认交货日期', action: '确认交货日期', actor: { role: 'explicit', name: '李娜' } }),
  ], ['今天张伟负责整理客户需求文档；李娜负责确认交货日期。']);

  assert.equal(result[0].actor.name, '张伟');
  assert.equal(result[1].actor.name, '李娜');
});

test('今天交付属于明确当天承诺而不是普通栏位标签', () => {
  const result = hardenFactAtoms([
    atom({
      quote: '今天交付项目总结报告',
      action: '交付项目总结报告',
      dueRef: '今天',
    }),
  ]);

  assert.equal(result[0].dueRef, '今天');
});

test('明天或后天开头的同一行多动作共享对应相对日期', () => {
  const result = hardenFactAtoms([
    atom({ dimension: '明天', quote: '明天梳理客户onboarding流程中的断点', action: '梳理客户onboarding流程中的断点', dueRef: '' }),
    atom({ id: 'future-output', dimension: '明天', quote: '输出优化方案', action: '输出优化方案', dueRef: '' }),
    atom({ id: 'long-term-a', dimension: '后天', sourceLineIndex: 1, quote: '后天建立机制', action: '建立机制', dueRef: '' }),
    atom({ id: 'long-term-b', dimension: '后天', sourceLineIndex: 1, quote: '形成文档', action: '形成文档', dueRef: '' }),
  ], [
    '明天梳理客户onboarding流程中的断点，输出优化方案。',
    '后天建立机制，形成文档。',
  ]);

  assert.equal(result[0].dueRef, '明天');
  assert.equal(result[1].dueRef, '明天');
  assert.equal(result[2].dueRef, '后天');
  assert.equal(result[3].dueRef, '后天');
});

test('普通今天多动作不会仅因栏位标签自动补期限', () => {
  const result = hardenFactAtoms([
    atom({ quote: '今天整理会议纪要', action: '整理会议纪要', dueRef: '' }),
    atom({ id: 'today-sync', quote: '同步给团队', action: '同步给团队', dueRef: '' }),
  ], ['今天整理会议纪要，同步给团队。']);

  assert.equal(result[0].dueRef, '');
  assert.equal(result[1].dueRef, '');
});

test('同一原始行中的明确今天完成或交付承诺补回当天期限', () => {
  const result = hardenFactAtoms([
    atom({ quote: '今天交付项目总结报告', action: '交付项目总结报告', dueRef: '' }),
    atom({ id: 'finish-today', sourceLineIndex: 1, quote: '今天完成后端性能优化', action: '完成后端性能优化', dueRef: '' }),
    atom({ id: 'ordinary-today', sourceLineIndex: 2, quote: '今天补充项目计划书预算明细', action: '补充项目计划书预算明细', dueRef: '' }),
  ], [
    '今天交付项目总结报告，预计还需要2h。',
    '今天完成后端性能优化，预计3h。',
    '今天补充项目计划书预算明细。',
  ]);

  assert.equal(result[0].dueRef, '今天');
  assert.equal(result[1].dueRef, '今天');
  assert.equal(result[2].dueRef, '');
});

test('条件句尾部即使被模型拆成 work 也降为非行动上下文', () => {
  const result = hardenFactAtoms([
    atom({ quote: '今天整理Q3预算数据', action: '整理Q3预算数据' }),
    atom({
      id: 'conditional-work',
      quote: '需要重新编制并在一周内提交修订版',
      action: '重新编制并提交修订版',
      dueRef: '一周内',
    }),
  ], ['今天整理Q3预算数据。如果明天财务部驳回预算方案，则需要重新编制并在一周内提交修订版。']);

  assert.equal(result[0].kind, 'work');
  assert.equal(result[1].kind, 'note');
  assert.equal(result[1].action, '');
  assert.equal(result[1].dueRef, '');
});

test('接收人和审批人不会被保留为任务执行者', () => {
  const result = hardenFactAtoms([
    atom({
      quote: '今天完成竞品分析报告，向部门总监汇报',
      action: '完成竞品分析报告',
      actor: { role: 'explicit', name: '部门总监' },
      confidence: { actor: 1, due: 0, estimate: 0, status: 1 },
    }),
    atom({
      id: 'atom-2',
      quote: '请财务主管审批',
      action: '审批采购清单',
      actor: { role: 'explicit', name: '财务主管' },
      confidence: { actor: 1, due: 0, estimate: 0, status: 1 },
    }),
  ]);

  assert.deepEqual(result[0].actor, { role: 'unknown', name: '' });
  assert.equal(result[1].kind, 'note');
  assert.deepEqual(result[1].actor, { role: 'unknown', name: '' });
});

test('显式行动词存在时问题描述仍可保持任务', () => {
  const result = hardenFactAtoms([
    atom({ quote: '今天排查支付接口报错', action: '排查支付接口报错' }),
    atom({ id: 'atom-2', quote: '修复两个安全漏洞', action: '修复安全漏洞' }),
  ]);

  assert.ok(result.every(item => item.kind === 'work'));
});
