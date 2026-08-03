const {
  DEFAULT_TIME_ZONE,
  parseDue,
  referenceDateInTimeZone,
} = require('./deadline');

const TIME_RANGE = /(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)\s*(?:-|–|—|至)\s*([01]?\d|2[0-3]):([0-5]\d)(?!\d)/g;

function parseEstimatedRangeMinutes(est) {
  if (typeof est !== 'string') return null;
  const text = est.trim().replace(/^约\s*/, '');
  let match = /^(\d+(?:\.\d+)?)\s*(?:-|–|—|至)\s*(\d+(?:\.\d+)?)\s*(?:h|小时)$/i.exec(text);
  if (match) {
    const min = Number(match[1]) * 60;
    const max = Number(match[2]) * 60;
    return min > 0 && max >= min ? { min, max } : null;
  }

  match = /^(\d+(?:\.\d+)?)\s*(?:h|小时)$/i.exec(text);
  if (match) {
    const value = Number(match[1]) * 60;
    return value > 0 ? { min: value, max: value } : null;
  }

  match = /^(\d+(?:\.\d+)?)\s*分钟$/.exec(text);
  if (match) {
    const value = Number(match[1]);
    return value > 0 ? { min: value, max: value } : null;
  }
  return null;
}

function clockMinutes(hour, minute) {
  return Number(hour) * 60 + Number(minute);
}

function buildReportScheduleContext({
  tasks,
  now = Date.now,
  timeZone = DEFAULT_TIME_ZONE,
}) {
  const referenceDate = referenceDateInTimeZone(now, timeZone);
  const fixedPoints = [];
  const protectedWindows = [];

  for (const task of tasks) {
    const due = parseDue(task.due, { now, timeZone });
    if (!due?.time || due.date > referenceDate) continue;

    const endMinute = clockMinutes(...due.time.split(':'));
    fixedPoints.push({
      taskId: task.id,
      taskName: task.name,
      time: due.time,
      minute: endMinute,
    });

    const estimate = parseEstimatedRangeMinutes(task.est);
    if (!estimate) continue;
    protectedWindows.push({
      taskId: task.id,
      taskName: task.name,
      startMinute: Math.max(0, endMinute - estimate.max),
      endMinute,
      due: due.time,
    });
  }

  return { fixedPoints, protectedWindows };
}

function conflictsWithText(text, scheduleContext) {
  TIME_RANGE.lastIndex = 0;
  for (let match = TIME_RANGE.exec(text); match; match = TIME_RANGE.exec(text)) {
    const start = clockMinutes(match[1], match[2]);
    const end = clockMinutes(match[3], match[4]);
    if (end <= start) continue;

    for (const point of scheduleContext.fixedPoints) {
      if (!text.includes(point.taskName)
          && start <= point.minute && point.minute < end) {
        return true;
      }
    }
    for (const window of scheduleContext.protectedWindows) {
      if (!text.includes(window.taskName)
          && start < window.endMinute && window.startMinute < end) {
        return true;
      }
    }
  }
  return false;
}

function textOf(item) {
  return typeof item === 'string' ? item : String(item?.text || '');
}

function hasScheduleConflict(report, scheduleContext) {
  return [...report.energyRules, ...report.adjustments]
    .map(textOf)
    .some(text => conflictsWithText(text, scheduleContext));
}

const SAFE_SCHEDULE_FALLBACK = Object.freeze({
  energyRules: '安排专注工作时，避开已有截止点和保护时段。',
  adjustments: '调整任务安排时，避开已有截止点和保护时段，并按当前优先级推进。',
});

function stabilizeTextList(items, scheduleContext, fallback) {
  return [...new Set(items.map(text => (
    conflictsWithText(text, scheduleContext) ? fallback : text
  )))];
}

function stabilizeScheduleConflicts(report, scheduleContext) {
  return {
    ...report,
    order: report.order.map(item => ({ ...item })),
    energyRules: stabilizeTextList(
      report.energyRules,
      scheduleContext,
      SAFE_SCHEDULE_FALLBACK.energyRules,
    ),
    adjustments: stabilizeTextList(
      report.adjustments,
      scheduleContext,
      SAFE_SCHEDULE_FALLBACK.adjustments,
    ),
  };
}

module.exports = {
  buildReportScheduleContext,
  hasScheduleConflict,
  parseEstimatedRangeMinutes,
  stabilizeScheduleConflicts,
};
