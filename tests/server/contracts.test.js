const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  CLASSIFICATION_SOURCE,
  ENERGY_POLICY,
  GOAL_KEYS,
  IMPORTANCE,
  SOURCES,
  TASK_STATUS,
  URGENCY,
  extractOwnerFromText,
  normalizeDueForWrite,
  normalizeOptionalDue,
  normalizeOptionalOwner,
  normalizeTask,
  parseEstimatedMinutes,
  quadrantFor,
} = require('../../server/contracts/time-management');

test('正式枚举与四步业务契约保持一致', () => {
  assert.deepEqual(GOAL_KEYS, ['昨天', '今天', '明天', '后天']);
  assert.deepEqual(IMPORTANCE, ['高', '中', '低']);
  assert.deepEqual(URGENCY, ['高', '中', '低']);
  assert.deepEqual(SOURCES, ['复盘', '今天', '短期目标', '中长期', '临时']);
  assert.deepEqual(TASK_STATUS, ['pending', 'done']);
  assert.deepEqual(CLASSIFICATION_SOURCE, [
    'ai-extraction',
    'manual',
    'unclassified',
    'ai-matrix',
  ]);
});

test('四象限固定精力比例合计 100', () => {
  assert.deepEqual(ENERGY_POLICY, {
    第一象限: 55,
    第二象限: 25,
    第三象限: 15,
    第四象限: 5,
  });
  assert.equal(Object.values(ENERGY_POLICY).reduce((sum, value) => sum + value, 0), 100);
});

test('只有高等级映射为重要或紧急', () => {
  assert.equal(quadrantFor({ importance: '高', urgency: '高' }), '第一象限');
  assert.equal(quadrantFor({ importance: '高', urgency: '中' }), '第二象限');
  assert.equal(quadrantFor({ importance: '中', urgency: '高' }), '第三象限');
  assert.equal(quadrantFor({ importance: '低', urgency: '低' }), '第四象限');
});

test('模型没有提供截止时间时标记待确认', () => {
  const task = normalizeTask({
    name: '整理季度复盘材料',
    importance: '高',
    urgency: '低',
    source: '复盘',
    est: '约2h',
  });

  assert.equal(task.due, '待确认');
  assert.equal(task.status, 'pending');
  assert.equal(task.classificationSource, 'ai-extraction');
  assert.match(task.id, /^[0-9a-f-]{36}$/i);
});

test('手动任务未标注时保留空等级等待矩阵 AI 判定', () => {
  const task = normalizeTask({
    name: '准备临时会议材料',
    source: '临时',
    due: '2026-07-20',
    est: '约1h',
    classificationSource: 'unclassified',
  });

  assert.equal(task.importance, null);
  assert.equal(task.urgency, null);
  assert.equal(task.classificationSource, 'unclassified');
});

test('任务验收标准缺省为空数组并保留最多五条文本', () => {
  const withoutCriteria = normalizeTask({
    name: '提交方案',
    importance: '高',
    urgency: '中',
    source: '今天',
    est: '约1h',
  });
  assert.deepEqual(withoutCriteria.acceptanceCriteria, []);

  const criteria = ['形成 4 个模块', '完成 2 次模拟', '评分不低于 80 分'];
  const withCriteria = normalizeTask({
    name: '完成训练计划',
    importance: '高',
    urgency: '中',
    source: '短期目标',
    est: '约6h',
    acceptanceCriteria: criteria,
  });
  assert.deepEqual(withCriteria.acceptanceCriteria, criteria);
});

test('仅解析确定性的小时和分钟耗时', () => {
  assert.equal(parseEstimatedMinutes('20分钟'), 20);
  assert.equal(parseEstimatedMinutes('0.5h'), 30);
  assert.equal(parseEstimatedMinutes('8h'), 480);
  assert.equal(parseEstimatedMinutes('12小时'), 720);
  assert.equal(parseEstimatedMinutes('约 1.5 h'), 90);
  assert.equal(parseEstimatedMinutes('1–2h'), null);
  assert.equal(parseEstimatedMinutes('半天'), null);
});

test('下一步缺省为空字符串并保留明确动作', () => {
  const withoutNextAction = normalizeTask({
    name: '提交方案',
    importance: '高',
    urgency: '中',
    source: '今天',
    est: '约1h',
  });
  assert.equal(withoutNextAction.nextAction, '');

  const withNextAction = normalizeTask({
    name: '推进长期课程',
    importance: '高',
    urgency: '低',
    source: '中长期',
    est: '16h',
    nextAction: '今天先列出 4 个课程模块',
  });
  assert.equal(withNextAction.nextAction, '今天先列出 4 个课程模块');
});

