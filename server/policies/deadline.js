const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
const EXPLICIT_DUE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/;
const RELATIVE_DUE_PATTERN = /^(今天|今日|今晚|今夜|明天|明日|后天)(?:\s*([01]?\d|2[0-3]):([0-5]\d)\s*前?)?$/;
const URGENCY_SIGNAL = /紧急|立即|马上|尽快|今天必须|今日必须|当天交付|影响当天交付|阻塞/;

// 确定性期限提取（服务端权威，不依赖模型）：
// 支持 今天/今日/今晚/今夜/明天/明日/后天、18:00前 等时刻、
// 本周五、本月底/月底；多个期限取最早（最紧迫），无法确定返回 null。
const RELATIVE_DAY_OFFSETS = Object.freeze({
  今天: 0, 今日: 0, 今晚: 0, 今夜: 0, 明天: 1, 明日: 1, 后天: 2,
});
const WEEKDAY_NAMES = Object.freeze({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 });
const CLOCK_TIME = /(\d{1,2})[:：](\d{2})/;
const CN_TIME = /(\d{1,2})点(?:(\d{1,2})分?)?/;
const TIME_PERIOD = /(上午|下午|晚上|凌晨|中午|傍晚)\s*$/;
const DAY_WORD = new RegExp(`(${Object.keys(RELATIVE_DAY_OFFSETS).join('|')})`);
const WEEK_DAY = /本周([一二三四五六日天])/;
const MONTH_END = /(?:月底|月末|月底前|本月内|(?<![一-龥])月内)/;

function resolveNow(now) {
  const value = typeof now === 'function' ? now() : now;
  const instant = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(instant.getTime())) throw new TypeError('now must resolve to a valid date');
  return instant;
}

