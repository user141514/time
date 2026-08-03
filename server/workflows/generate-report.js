const Ajv = require('ajv');

const {
  CLASSIFICATION_SOURCE,
  DISTRIBUTION_TARGETS,
  GOAL_KEYS,
  IMPORTANCE,
  SOURCES,
  TASK_LIMIT,
  TASK_STATUS,
  TEXT_LIMITS,
  URGENCY,
  normalizeOptionalDue,
  normalizeOptionalOwner,
} = require('../contracts/time-management');
const { referenceDateInTimeZone } = require('../policies/deadline');
const { buildReportPriorityContext } = require('../policies/report-priority');
const {
  buildReportScheduleContext,
  hasScheduleConflict,
  stabilizeScheduleConflicts,
} = require('../policies/report-schedule');
const { loadStepPrompt } = require('../prompts/load-step-prompt');
const {
  REPORT_OUTPUT_REASON,
  reportOutputError,
  retryFeedbackFor,
} = require('./report-output-diagnostics');

const ajv = new Ajv({ allErrors: true, strict: true });
const nullableImportance = { anyOf: [{ enum: IMPORTANCE }, { type: 'null' }] };
const nullableUrgency = { anyOf: [{ enum: URGENCY }, { type: 'null' }] };
const goalProperties = Object.fromEntries(GOAL_KEYS.map(key => [key, {
  type: 'string',
  maxLength: TEXT_LIMITS.goal,
}]));

const validateRequest = ajv.compile({
  type: 'object',
  additionalProperties: false,
  required: ['tasks', 'matrix', 'goals'],
  properties: {
    tasks: {
      type: 'array',
      maxItems: TASK_LIMIT,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'source'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 200 },
          name: { type: 'string', minLength: 1, maxLength: TEXT_LIMITS.taskName },
          source: { enum: SOURCES },
          importance: nullableImportance,
          urgency: nullableUrgency,
          due: { type: 'string', maxLength: TEXT_LIMITS.due },
          dueTime: { type: "string", maxLength: 10 },
          est: { type: 'string', maxLength: TEXT_LIMITS.est },
          owner: { type: 'string', maxLength: TEXT_LIMITS.owner },
          acceptanceCriteria: {
            type: 'array',
            maxItems: 5,
            items: {
              type: 'string',
              minLength: 1,
              maxLength: TEXT_LIMITS.acceptanceCriteria,
            },
          },
          nextAction: { type: 'string', maxLength: TEXT_LIMITS.nextAction },
          status: { enum: TASK_STATUS },
          classificationSource: { enum: CLASSIFICATION_SOURCE },
        },
      },
    },
    matrix: {
      type: 'object',
      additionalProperties: false,
      required: ['quadrants'],
      properties: {
        classifications: { type: 'array', maxItems: TASK_LIMIT },
        note: { type: 'string', maxLength: 4000 },
        quadrants: {
          type: 'array',
          maxItems: 4,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['taskIds'],
            properties: {
              q: { type: 'string', maxLength: 40 },
              name: { type: 'string', maxLength: 40 },
              priority: { type: 'integer', minimum: 1, maximum: 4 },
              action: { type: 'string', maxLength: 40 },
              energyPercent: { type: 'integer', minimum: 0, maximum: 100 },
              taskIds: {
                type: 'array',
                maxItems: TASK_LIMIT,
                items: { type: 'string', minLength: 1, maxLength: 200 },
              },
            },
          },
        },
      },
    },
    baseOnly: { type: 'boolean' },
    goals: {
      type: 'object',
      additionalProperties: false,
      required: ['昨天', '后天'],
      properties: goalProperties,
    },
    distribution: {
      type: 'object',
      additionalProperties: false,
      required: ['categories', 'diagnosis', 'recommendations'],
      properties: {
        totalMinutes: { type: 'number', minimum: 0 },
        totalHours: { type: 'number', minimum: 0 },
        validTaskCount: { type: 'integer', minimum: 0, maximum: TASK_LIMIT },
        invalidTasks: {
          type: 'array',
          maxItems: TASK_LIMIT,
          items: { type: 'object' },
        },
        categories: {
          type: 'array',
          minItems: 4,
          maxItems: 4,
          items: {
            type: 'object',
            additionalProperties: true,
            required: ['key', 'percent', 'status'],
            properties: {
              key: { enum: GOAL_KEYS },
              percent: { type: 'number', minimum: 0, maximum: 100 },
              status: { enum: ['under', 'ok', 'over'] },
            },
          },
        },
        percentages: { type: 'object' },
        diagnosis: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: { type: 'string', minLength: 1, maxLength: 1000 },
        },
        recommendations: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: { type: 'string', minLength: 1, maxLength: 1000 },
        },
      },
    },
  },
});

