const { randomUUID } = require('node:crypto');

const GOAL_KEYS = Object.freeze(['昨天', '今天', '明天', '后天']);
const CATEGORY_KEYS = GOAL_KEYS;
const IMPORTANCE = Object.freeze(['高', '中', '低']);
const URGENCY = Object.freeze(['高', '中', '低']);
const SOURCES = Object.freeze(['复盘', '今天', '短期目标', '中长期', '临时']);
const TASK_STATUS = Object.freeze(['pending', 'done']);
const CLASSIFICATION_SOURCE = Object.freeze([
  'ai-extraction',
  'manual',
  'unclassified',
  'ai-matrix',
]);

const ENERGY_POLICY = Object.freeze({
  第一象限: 55,
  第二象限: 25,
  第三象限: 15,
  第四象限: 5,
});

const CATEGORY_TO_SOURCE = Object.freeze({
  昨天: '复盘',
  今天: '今天',
  明天: '短期目标',
  后天: '中长期',
});

const SOURCE_TO_CATEGORY = Object.freeze({
  复盘: '昨天',
  今天: '今天',
  临时: '今天',
  短期目标: '明天',
  中长期: '后天',
});

const DISTRIBUTION_TARGETS = Object.freeze({
  昨天: Object.freeze({ min: 0, max: 2, label: '→0%' }),
  今天: Object.freeze({ min: 70, max: 80, label: '70–80%' }),
  明天: Object.freeze({ min: 10, max: 20, label: '10–20%' }),
  后天: Object.freeze({ min: 3, max: 100, label: '5%' }),
});

const TASK_LIMIT = 100;
const TEXT_LIMITS = Object.freeze({
  goal: 4000,
  taskName: 200,
  due: 80,
  est: 40,
  owner: 100,
  acceptanceCriteria: 200,
  nextAction: 200,
});

const MANUAL_FLAGS = Object.freeze({
  imp: Object.freeze({ importance: '高', urgency: '低', classificationSource: 'manual' }),
  urg: Object.freeze({ importance: '低', urgency: '高', classificationSource: 'manual' }),
  both: Object.freeze({ importance: '高', urgency: '高', classificationSource: 'manual' }),
  unclassified: Object.freeze({
    importance: null,
    urgency: null,
    classificationSource: 'unclassified',
  }),
});

function quadrantFor(task) {
  if (!IMPORTANCE.includes(task.importance) || !URGENCY.includes(task.urgency)) {
    throw Object.assign(new Error('task classification is incomplete'), {
      code: 'TASK_UNCLASSIFIED',
    });
  }

  const important = task.importance === '高';
  const urgent = task.urgency === '高';
  if (important && urgent) return '第一象限';
  if (important) return '第二象限';
  if (urgent) return '第三象限';
  return '第四象限';
}

function normalizedText(value, fallback = '') {
  const text = value == null ? '' : String(value).trim();
  return text || fallback;
}

function parseEstimatedMinutes(est) {
  if (typeof est !== 'string') return null;
  const value = est.trim().replace(/\s+/g, '').replace(/^约/, '');
  const hours = value.match(/^(\d+(?:\.\d+)?)(?:h|小时)$/i);
  if (hours) return Number(hours[1]) * 60;
  const minutes = value.match(/^(\d+)分钟$/);
  return minutes ? Number(minutes[1]) : null;
}

function categoryForTask(task) {
  if (CATEGORY_KEYS.includes(task?.category)) return task.category;
  return SOURCE_TO_CATEGORY[task?.source] || '今天';
}

function sourceForCategory(category) {
  return CATEGORY_TO_SOURCE[category] || '今天';
}

function normalizeOptionalDue(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return task;
  if (task.due == null) return { ...task, due: '待确认' };
  if (typeof task.due !== 'string') return task;
  return { ...task, due: task.due.trim() || '待确认' };
}

function normalizeOptionalOwner(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return task;
  if (task.owner == null) return { ...task, owner: '待确认' };
  if (typeof task.owner !== 'string') return task;
  return { ...task, owner: task.owner.trim() || '待确认' };
}

const DATE_OR_LEGACY_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2})?$/;

function validCalendarDate(yearText, monthText, dayText) {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year < 1000 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function normalizeDueForWrite(task) {
  const normalized = normalizeOptionalDue(task);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    return normalized;
  }
  if (normalized.due === '待确认') return normalized;
  const match = DATE_OR_LEGACY_TIMESTAMP.exec(normalized.due);
  if (!match || !validCalendarDate(match[1], match[2], match[3])) {
    return { ...normalized, due: '待确认' };
  }
  return { ...normalized, due: `${match[1]}-${match[2]}-${match[3]}` };
}

