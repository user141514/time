const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyDeadlineUrgency,
  extractDeadlineFromText,
  normalizeDue,
  parseDue,
  parseExplicitDue,
  referenceDateInTimeZone,
} = require('../../server/policies/deadline');

const SHANGHAI_NOON = () => new Date('2026-07-20T04:00:00.000Z');

function task(overrides = {}) {
  return {
    id: 'task-a',
    name: '提交方案',
    source: '今天',
    importance: '高',
    urgency: '中',
    classificationSource: 'ai-extraction',
    due: '2026-07-20 17:00',
    est: '约1h',
    ...overrides,
  };
}

test('明确的 ISO 日期和时间才会被解析', () => {
  assert.deepEqual(parseExplicitDue('2026-07-20'), {
    date: '2026-07-20',
    time: null,
    sortKey: '2026-07-20T23:59',
  });
  assert.deepEqual(parseExplicitDue('2026-07-20 16:30'), {
    date: '2026-07-20',
    time: '16:30',
    sortKey: '2026-07-20T16:30',
  });
  assert.deepEqual(parseExplicitDue('2026-07-20T08:05'), {
    date: '2026-07-20',
    time: '08:05',
    sortKey: '2026-07-20T08:05',
  });
  for (const value of [
    '',
    '待确认',
    '今天 16:00',
    '本周五',
    '2026/07/20',
    '2026-02-30',
    '2026-07-20 24:00',
  ]) {
    assert.equal(parseExplicitDue(value), null);
  }
});

test('Asia/Shanghai 参考日期由注入时钟计算并正确跨日', () => {
  assert.equal(
    referenceDateInTimeZone(() => new Date('2026-07-19T15:59:59.000Z'), 'Asia/Shanghai'),
    '2026-07-19',
  );
  assert.equal(
    referenceDateInTimeZone(() => new Date('2026-07-19T16:00:00.000Z'), 'Asia/Shanghai'),
    '2026-07-20',
  );
});

test('中文相对日期按 Asia/Shanghai 参考日解析', () => {
  const context = { now: SHANGHAI_NOON, timeZone: 'Asia/Shanghai' };
  assert.deepEqual(parseDue('今天18:00', context), {
    date: '2026-07-20',
    time: '18:00',
    sortKey: '2026-07-20T18:00',
  });
  assert.deepEqual(parseDue('今日', context), {
    date: '2026-07-20',
    time: null,
    sortKey: '2026-07-20T23:59',
  });
  assert.deepEqual(parseDue('明天 09:30', context), {
    date: '2026-07-21',
    time: '09:30',
    sortKey: '2026-07-21T09:30',
  });
  assert.deepEqual(parseDue('今天 11:30 前', context), {
    date: '2026-07-20',
    time: '11:30',
    sortKey: '2026-07-20T11:30',
  });
  assert.deepEqual(parseDue('后天 08:05', context), {
    date: '2026-07-22',
    time: '08:05',
    sortKey: '2026-07-22T08:05',
  });
});

test('可确定截止时间标准化为具体上海日期', () => {
  const context = { now: SHANGHAI_NOON, timeZone: 'Asia/Shanghai' };
  assert.equal(normalizeDue('今天', context), '2026-07-20');
  assert.equal(normalizeDue('今日 8:05 前', context), '2026-07-20 08:05');
  assert.equal(normalizeDue('明天 09:30', context), '2026-07-21 09:30');
  assert.equal(normalizeDue('后天', context), '2026-07-22');
  assert.equal(normalizeDue('2026-07-31T16:00', context), '2026-07-31 16:00');
});

test('相对日期标准化正确跨月和跨年', () => {
  assert.equal(normalizeDue('明天', {
    now: () => new Date('2026-07-31T04:00:00.000Z'),
    timeZone: 'Asia/Shanghai',
  }), '2026-08-01');
  assert.equal(normalizeDue('后天', {
    now: () => new Date('2026-12-30T04:00:00.000Z'),
    timeZone: 'Asia/Shanghai',
  }), '2027-01-01');
});

test('无法唯一确定或无效的截止时间统一为待确认', () => {
  const context = { now: SHANGHAI_NOON, timeZone: 'Asia/Shanghai' };
  for (const value of ['', '待确认', '尽快', '月底', '近期', '本周五', '2026-02-30']) {
    assert.equal(normalizeDue(value, context), '待确认', value);
  }
});