const validateResponse = ajv.compile({
  type: 'object',
  additionalProperties: false,
  required: ['order', 'energyRules', 'adjustments'],
  properties: {
    order: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['taskId', 'reason'],
        properties: {
          taskId: { type: 'string', minLength: 1, maxLength: 200 },
          reason: { type: 'string', minLength: 1, maxLength: 4000 },
        },
      },
    },
    energyRules: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: { type: 'string', minLength: 1, maxLength: 4000 },
    },
    adjustments: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: { type: 'string', minLength: 1, maxLength: 4000 },
    },
  },
});

function publicError(code, message, status) {
  return Object.assign(new Error(message), { code, status, expose: true });
}

function inputError() {
  return publicError('INPUT_INVALID', '输入内容不符合要求。', 400);
}

function assertInputSemantics(tasks, matrix) {
  const taskIds = new Set();
  for (const task of tasks) {
    if (!task.id.trim() || !task.name.trim() || taskIds.has(task.id)) throw inputError();
    taskIds.add(task.id);
  }

  const matrixIds = matrix.quadrants.flatMap(item => item.taskIds);
  if (new Set(matrixIds).size !== matrixIds.length
      || matrixIds.some(taskId => !taskIds.has(taskId))) {
    throw inputError();
  }
}

function hasLongTermMeasure(adjustments) {
  const content = adjustments.join('\n');
  return /\d|(?:每[日周月季年])|截止|之前|前完成|指标|里程碑|节点|数量|比例/.test(content);
}

const PROHIBITED_DELAY = /推迟|延后|取消|暂缓|搁置/;
const DELEGATION_ACTION = /授权|委派|交办/;
const EXPLICIT_SCHEDULE = /(?:[01]?\d|2[0-3]):[0-5]\d|立即授权/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function containsTaskIdLeak(text, tasks) {
  if (typeof text !== 'string') return false;
  for (const task of tasks) {
    if (text.includes(task.id)) return true;
    if (UUID.test(task.id)
        && text.toLowerCase().includes(task.id.slice(0, 8).toLowerCase())) {
      return true;
    }
  }
  return false;
}

function visibleTextForTask(report, task) {
  const orderReason = report.order.find(item => item.taskId === task.id)?.reason;
  return [
    orderReason,
    ...report.energyRules.filter(text => text.includes(task.name)),
    ...report.adjustments.filter(text => text.includes(task.name)),
  ].filter(Boolean);
}

function assertProtectedGuidance(report, tasks, priorityContext) {
  const taskById = new Map(tasks.map(task => [task.id, task]));
  for (const taskId of priorityContext.protectedTaskIds) {
    const task = taskById.get(taskId);
    const related = visibleTextForTask(report, task);
    if (related.some(text => PROHIBITED_DELAY.test(text))) {
      throw reportOutputError(REPORT_OUTPUT_REASON.REPORT_PROTECTED_TASK_DELAYED);
    }
    if (priorityContext.actionByTaskId[taskId] === '立即授权'
        && !related.some(text => DELEGATION_ACTION.test(text))) {
      throw reportOutputError(REPORT_OUTPUT_REASON.REPORT_DELEGATION_MISSING);
    }
  }

  for (const taskId of priorityContext.remainingProtectedTaskIds) {
    const task = taskById.get(taskId);
    const scheduled = report.adjustments.some(text => (
      text.includes(task.name) && EXPLICIT_SCHEDULE.test(text)
    ));
    if (!scheduled) {
      throw reportOutputError(REPORT_OUTPUT_REASON.REPORT_REMAINING_PROTECTED_UNSCHEDULED);
    }
  }
}

