const { readFileSync } = require('node:fs');
const { performance } = require('node:perf_hooks');

const { SOURCE_TO_CATEGORY } = require('../contracts/time-management');
const { extractDeadlineFromText } = require('../policies/deadline');
const { decomposeTasks } = require('../workflows/decompose-tasks');
const { splitEntries } = require('../workflows/check-intake');
const { isDirectlyRelatedAuxiliary } = require('../workflows/task-evidence-policy');

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadJsonl(filename) {
  const source = readFileSync(filename, 'utf8');
  const cases = [];
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL at ${filename}:${index + 1}: ${error.message}`);
    }
    if (!value.id || !value.businessDate || !value.entries || !value.expected) {
      throw new Error(`Incomplete evaluation case at ${filename}:${index + 1}`);
    }
    cases.push(value);
  }
  if (!cases.length) throw new Error(`No evaluation cases found in ${filename}`);
  return cases;
}

function claim(text, evidenceIds = []) {
  return { text, evidenceIds };
}

function firstEvidenceIds(evidence, dimension) {
  return evidence.filter(item => item.dimension === dimension).map(item => item.id);
}

function buildCoachingAnalysis(testCase, evidence) {
  const ids = {
    昨天: firstEvidenceIds(evidence, '昨天'),
    今天: firstEvidenceIds(evidence, '今天'),
    明天: firstEvidenceIds(evidence, '明天'),
    后天: firstEvidenceIds(evidence, '后天'),
  };
  const supported = (dimension, fallback) => ids[dimension].length
    ? claim(fallback, ids[dimension])
    : claim(`证据不足：${dimension}栏没有足够信息。`, []);
  const causeEvidence = evidence.filter(item => item.kind === 'cause');
  const rootCause = testCase.expected.rootCauseMode === 'insufficient'
    || causeEvidence.length === 0
    ? claim('证据不足：原文没有提供可以验证的根因。', [])
    : claim('原文已提供原因线索，需要在执行中继续验证。', causeEvidence.map(item => item.id));
  const allIds = evidence.map(item => item.id);

  return {
    yesterday_analysis: {
      key_problem: supported('昨天', '昨天输入暴露了需要继续处理的问题或行动。'),
      gap: supported('昨天', '实际状态与预期之间仍存在差距。'),
      root_cause: rootCause,
      management_insight: supported('昨天', '需要把复盘结果转成明确责任和行动。'),
    },
    today_focus: {
      key_work: supported('今天', '今天应聚焦原文列出的关键行动。'),
      priority_reason: supported('今天', '这些事项直接影响当前交付或推进。'),
      manager_action: supported('今天', '明确下一步、责任人和完成条件。'),
      possible_delegation: supported('今天', '可依据原文责任主体判断授权边界。'),
    },
    tomorrow_optimization: {
      management_improvement: supported('明天', '将短期目标拆成可检查的改进行动。'),
      system_building: supported('明天', '形成可复用的流程或机制产物。'),
      capability_upgrade: supported('明天', '围绕目标补齐团队能力。'),
    },
    future_direction: {
      long_term_goal: supported('后天', '长期方向需要转成阶段里程碑。'),
      organization_capability: supported('后天', '围绕长期目标建设组织能力。'),
      future_focus: supported('后天', '先明确近期可执行的第一步。'),
    },
    connection_analysis: {
      problem_to_action: allIds.length
        ? claim('已依据原文证据检查问题到行动的连接。', allIds)
        : claim('证据不足：无法判断问题与行动之间的连接。', []),
      action_to_optimization: allIds.length
        ? claim('已依据原文证据检查行动到优化的连接。', allIds)
        : claim('证据不足：无法判断行动与优化之间的连接。', []),
      optimization_to_future: allIds.length
        ? claim('已依据原文证据检查优化到长期方向的连接。', allIds)
        : claim('证据不足：无法判断优化与长期方向之间的连接。', []),
    },
    coaching_suggestions: [],
    overall_insight: allIds.length
      ? claim('当前应优先把原文中的未完成事项转成可执行任务。', allIds)
      : claim('证据不足：当前输入没有可执行内容。', []),
  };
}

function buildReplayCoachResponse(testCase) {
  const evidence = (testCase.expected.evidence || []).map((item, index) => {
    const sourceLines = splitEntries(testCase.entries[item.dimension]);
    const sourceLineIndex = sourceLines.findIndex(line => line.includes(item.quote));
    return {
      id: `E${index + 1}`,
      dimension: item.dimension,
      sourceLineIndex,
      quote: item.quote,
      observation: item.observation || item.quote,
      kind: item.kind,
      status: item.status,
      owner: item.owner || '待确认',
      due: item.dueRaw || '待确认',
    };
  });
  return {
    evidence,
    coachingAnalysis: buildCoachingAnalysis(testCase, evidence),
  };
}

function buildReplayTaskResponse(testCase) {
  return {
    tasks: (testCase.expected.tasks || []).map(item => ({
      name: item.name,
      importance: item.importance,
      urgency: item.urgency,
      source: item.source,
      due: item.dueRaw || '待确认',
      est: item.est,
      owner: item.owner || '待确认',
      acceptanceCriteria: item.acceptanceCriteria || [],
      nextAction: item.nextAction || '',
      status: 'pending',
      evidenceIds: (item.evidenceIndexes || []).map(index => `E${index + 1}`),
    })),
  };
}

function buildReplayEvidenceTaskResponse(testCase) {
  return {
    evidence: buildReplayCoachResponse(testCase).evidence,
    tasks: buildReplayTaskResponse(testCase).tasks,
  };
}

function createReplayModel(testCase) {
  const combined = buildReplayEvidenceTaskResponse(testCase);
  const calls = [];
  return {
    calls,
    async completeJson(input) {
      calls.push(input);
      if (input.responseSchemaName === 'time_evidence_task_generation_v2') {
        return deepClone(combined);
      }
      if (input.responseSchemaName === 'time_task_generation_v2') {
        return { tasks: deepClone(combined.tasks) };
      }
      throw new Error(`Unexpected response schema: ${input.responseSchemaName}`);
    },
  };
}

function nowForBusinessDate(dateText) {
  return new Date(`${dateText}T04:00:00.000Z`);
}

function textContainsAll(text, keywords = []) {
  const value = String(text || '');
  return keywords.every(keyword => value.includes(keyword));
}

function taskMatchScore(expected, actual) {
  const exact = expected.name && expected.name === actual.name;
  const nameKeywords = expected.nameKeywords || [];
  const keywordMatch = nameKeywords.length > 0 && textContainsAll(actual.name, nameKeywords);
  if (!exact && !keywordMatch) return -1;
  let score = exact ? 20 : 10;
  if (expected.source === actual.source) score += 5;
  if ((expected.owner || '待确认') === actual.owner) score += 2;
  if ((expected.due || '待确认') === actual.due) score += 2;
  return score;
}

function pairTasks(expectedTasks, actualTasks) {
  const candidates = [];
  for (let expectedIndex = 0; expectedIndex < expectedTasks.length; expectedIndex += 1) {
    for (let actualIndex = 0; actualIndex < actualTasks.length; actualIndex += 1) {
      const score = taskMatchScore(expectedTasks[expectedIndex], actualTasks[actualIndex]);
      if (score >= 0) candidates.push({ expectedIndex, actualIndex, score });
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  const usedExpected = new Set();
  const usedActual = new Set();
  const pairs = [];
  for (const candidate of candidates) {
    if (usedExpected.has(candidate.expectedIndex) || usedActual.has(candidate.actualIndex)) continue;
    usedExpected.add(candidate.expectedIndex);
    usedActual.add(candidate.actualIndex);
    pairs.push(candidate);
  }
  return pairs;
}

function findEvidenceMatch(expected, actualEvidence) {
  const quoteKeywords = expected.quoteKeywords || [];
  return actualEvidence.find(item => (
    item.dimension === expected.dimension
    && (
      item.quote === expected.quote
      || (quoteKeywords.length > 0 && textContainsAll(item.quote, quoteKeywords))
      || (quoteKeywords.length > 0 && textContainsAll(item.observation, quoteKeywords))
    )
  ));
}

function taskSourceText(entries, task) {
  const category = SOURCE_TO_CATEGORY[task.source] || '今天';
  return entries[category] || '';
}

function evaluateSuccessfulCase(testCase, result) {
  const expectedTasks = testCase.expected.tasks || [];
  const actualTasks = result.tasks || [];
  const pairs = pairTasks(expectedTasks, actualTasks);
  const evidenceStage = result.decomposition?.stages?.find(item => (
    item.name === 'evidence-task-generation' || item.name === 'coach-analysis'
  ));
  const coachingStage = result.decomposition?.stages?.find(item => (
    item.name === 'coaching-analysis' || item.name === 'coach-analysis'
  ));
  const actualEvidence = evidenceStage?.output?.evidence || [];
  const expectedEvidence = testCase.expected.evidence || [];
  const evidenceMatches = expectedEvidence.map(item => ({
    expected: item,
    actual: findEvidenceMatch(item, actualEvidence),
  }));

  const fieldTotals = {
    source: 0,
    owner: 0,
    due: 0,
    importance: 0,
    urgency: 0,
    acceptance: 0,
    nextAction: 0,
  };
  for (const pair of pairs) {
    const expected = expectedTasks[pair.expectedIndex];
    const actual = actualTasks[pair.actualIndex];
    fieldTotals.source += Number(expected.source === actual.source);
    fieldTotals.owner += Number((expected.owner || '待确认') === actual.owner);
    fieldTotals.due += Number((expected.due || '待确认') === actual.due);
    fieldTotals.importance += Number(expected.importance === actual.importance);
    fieldTotals.urgency += Number(expected.urgency === actual.urgency);
    const criteriaText = (actual.acceptanceCriteria || []).join('\n');
    fieldTotals.acceptance += Number(
      (expected.acceptanceKeywords || []).every(keyword => criteriaText.includes(keyword)),
    );
    fieldTotals.nextAction += Number(
      textContainsAll(actual.nextAction, expected.nextActionKeywords || []),
    );
  }

  const evidenceStatusCorrect = evidenceMatches.filter(item => (
    item.actual && item.actual.status === item.expected.status
  )).length;
  const evidenceKindCorrect = evidenceMatches.filter(item => (
    item.actual && item.actual.kind === item.expected.kind
  )).length;
  const evidenceOwnerCorrect = evidenceMatches.filter(item => (
    item.actual && item.actual.owner === (item.expected.owner || '待确认')
  )).length;
  const evidenceDueCorrect = evidenceMatches.filter(item => (
    item.actual && item.actual.due === (item.expected.dueRaw || '待确认')
  )).length;

  const evidenceById = new Map(actualEvidence.map(item => [item.id, item]));
  const taskEvidenceById = new Map(
    (result.decomposition?.taskEvidence || []).map(item => [item.taskId, item.evidenceIds]),
  );
  let completedLeakage = 0;
  for (const task of actualTasks) {
    const linked = (taskEvidenceById.get(task.id) || []).map(id => evidenceById.get(id));
    if (linked.some(item => item?.status === 'completed')) completedLeakage += 1;
  }

  const expectedYesterdayActionable = expectedEvidence.filter(item => (
    item.dimension === '昨天' && ['planned', 'unfinished'].includes(item.status)
  ));
  let yesterdayCovered = 0;
  for (const expected of expectedYesterdayActionable) {
    const actual = findEvidenceMatch(expected, actualEvidence);
    if (!actual) continue;
    const covered = actualTasks.some(task => {
      const evidenceIds = taskEvidenceById.get(task.id) || [];
      const position = evidenceIds.indexOf(actual.id);
      if (position === 0) return true;
      if (position < 1) return false;
      const primary = evidenceById.get(evidenceIds[0]);
      return isDirectlyRelatedAuxiliary(primary, actual);
    });
    if (covered) yesterdayCovered += 1;
  }

  const rootCauseRequired = Number(
    coachingStage && testCase.expected.rootCauseMode === 'insufficient',
  );
  let rootCauseCorrect = 0;
  if (rootCauseRequired) {
    const text = coachingStage?.output?.coachingAnalysis?.yesterday_analysis?.root_cause?.text || '';
    rootCauseCorrect = Number(text.startsWith('证据不足'));
  }

  let ownerHallucinations = 0;
  let dueHallucinations = 0;
  for (const task of actualTasks) {
    const sourceText = taskSourceText(testCase.entries, task);
    if (task.owner !== '待确认' && !sourceText.includes(task.owner)) ownerHallucinations += 1;
    if (task.due !== '待确认') {
      const linked = (taskEvidenceById.get(task.id) || []).map(id => evidenceById.get(id));
      const fromEvidence = linked.some(item => item && item.due !== '待确认');
      // 服务端确定性提取的原文期限与 evidence 同等可信（原文期限 > evidence期限）
      const fromSourceText = extractDeadlineFromText(sourceText, {
        now: () => nowForBusinessDate(testCase.businessDate),
        timeZone: 'Asia/Shanghai',
      })?.date === task.due;
      if (!fromEvidence && !fromSourceText) dueHallucinations += 1;
    }
  }

  const failures = [];
  if (pairs.length !== expectedTasks.length) failures.push('TASK_RECALL_MISS');
  if (pairs.length !== actualTasks.length && !testCase.expected.allowExtraTasks) {
    failures.push('UNEXPECTED_TASKS');
  }
  if (evidenceMatches.some(item => !item.actual)) failures.push('EVIDENCE_MISSING');
  if (evidenceStatusCorrect !== expectedEvidence.length) failures.push('EVIDENCE_STATUS_MISMATCH');
  if (evidenceKindCorrect !== expectedEvidence.length) failures.push('EVIDENCE_KIND_MISMATCH');
  if (evidenceOwnerCorrect !== expectedEvidence.length) failures.push('EVIDENCE_OWNER_MISMATCH');
  if (evidenceDueCorrect !== expectedEvidence.length) failures.push('EVIDENCE_DUE_MISMATCH');
  if (completedLeakage) failures.push('COMPLETED_EVIDENCE_LEAKAGE');
  if (yesterdayCovered !== expectedYesterdayActionable.length) {
    failures.push('YESTERDAY_ACTIONABLE_NOT_COVERED');
  }
  if (rootCauseRequired && !rootCauseCorrect) failures.push('ROOT_CAUSE_INVENTED');
  if (ownerHallucinations) failures.push('OWNER_HALLUCINATION');
  if (dueHallucinations) failures.push('DUE_HALLUCINATION');
  for (const [field, correct] of Object.entries(fieldTotals)) {
    if (correct !== pairs.length) failures.push(`${field.toUpperCase()}_MISMATCH`);
  }

  return {
    id: testCase.id,
    description: testCase.description,
    tags: testCase.tags || [],
    passed: failures.length === 0,
    failures: [...new Set(failures)],
    expectedTaskCount: expectedTasks.length,
    actualTaskCount: actualTasks.length,
    matchedTaskCount: pairs.length,
    expectedEvidenceCount: expectedEvidence.length,
    matchedEvidenceCount: evidenceMatches.filter(item => item.actual).length,
    evidenceStatusCorrect,
    evidenceKindCorrect,
    evidenceOwnerCorrect,
    evidenceDueCorrect,
    fieldTotals,
    completedLeakage,
    ownerHallucinations,
    dueHallucinations,
    expectedYesterdayActionable: expectedYesterdayActionable.length,
    yesterdayCovered,
    rootCauseRequired,
    rootCauseCorrect,
  };
}

function evaluateErrorCase(testCase, error) {
  const expectedError = testCase.expected.errorCode;
  const passed = Boolean(error && error.code === expectedError);
  return {
    id: testCase.id,
    description: testCase.description,
    tags: testCase.tags || [],
    passed,
    failures: passed ? [] : [`EXPECTED_${expectedError}_GOT_${error?.code || 'SUCCESS'}`],
    expectedTaskCount: 0,
    actualTaskCount: 0,
    matchedTaskCount: 0,
    expectedEvidenceCount: 0,
    matchedEvidenceCount: 0,
    evidenceStatusCorrect: 0,
    evidenceKindCorrect: 0,
    evidenceOwnerCorrect: 0,
    evidenceDueCorrect: 0,
    fieldTotals: {
      source: 0, owner: 0, due: 0, importance: 0, urgency: 0, acceptance: 0, nextAction: 0,
    },
    completedLeakage: 0,
    ownerHallucinations: 0,
    dueHallucinations: 0,
    expectedYesterdayActionable: 0,
    yesterdayCovered: 0,
    rootCauseRequired: 0,
    rootCauseCorrect: 0,
  };
}

function summarize(caseResults, mode) {
  const total = caseResults.length;
  const passed = caseResults.filter(item => item.passed).length;
  const sum = key => caseResults.reduce((value, item) => value + (item[key] || 0), 0);
  const fieldTotals = Object.fromEntries(
    ['source', 'owner', 'due', 'importance', 'urgency', 'acceptance', 'nextAction'].map(field => [
      field,
      caseResults.reduce((value, item) => value + (item.fieldTotals?.[field] || 0), 0),
    ]),
  );
  const expectedTasks = sum('expectedTaskCount');
  const actualTasks = sum('actualTaskCount');
  const matchedTasks = sum('matchedTaskCount');
  const precision = actualTasks ? matchedTasks / actualTasks : 1;
  const recall = expectedTasks ? matchedTasks / expectedTasks : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    mode,
    cases: total,
    passed,
    failed: total - passed,
    passRate: total ? passed / total : 0,
    tasks: {
      expected: expectedTasks,
      actual: actualTasks,
      matched: matchedTasks,
      precision,
      recall,
      f1,
    },
    evidence: {
      expected: sum('expectedEvidenceCount'),
      matched: sum('matchedEvidenceCount'),
      statusCorrect: sum('evidenceStatusCorrect'),
      kindCorrect: sum('evidenceKindCorrect'),
      ownerCorrect: sum('evidenceOwnerCorrect'),
      dueCorrect: sum('evidenceDueCorrect'),
    },
    taskFields: fieldTotals,
    safety: {
      completedLeakage: sum('completedLeakage'),
      ownerHallucinations: sum('ownerHallucinations'),
      dueHallucinations: sum('dueHallucinations'),
    },
    yesterday: {
      expectedActionable: sum('expectedYesterdayActionable'),
      covered: sum('yesterdayCovered'),
    },
    rootCause: {
      requiredInsufficient: sum('rootCauseRequired'),
      correctlyMarkedInsufficient: sum('rootCauseCorrect'),
    },
    failures: caseResults.filter(item => !item.passed).map(item => ({
      id: item.id,
      description: item.description,
      failures: item.failures,
    })),
  };
}

function normalizeLiveRequestOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('liveRequestOptions must be an object');
  }
  const monotonicNow = options.monotonicNow || (() => performance.now());
  if (typeof monotonicNow !== 'function') {
    throw new Error('liveRequestOptions.monotonicNow must be a function');
  }
  for (const key of ['maxTokens', 'taskRouteBudgetMs']) {
    const value = options[key];
    if (value != null && (!Number.isInteger(value) || value < 1)) {
      throw new Error(`liveRequestOptions.${key} must be a positive integer`);
    }
  }
  if (
    options.responseFormatMode != null
    && !['auto', 'json_schema', 'json_object'].includes(options.responseFormatMode)
  ) {
    throw new Error('liveRequestOptions.responseFormatMode is invalid');
  }
  return Object.freeze({
    maxTokens: options.maxTokens,
    monotonicNow,
    responseFormatMode: options.responseFormatMode,
    taskRouteBudgetMs: options.taskRouteBudgetMs,
  });
}

async function runEvaluation({
  cases,
  mode = 'replay',
  liveModelClient = null,
  liveRequestOptions,
} = {}) {
  if (!Array.isArray(cases) || !cases.length) throw new Error('Evaluation cases are required');
  if (!['replay', 'live'].includes(mode)) throw new Error(`Unknown evaluation mode: ${mode}`);
  if (mode === 'live' && !liveModelClient) throw new Error('liveModelClient is required in live mode');
  const liveOptions = mode === 'live'
    ? normalizeLiveRequestOptions(liveRequestOptions)
    : null;

  const caseResults = [];
  for (const testCase of cases) {
    const modelClient = mode === 'replay' ? createReplayModel(testCase) : liveModelClient;
    let result = null;
    let error = null;
    try {
      const deadlineAt = liveOptions?.taskRouteBudgetMs == null
        ? undefined
        : liveOptions.monotonicNow() + liveOptions.taskRouteBudgetMs;
      result = await decomposeTasks({
        entries: testCase.entries,
        modelClient,
        now: () => nowForBusinessDate(testCase.businessDate),
        monotonicNow: liveOptions?.monotonicNow,
        deadlineAt,
        responseFormatMode: liveOptions?.responseFormatMode,
        maxTokens: liveOptions?.maxTokens,
      });
    } catch (caught) {
      error = caught;
    }

    if (testCase.expected.errorCode) {
      caseResults.push(evaluateErrorCase(testCase, error));
      continue;
    }
    if (error) {
      caseResults.push({
        ...evaluateErrorCase(testCase, error),
        passed: false,
        failures: [`UNEXPECTED_${error.code || 'ERROR'}`],
      });
      continue;
    }
    caseResults.push(evaluateSuccessfulCase(testCase, result));
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: summarize(caseResults, mode),
    cases: caseResults,
  };
}

module.exports = {
  buildReplayCoachResponse,
  buildReplayEvidenceTaskResponse,
  buildReplayTaskResponse,
  createReplayModel,
  loadJsonl,
  runEvaluation,
};