test('运行提示词声明正式任务、矩阵和报告契约', () => {
  const prompt = readFileSync(
    path.join(__dirname, '..', '..', 'prompts', 'system.md'),
    'utf8',
  );

  assert.match(prompt, /due.*YYYY-MM-DD或待确认/);
  assert.match(prompt, /提取尚未完成的动作/);
  assert.match(prompt, /taskId/);
  assert.match(prompt, /55、25、15、5/);
  assert.match(prompt, /energyRules/);
  assert.match(prompt, /order/);
  assert.match(prompt, /acceptanceCriteria/);
  assert.match(prompt, /短期目标.*中长.*至少/s);
  assert.match(prompt, /nextAction/);
  assert.match(prompt, /超过 8h.*拆分|超过 8 小时.*拆分/);
  assert.match(prompt, /owner.*原文.*明确.*责任/s);
  assert.match(prompt, /不得.*推断/);
  assert.match(prompt, /due.*YYYY-MM-DD/s);
});

test('缺失、空白和 null owner 标准化为待确认', () => {
  const missing = normalizeTask({
    name: '提交方案', importance: '高', urgency: '低', source: '今天', est: '约1h',
  });
  assert.equal(missing.owner, '待确认');

  const blank = normalizeTask({
    name: '提交方案', importance: '高', urgency: '低', source: '今天', est: '约1h', owner: '   ',
  });
  assert.equal(blank.owner, '待确认');

  const nullable = normalizeTask({
    name: '提交方案', importance: '高', urgency: '低', source: '今天', est: '约1h', owner: null,
  });
  assert.equal(nullable.owner, '待确认');
});

test('明确 owner 原样保留', () => {
  const task = normalizeTask({
    name: '提交方案', importance: '高', urgency: '低', source: '今天', est: '约1h', owner: '张三',
  });
  assert.equal(task.owner, '张三');
});

test('normalizeOptionalOwner 将缺失和空白标准化为待确认', () => {
  assert.equal(normalizeOptionalOwner({}).owner, '待确认');
  assert.equal(normalizeOptionalOwner({ owner: '' }).owner, '待确认');
  assert.equal(normalizeOptionalOwner({ owner: '  ' }).owner, '待确认');
  assert.equal(normalizeOptionalOwner({ owner: null }).owner, '待确认');
  assert.equal(normalizeOptionalOwner({ owner: '李四' }).owner, '李四');
});

test('新写入 due 只接受日期或待确认', () => {
  const dateOnly = normalizeOptionalDue({ due: '2026-07-20' });
  assert.equal(dateOnly.due, '2026-07-20');

  const pending = normalizeOptionalDue({ due: '待确认' });
  assert.equal(pending.due, '待确认');

  const missing = normalizeOptionalDue({});
  assert.equal(missing.due, '待确认');

  const blank = normalizeOptionalDue({ due: '   ' });
  assert.equal(blank.due, '待确认');
});

test('旧任务缺 owner 仍可读取并标准化', () => {
  const task = normalizeTask({
    name: '旧任务', importance: '中', urgency: '低', source: '今天', est: '1h',
    due: '2026-07-20 18:00',
  });
  assert.equal(task.due, '2026-07-20 18:00');
  assert.equal(task.owner, '待确认');
});

// --- Task 1 Step 3: Red tests for write-boundary deadline contract ---

test('new writes convert valid legacy timestamps to date-only values', () => {
  assert.deepEqual(
    normalizeDueForWrite({ due: '2026-07-20 18:00' }),
    { due: '2026-07-20' },
  );
  assert.deepEqual(
    normalizeDueForWrite({ due: '2026-07-20T09:30' }),
    { due: '2026-07-20' },
  );
});

test('new writes retain only valid dates or pending', () => {
  assert.equal(normalizeDueForWrite({ due: '2026-02-29' }).due, '待确认');
  assert.equal(normalizeDueForWrite({ due: '下周某天' }).due, '待确认');
  assert.equal(normalizeDueForWrite({ due: '' }).due, '待确认');
  assert.equal(normalizeDueForWrite({ due: null }).due, '待确认');
  assert.equal(normalizeDueForWrite({ due: '待确认' }).due, '待确认');
});

test('extractOwnerFromText：明确提交/负责/完成 识别为责任人', () => {
  assert.equal(extractOwnerFromText('王芳今天18:00前提交新版排期表'), '王芳');
  assert.equal(extractOwnerFromText('由研发组负责支付回调日志采集'), '研发组');
  assert.equal(extractOwnerFromText('李明明天下午完成接口回归方案'), '李明');
});

test('extractOwnerFromText：提交给/交给 不得识别为责任人', () => {
  assert.equal(extractOwnerFromText('把排期表提交给王芳确认'), null);
  assert.equal(extractOwnerFromText('报告今天18:00前提交给王芳'), null);
  assert.equal(extractOwnerFromText('交给研发组处理'), null);
});

test('extractOwnerFromText：尚未/已经 等虚词不得误判', () => {
  assert.equal(extractOwnerFromText('客户投诉复盘尚未完成，需要补充原因和改进措施'), null);
  assert.equal(extractOwnerFromText('支付回调日志采集已完成'), null);
  assert.equal(extractOwnerFromText('今天完成新版接口联调'), null);
  assert.equal(extractOwnerFromText(null), null);
  assert.equal(extractOwnerFromText(''), null);
});