// ---------- 报告证据门禁（阶段2） ----------
// 每条建议必须有依据，且只能来自：现有任务 / 非空输入维度 / 确定性时间分布事实。
// 依据由服务端计算并回写，模型无法伪造。

function dueDateOf(task) {
  return /^(\d{4}-\d{2}-\d{2})/.exec(task?.due)?.[1] || null;
}

function basisForText(text, { tasks, goals, distribution }) {
  const task = tasks.find(item => item.name.trim() && text.includes(item.name));
  if (task) return { type: 'task', taskId: task.id };
  const facts = [
    ...(distribution?.diagnosis || []),
    ...(distribution?.recommendations || []),
  ];
  if (facts.some(fact => text.includes(fact))) return { type: 'distribution' };
  for (const key of GOAL_KEYS) {
    if (goals[key]?.trim() && text.includes(key)) return { type: 'dimension', dimension: key };
  }
  // 步骤5提示词要求 energyRules“强调守住第二象限、压缩第四象限”，象限名即确定性分布策略依据
  if (/(?:第一|第二|第三|第四)象限/.test(text)) return { type: 'distribution' };
  // stabilizeScheduleConflicts 的确定性回退文本（server 生成，非模型编造）
  if (text.includes('避开已有截止点和保护时段')) return { type: 'distribution' };
  return null;
}

function rejectionReasonFor(text, context) {
  if (typeof text !== 'string') return REPORT_OUTPUT_REASON.REPORT_UNATTRIBUTED_SUGGESTION;
  // 规则1：引用了空的明天或后天目标
  for (const key of ['明天', '后天']) {
    if (!context.goals[key]?.trim() && text.includes(key)) {
      const isTaskName = context.tasks.some(item => item.name.includes(key));
      const isSanctionedCorrection = new RegExp(`当前没有填写${key}事项`).test(text);
      if (!isTaskName && !isSanctionedCorrection) {
        return REPORT_OUTPUT_REASON.REPORT_EMPTY_DIMENSION_REFERENCE;
      }
    }
  }
  // 规则2：建议把任务授权/委派/交办给其现有 owner
  if (/授权|委派|交办/.test(text)) {
    const owners = new Set(
      context.tasks
        .filter(item => item.owner && item.owner !== '待确认')
        .map(item => item.owner),
    );
    for (const owner of owners) {
      if (text.includes(owner)) return REPORT_OUTPUT_REASON.REPORT_REASSIGN_TO_EXISTING_OWNER;
    }
  }
  // 规则4：建议修改或推迟当天到期任务，却没有明确依据
  if (/推迟|延后|取消|暂缓|搁置/.test(text)) {
    const todayTask = context.tasks.find(item => (
      dueDateOf(item) === context.businessDate && text.includes(item.name)
    ));
    if (todayTask && !EXPLICIT_SCHEDULE.test(text)) {
      return REPORT_OUTPUT_REASON.REPORT_TODAY_TASK_CHANGED_WITHOUT_BASIS;
    }
  }
  return null;
}

// 规则3：引用了不存在的任务 → 无依据建议统一拒绝。
// 依据只在服务端内部计算（不进入响应，历史契约保持字符串数组）。
function assertEvidenceGate(report, context) {
  for (const item of report.order) {
    const reason = rejectionReasonFor(item.reason, context);
    if (reason) throw reportOutputError(reason);
  }
  for (const text of [...report.energyRules, ...report.adjustments]) {
    const reason = rejectionReasonFor(text, context);
    if (reason) throw reportOutputError(reason);
    if (!basisForText(text, context)) {
      throw reportOutputError(REPORT_OUTPUT_REASON.REPORT_UNATTRIBUTED_SUGGESTION);
    }
  }
}