test('紧急度纠偏同时回写标准截止日期且不丢失原始紧迫信号', () => {
  const context = { now: SHANGHAI_NOON, timeZone: 'Asia/Shanghai' };
  assert.deepEqual(
    applyDeadlineUrgency(task({ due: '明天 09:00', urgency: '高' }), context),
    {
      ...task({ due: '明天 09:00', urgency: '高' }),
      due: '2026-07-21 09:00',
      urgency: '中',
    },
  );
  assert.equal(
    applyDeadlineUrgency(task({ due: '尽快', urgency: '低' }), context).urgency,
    '高',
  );
  assert.equal(
    applyDeadlineUrgency(task({ due: '尽快', urgency: '低' }), context).due,
    '待确认',
  );
});

test('期限、来源和明确压力按统一规则确定紧急度', () => {
  const context = { now: SHANGHAI_NOON, timeZone: 'Asia/Shanghai' };
  const cases = [
    { name: '当天', input: { source: '复盘', due: '2026-07-20', urgency: '低' }, expected: '高' },
    { name: '逾期', input: { source: '复盘', due: '2026-07-19', urgency: '低' }, expected: '高' },
    { name: '明天', input: { source: '短期目标', due: '2026-07-21', urgency: '低' }, expected: '中' },
    { name: '七天内', input: { source: '短期目标', due: '2026-07-27', urgency: '低' }, expected: '中' },
    { name: '超过七天', input: { source: '短期目标', due: '2026-07-28', urgency: '高' }, expected: '低' },
    { name: '复盘待确认', input: { source: '复盘', due: '待确认', urgency: '高' }, expected: '低' },
    { name: '中长期待确认', input: { source: '中长期', due: '待确认', urgency: '高' }, expected: '低' },
    { name: '今天栏待确认', input: { source: '今天', due: '待确认', urgency: '低' }, expected: '高' },
    { name: '不可解析自然期限', input: { source: '复盘', due: '本周五', urgency: '高' }, expected: '低' },
    { name: '未来但明确阻塞', input: { source: '短期目标', name: '立即处理发布阻塞', due: '2026-07-28', urgency: '低' }, expected: '高' },
  ];

  for (const item of cases) {
    assert.equal(
      applyDeadlineUrgency(task(item.input), context).urgency,
      item.expected,
      item.name,
    );
  }
});

test('任务或对应原始目标含明确紧迫信号时允许未来高紧急度', () => {
  const context = { now: SHANGHAI_NOON, timeZone: 'Asia/Shanghai' };
  assert.equal(applyDeadlineUrgency(task({
    name: '立即处理发布阻塞',
    due: '明天 09:00',
    urgency: '高',
  }), context).urgency, '高');
  assert.equal(applyDeadlineUrgency(task({
    name: '处理发布准备',
    due: '明天 09:00',
    urgency: '高',
  }), {
    ...context,
    goalText: '该事项影响当天交付，必须尽快完成',
  }).urgency, '高');
});

test('日期纠偏返回新对象且不改变其他任务字段或原输入', () => {
  const input = task({ due: '2026-07-20 16:00', urgency: '中' });
  const snapshot = structuredClone(input);
  const result = applyDeadlineUrgency(input, {
    now: SHANGHAI_NOON,
    timeZone: 'Asia/Shanghai',
  });

  assert.notEqual(result, input);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(result, { ...snapshot, urgency: '高' });
});

test('确定性期限提取：今天/明天/后天按上海业务日期解析', () => {
  const context = { now: SHANGHAI_NOON, timeZone: 'Asia/Shanghai' };
  assert.deepEqual(extractDeadlineFromText('王芳今天提交新版排期表', context), { date: '2026-07-20', time: null });
  assert.deepEqual(extractDeadlineFromText('明天下午完成接口回归方案', context), { date: '2026-07-21', time: null });
  assert.deepEqual(extractDeadlineFromText('后天完成部署', context), { date: '2026-07-22', time: null });
});

test('确定性期限提取：今晚18:00前 与 今天18点前 归到当天', () => {
  const context = { now: SHANGHAI_NOON, timeZone: 'Asia/Shanghai' };
  assert.deepEqual(extractDeadlineFromText('王芳今晚18:00前提交排期表', context), { date: '2026-07-20', time: '18:00' });
  assert.deepEqual(extractDeadlineFromText('今天18点前完成联调', context), { date: '2026-07-20', time: '18:00' });
});