function referenceDateInTimeZone(now = Date.now, timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(resolveNow(now));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isValidCalendarDate(year, month, day) {
  if (year < 1000 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseExplicitDue(due) {
  if (typeof due !== 'string') return null;
  const match = EXPLICIT_DUE_PATTERN.exec(due.trim());
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!isValidCalendarDate(year, month, day)) return null;

  let time = null;
  if (hourText != null) {
    const hour = Number(hourText);
    const minute = Number(minuteText);
    if (hour > 23 || minute > 59) return null;
    time = `${hourText}:${minuteText}`;
  }

  const date = `${yearText}-${monthText}-${dayText}`;
  return {
    date,
    time,
    sortKey: `${date}T${time || '23:59'}`,
  };
}

function addCalendarDays(dateText, amount) {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function parseRelativeDue(due, context = {}) {
  if (typeof due !== 'string') return null;
  const match = RELATIVE_DUE_PATTERN.exec(due.trim());
  if (!match) return null;

  const [, relativeDay, hourText, minuteText] = match;
  const referenceDate = referenceDateInTimeZone(
    context.now || Date.now,
    context.timeZone || DEFAULT_TIME_ZONE,
  );
  const date = addCalendarDays(referenceDate, RELATIVE_DAY_OFFSETS[relativeDay]);
  const time = hourText == null
    ? null
    : `${String(Number(hourText)).padStart(2, '0')}:${minuteText}`;
  return {
    date,
    time,
    sortKey: `${date}T${time || '23:59'}`,
  };
}

function parseDue(due, context = {}) {
  return parseExplicitDue(due) || parseRelativeDue(due, context);
}

function normalizeDue(due, context = {}) {
  const parsed = parseDue(due, context);
  if (!parsed) return '待确认';
  return parsed.time ? `${parsed.date} ${parsed.time}` : parsed.date;
}

function hasUrgencySignal(task, goalText = '') {
  return URGENCY_SIGNAL.test([
    task?.name,
    task?.due,
    task?.nextAction,
    ...(task?.acceptanceCriteria || []),
    goalText,
  ].filter(Boolean).join('\n'));
}

function calendarDayDistance(fromDate, toDate) {
  const from = new Date(`${fromDate}T00:00:00.000Z`);
  const to = new Date(`${toDate}T00:00:00.000Z`);
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

function extractDeadlineFromText(text, context = {}) {
  if (typeof text !== 'string') return null;
  const referenceDate = referenceDateInTimeZone(
    context.now || Date.now,
    context.timeZone || DEFAULT_TIME_ZONE,
  );
  const candidates = [];
  const push = (date, time, index) => {
    if (!date) return;
    candidates.push({ date, time, sortKey: `${date}T${time || '23:59'}`, index });
  };

  let match;
  const explicitYear = /(20\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})[日号]?/g;
  while ((match = explicitYear.exec(text)) !== null) {
    const date = `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
    if (isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
      push(date, null, match.index);
    }
  }
  const monthDay = /(?<!\d)(\d{1,2})月(\d{1,2})[日号]?/g;
  while ((match = monthDay.exec(text)) !== null) {
    const year = Number(referenceDate.slice(0, 4));
    if (isValidCalendarDate(year, Number(match[1]), Number(match[2]))) {
      push(`${year}-${String(match[1]).padStart(2, '0')}-${String(match[2]).padStart(2, '0')}`, null, match.index);
    }
  }
  const dayWord = new RegExp(DAY_WORD.source, 'g');
  while ((match = dayWord.exec(text)) !== null) {
    const offset = RELATIVE_DAY_OFFSETS[match[1]];
    const tail = text.slice(match.index + match[0].length);
    const nextDay = new RegExp(DAY_WORD.source).exec(tail);
    const punctuationIndex = tail.search(/[，。；;\n]/);
    const boundaries = [48];
    if (nextDay) boundaries.push(nextDay.index);
    if (punctuationIndex >= 0) boundaries.push(punctuationIndex);
    const after = tail.slice(0, Math.min(...boundaries));
    const clock = CLOCK_TIME.exec(after);
    const cn = CN_TIME.exec(after);
    const timeMatch = clock || cn;
    let time = timeMatch ? formatTime(timeMatch) : null;
    if (time && timeMatch === cn) {
      const hour = Number(cn[1]);
      const period = TIME_PERIOD.exec(after.slice(0, cn.index));
      if (period && (period[1] === '下午' || period[1] === '晚上' || period[1] === '傍晚') && hour < 12) {
        time = `${String(hour + 12).padStart(2, '0')}:${time.slice(3)}`;
      }
    }
    push(addCalendarDays(referenceDate, offset), time, match.index);
  }
  const weekDay = new RegExp(WEEK_DAY.source, 'g');
  while ((match = weekDay.exec(text)) !== null) {
    const target = WEEKDAY_NAMES[match[1]] % 7; // 周日 → 0
    const daysAhead = (target - dayOfWeek(referenceDate) + 7) % 7;
    push(addCalendarDays(referenceDate, daysAhead), null, match.index);
  }
  const monthEnd = new RegExp(MONTH_END.source, 'g');
  while ((match = monthEnd.exec(text)) !== null) {
    push(monthEndDate(referenceDate), null, match.index);
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.index - b.index));
  return { date: candidates[0].date, time: candidates[0].time };
}

function formatTime(match) {
  const hour = Number(match[1]);
  if (hour > 23) return null;
  const minute = match[2] != null ? Number(match[2]) : 0;
  if (minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function dayOfWeek(dateText) {
  return new Date(`${dateText}T00:00:00.000Z`).getUTCDay();
}

function monthEndDate(referenceDate) {
  const year = Number(referenceDate.slice(0, 4));
  const month = Number(referenceDate.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

function applyDeadlineUrgency(task, context = {}) {
  const parsed = parseDue(task?.due, context);
  const result = {
    ...task,
    due: normalizeDue(task?.due, context),
  };
  const referenceDate = referenceDateInTimeZone(
    context.now || Date.now,
    context.timeZone || DEFAULT_TIME_ZONE,
  );
  if (parsed && parsed.date <= referenceDate) {
    result.urgency = '高';
    result.importance = result.importance ?? '高';
    return result;
  }

  if (hasUrgencySignal(task, context.goalText)) {
    result.urgency = '高';
    result.importance = result.importance ?? '高';
    return result;
  }

  if (parsed) {
    const daysUntilDue = calendarDayDistance(referenceDate, parsed.date);
    result.urgency = daysUntilDue <= 7 ? '中' : '低';
    result.importance = result.importance ?? result.urgency;
    return result;
  }

  if (result.source === '今天') {
    result.urgency = '高';
    result.importance = result.importance ?? '高';
  } else {
    result.urgency = '低';
    result.importance = result.importance ?? '低';
  }
  return result;
}

module.exports = {
  DEFAULT_TIME_ZONE,
  applyDeadlineUrgency,
  extractDeadlineFromText,
  normalizeDue,
  parseDue,
  parseExplicitDue,
  referenceDateInTimeZone,
};