// ---------- 确定性基础报告（阶段2.3/6） ----------
// 模型失败或超时时立即返回；只使用任务事实、分布诊断与空栏确认，不编造。
function buildBaseReport(input, priorityContext) {
  const taskById = new Map(input.tasks.map(task => [task.id, task]));
  const order = priorityContext.recommendedTaskIds.map(taskId => {
    const task = taskById.get(taskId);
    const parts = [];
    if (dueDateOf(task)) parts.push(`${dueDateOf(task)} 前完成`);
    if (task.owner && task.owner !== '待确认') parts.push(`责任人 ${task.owner}`);
    if (!parts.length) {
      parts.push(`按 ${priorityContext.actionByTaskId[taskId] || '当前优先级'} 推进`);
    }
    return { taskId, reason: parts.join('，') };
  });

  const targetText = {
    昨天: '“昨天”遗留应趋近 0%，集中清理或授权，阻止继续滚存。',
    今天: `“今天”投入保持在 ${DISTRIBUTION_TARGETS.今天.min}–${DISTRIBUTION_TARGETS.今天.max}% 目标区间，优先完成当日到期事项。`,
    明天: `“明天”投入 ${DISTRIBUTION_TARGETS.明天.min}–${DISTRIBUTION_TARGETS.明天.max}%，为机制、流程和团队能力建设预留不可挤占时段。`,
    后天: `“后天”布局 ${DISTRIBUTION_TARGETS.后天.min}% 以上，为未来规划预留提前量。`,
  };
  const energyRules = GOAL_KEYS
    .filter(key => input.goals[key]?.trim())
    .map(key => targetText[key])
    .slice(0, 3);
  if (energyRules.length === 0) {
    energyRules.push('当前未填写目标栏，建议先填写四栏内容以生成精力分配建议。');
  }

  const emptyKeys = GOAL_KEYS.filter(key => !input.goals[key]?.trim());
  const adjustments = [
    // 分布建议不得引用空维度（引用空栏目标即视为编造）
    ...(input.distribution?.recommendations || [])
      .filter(text => !emptyKeys.some(key => text.includes(key))),
    ...emptyKeys.map(key => `当前没有填写${key}事项，可确认是否需要补充。`),
  ].slice(0, 3);
  return { order, energyRules, adjustments };
}

function assertReportSemantics(report, tasks, goals, priorityContext) {
  const taskIds = new Set(tasks.map(task => task.id));
  const orderIds = report.order.map(item => item.taskId);
  if (new Set(orderIds).size !== orderIds.length
      || orderIds.some(taskId => !taskIds.has(taskId))) {
    throw reportOutputError(REPORT_OUTPUT_REASON.REPORT_ORDER_REFERENCE_INVALID);
  }

  if (orderIds.length !== priorityContext.recommendedTaskIds.length
      || orderIds.some((taskId, index) => (
        taskId !== priorityContext.recommendedTaskIds[index]
      ))) {
    throw reportOutputError(REPORT_OUTPUT_REASON.REPORT_ORDER_PRIORITY_MISMATCH);
  }

  const visibleText = [
    ...report.order.map(item => item.reason),
    ...report.energyRules,
    ...report.adjustments,
  ];
  if (visibleText.some(text => containsTaskIdLeak(text, tasks))) {
    throw reportOutputError(REPORT_OUTPUT_REASON.REPORT_TASK_ID_LEAK);
  }

  if (goals.后天.trim() && !hasLongTermMeasure(report.adjustments)) {
    throw reportOutputError(REPORT_OUTPUT_REASON.REPORT_LONG_TERM_MEASURE_MISSING);
  }
  assertProtectedGuidance(report, tasks, priorityContext);
}

function normalizeModelError(error) {
  if (error.code === 'MODEL_OUTPUT_INVALID') {
    return reportOutputError(error.diagnosticCode || 'MODEL_JSON_INVALID');
  }
  if (error.code === 'MODEL_TIMEOUT') {
    return publicError('MODEL_TIMEOUT', 'AI 响应超时，请重试。', 504);
  }
  if (error.code === 'MODEL_CANCELLED') {
    return publicError('REQUEST_CANCELLED', '请求已取消。', 499);
  }
  if (error.code === 'MODEL_UPSTREAM_ERROR') {
    return publicError('MODEL_UPSTREAM_ERROR', 'AI 服务暂时不可用，请稍后重试。', 502);
  }
  return error;
}