// 责任人确定性兜底提取：仅当 evidence 未给出 owner 时使用。
// "王芳今天18:00前提交…" → 王芳；"由研发组负责" → 研发组；
// "提交给王芳" 中的 王芳 不会被识别（动词后跟 给/到/至 时排除）。
// ponytail: 启发式兜底，词表有界；模型正确提取时完全不介入。
// 动词后跟 给/到/至/人 时不是责任人动作（"提交给X""负责人"）
const OWNER_VERB = '(?:提交|负责|完成|跟进|处理|汇总|交付|输出|落实|推动|牵头)(?!给|到|至|人)';
const OWNER_GAP = '(?:今天|今日|明天|明日|后天|今晚|今夜|下午|上午|中午|晚上|傍晚|凌晨|'
  + '本周[一二三四五六日天]|下周[一二三四五六日天]|月底|月末|本月|'
  + '\\d{1,2}[:：]\\d{2}|\\d{1,2}点(?:\\d{1,2})?分?|前|之前|内)';
const OWNER_PATTERN = new RegExp(
  `(?:由|让|请|安排)?([\\u4e00-\\u9fa5]{2,4}?)(?:${OWNER_GAP}){0,3}${OWNER_VERB}`,
  'g',
);
const OWNER_STOPWORDS = new Set([
  // 时间词与虚词，避免"今天提交""尚未完成"被误判为责任人
  '今天', '今日', '明天', '明日', '后天', '昨晚', '昨天', '上周', '本周', '下周', '本月',
  '上午', '下午', '晚上', '中午', '凌晨', '傍晚', '刚刚', '马上', '立刻', '尽快',
  '尚未', '还未', '还没', '已经', '还没有', '未能', '无法', '需要', '将要', '即将',
  '预计', '大概', '可能', '不要', '无需', '没有', '未', '必须',
  // 动词本身不是责任人
  '提交', '负责', '完成', '跟进', '处理', '汇总', '交付', '输出', '落实', '推动', '牵头',
]);

// 名称内嵌时间词/虚词即视为误判（如"复盘尚未完成"中的"复盘尚未"、"采集已完成"中的"采集已"）
const OWNER_POISONS = ['尚未', '还未', '还没', '已经', '没有', '无法', '未能', '需要', '预计',
  '今天', '今日', '明天', '明日', '后天', '今晚', '昨夜', '昨天', '上午', '下午', '晚上',
  '中午', '凌晨', '傍晚', '本月', '本周', '下周', '月底', '月末', '之前', '完成', '提交',
  '已', '未', '需', '被', '将', '把', '给', '从', '要', '的', '了', '中', '与', '和', '及', '并', '在'];

function extractOwnerFromText(text) {
  if (typeof text !== 'string') return null;
  for (const match of text.matchAll(OWNER_PATTERN)) {
    const name = match[1];
    if (name && !OWNER_STOPWORDS.has(name) && !OWNER_POISONS.some(poison => name.includes(poison))) {
      return name;
    }
  }
  return null;
}

// 昨天遗留与今天同名行动只保留今天行动（跨来源去重）；
// 同名同来源保持独立，不按名称去重。
function dedupeCrossSourceTasks(tasks) {
  const todayNames = new Set();
  for (const task of tasks) {
    if (task.source === '今天' || task.source === '临时') todayNames.add(task.name);
  }
  return tasks.filter(task => task.source !== '复盘' || !todayNames.has(task.name));
}

function normalizeTask(task) {
  const hasClassification = IMPORTANCE.includes(task.importance)
    && URGENCY.includes(task.urgency);
  const acceptanceCriteria = Array.isArray(task.acceptanceCriteria)
    ? task.acceptanceCriteria.map(item => normalizedText(item)).filter(Boolean).slice(0, 5)
    : [];

  return {
    id: task.id || randomUUID(),
    name: normalizedText(task.name),
    importance: hasClassification ? task.importance : null,
    urgency: hasClassification ? task.urgency : null,
    source: task.source,
    due: normalizedText(task.due, '待确认'),
    est: normalizedText(task.est),
    owner: normalizedText(task.owner, '待确认'),
    acceptanceCriteria,
    nextAction: normalizedText(task.nextAction),
    status: task.status || 'pending',
    classificationSource: task.classificationSource
      || (hasClassification ? 'ai-extraction' : 'unclassified'),
  };
}

module.exports = {
  CATEGORY_KEYS,
  CATEGORY_TO_SOURCE,
  CLASSIFICATION_SOURCE,
  DISTRIBUTION_TARGETS,
  ENERGY_POLICY,
  GOAL_KEYS,
  IMPORTANCE,
  LEVELS: IMPORTANCE,
  MANUAL_FLAGS,
  SOURCES,
  TASK_LIMIT,
  TASK_STATUS,
  SOURCE_TO_CATEGORY,
  TEXT_LIMITS,
  URGENCY,
  categoryForTask,
  dedupeCrossSourceTasks,
  extractOwnerFromText,
  normalizeDueForWrite,
  normalizeOptionalDue,
  normalizeOptionalOwner,
  normalizeTask,
  parseEstimatedMinutes,
  quadrantFor,
  sourceForCategory,
};