test('确定性期限提取：日期词与时刻之间允许出现责任人和动作前缀', () => {
  const context = { now: SHANGHAI_NOON, timeZone: 'Asia/Shanghai' };
  assert.deepEqual(
    extractDeadlineFromText('今天由王芳负责在18:00前提交新版排期表', context),
    { date: '2026-07-20', time: '18:00' },
  );
});

test('确定性期限提取：下午/晚上按 12 小时制偏移，上午/凌晨保持不变', () => {
  const context = { now: SHANGHAI_NOON, timeZone: 'Asia/Shanghai' };
  assert.deepEqual(extractDeadlineFromText('今天下午3点前提交方案', context), { date: '2026-07-20', time: '15:00' });
  assert.deepEqual(extractDeadlineFromText('今天下午4:30前提交方案', context), { date: '2026-07-20', time: '16:30' });
  assert.deepEqual(extractDeadlineFromText('明天晚上8点前完成', context), { date: '2026-07-21', time: '20:00' });
  assert.deepEqual(extractDeadlineFromText('明天晚上8:15前完成', context), { date: '2026-07-21', time: '20:15' });
  assert.deepEqual(extractDeadlineFromText('后天凌晨3点值班', context), { date: '2026-07-22', time: '03:00' });
  assert.deepEqual(extractDeadlineFromText('明天上午10点联调', context), { date: '2026-07-21', time: '10:00' });
});

test('确定性期限提取：底/月内 不作子串匹配，摸底/三个月内 不误判为月底', () => {
  const context = { now: SHANGHAI_NOON, timeZone: 'Asia/Shanghai' };
  assert.equal(extractDeadlineFromText('完成摸底调研', context), null);
  assert.equal(extractDeadlineFromText('优化底层设计', context), null);
  assert.equal(extractDeadlineFromText('三个月内完成重构', context), null);
  assert.deepEqual(extractDeadlineFromText('本月内完成迁移', context), { date: '2026-07-31', time: null });
  assert.deepEqual(extractDeadlineFromText('月内交付备份', context), { date: '2026-07-31', time: null });
});

test('确定性期限提取：本周五按上海业务日期的星期计算', () => {
  // 2026-07-20 是周一，本周五为 2026-07-24
  const context = { now: SHANGHAI_NOON, timeZone: 'Asia/Shanghai' };
  assert.deepEqual(extractDeadlineFromText('本周五发布灰度', context), { date: '2026-07-24', time: null });
});

test('确定性期限提取：本月底解析为当月最后一天', () => {
  const context = { now: SHANGHAI_NOON, timeZone: 'Asia/Shanghai' };
  assert.deepEqual(extractDeadlineFromText('本月底形成稳定性改进路线图', context), { date: '2026-07-31', time: null });
  assert.deepEqual(extractDeadlineFromText('月底前完成备份', context), { date: '2026-07-31', time: null });
});

test('确定性期限提取：版本号和标识符中的日期样式不算期限', () => {
  const context = { now: SHANGHAI_NOON, timeZone: 'Asia/Shanghai' };
  assert.equal(
    extractDeadlineFromText('将前端依赖升级到 @core/ui-v2026.08.15', context),
    null,
  );
  assert.deepEqual(
    extractDeadlineFromText('将前端依赖升级到 v2026.08.15，并在2026-08-20前发布', context),
    { date: '2026-08-20', time: null },
  );
});

test('确定性期限提取：显式日期与 X月X日', () => {
  const context = { now: SHANGHAI_NOON, timeZone: 'Asia/Shanghai' };
  assert.deepEqual(extractDeadlineFromText('8月10日前交付', context), { date: '2026-08-10', time: null });
  assert.deepEqual(extractDeadlineFromText('2026-09-01 完成', context), { date: '2026-09-01', time: null });
});

test('确定性期限提取：多期限取最早（最紧迫）', () => {
  const context = { now: SHANGHAI_NOON, timeZone: 'Asia/Shanghai' };
  assert.deepEqual(extractDeadlineFromText('本周五整理，明天18:00前提交', context), { date: '2026-07-21', time: '18:00' });
});

test('确定性期限提取：无法唯一确定返回 null，时长不算时刻', () => {
  const context = { now: SHANGHAI_NOON, timeZone: 'Asia/Shanghai' };
  assert.equal(extractDeadlineFromText('完成支付回调日志采集，预计2小时', context), null);
  assert.equal(extractDeadlineFromText('', context), null);
  assert.equal(extractDeadlineFromText(null, context), null);
});