async function generateReport({
  tasks,
  matrix,
  goals,
  distribution,
  modelClient,
  requestBody,
  now,
  signal,
  deadlineAt,
  onAttempt,
}) {
  const rawInput = requestBody || { tasks, matrix, goals, ...(distribution ? { distribution } : {}) };
  const input = Array.isArray(rawInput?.tasks)
    ? {
      ...rawInput,
      tasks: rawInput.tasks.map(task => (
        normalizeOptionalOwner(normalizeOptionalDue(task))
      )),
    }
    : rawInput;
  if (!validateRequest(input)) throw inputError();
  assertInputSemantics(input.tasks, input.matrix);
  const priorityContext = buildReportPriorityContext({
    tasks: input.tasks,
    matrix: input.matrix,
    now: now || Date.now,
    timeZone: 'Asia/Shanghai',
  });
  const scheduleContext = buildReportScheduleContext({
    tasks: input.tasks,
    now: now || Date.now,
    timeZone: 'Asia/Shanghai',
  });
  const businessDate = referenceDateInTimeZone(now || Date.now, 'Asia/Shanghai');
  const evidenceContext = {
    tasks: input.tasks,
    goals: input.goals,
    distribution: input.distribution,
    businessDate,
  };

  // 客户端"使用基础报告"：不调用模型，直接返回确定性基础报告
  if (rawInput?.baseOnly) {
    return {
      ...buildBaseReport(input, priorityContext),
      degraded: true,
      degradedReason: 'CLIENT_REQUESTED_BASE',
      degradedAttempts: 0,
    };
  }

  const modelInput = { ...input, priorityContext, scheduleContext };
  let retryFeedback;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const request = {
      system: loadStepPrompt('generate-report'),
      user: JSON.stringify(retryFeedback
        ? { ...modelInput, retryFeedback }
        : modelInput),
      temperature: 0.5,
      maxAttempts: 1,
      signal,
      deadlineAt,
      onAttempt,
    };

    try {
      const report = await modelClient.completeJson(request);
      if (!validateResponse(report)) {
        throw reportOutputError(REPORT_OUTPUT_REASON.REPORT_SCHEMA_INVALID);
      }
      assertReportSemantics(report, input.tasks, input.goals, priorityContext);
      if (!hasScheduleConflict(report, scheduleContext)) {
        assertEvidenceGate(report, evidenceContext);
        return report;
      }

      if (attempt < 2) {
        throw reportOutputError(REPORT_OUTPUT_REASON.REPORT_SCHEDULE_CONFLICT);
      }

      const stabilized = stabilizeScheduleConflicts(report, scheduleContext);
      if (!validateResponse(stabilized)) {
        throw reportOutputError(REPORT_OUTPUT_REASON.REPORT_SCHEMA_INVALID);
      }
      assertReportSemantics(
        stabilized,
        input.tasks,
        input.goals,
        priorityContext,
      );
      if (hasScheduleConflict(stabilized, scheduleContext)) {
        throw reportOutputError(REPORT_OUTPUT_REASON.REPORT_SCHEDULE_CONFLICT);
      }
      assertEvidenceGate(stabilized, evidenceContext);
      return stabilized;
    } catch (error) {
      const normalized = normalizeModelError(error);
      normalized.modelAttempts = attempt;
      if (normalized.code === 'MODEL_OUTPUT_INVALID' && attempt < 2) {
        retryFeedback = retryFeedbackFor(normalized.diagnosticCode);
        continue;
      }
      // 模型失败、输出违规或超时：不阻塞主流程，返回确定性基础报告
      return {
        ...buildBaseReport(input, priorityContext),
        degraded: true,
        degradedReason: normalized.diagnosticCode || normalized.code || 'MODEL_ERROR',
        degradedAttempts: attempt,
      };
    }
  }
  throw reportOutputError(REPORT_OUTPUT_REASON.REPORT_SCHEMA_INVALID);
}

module.exports = { containsTaskIdLeak, generateReport };
