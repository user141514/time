const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const {
  CATEGORY_KEYS,
  CATEGORY_TO_SOURCE,
  dedupeCrossSourceTasks,
  extractOwnerFromText,
  normalizeDueForWrite,
  normalizeTask,
  parseEstimatedMinutes,
} = require('../contracts/time-management');
const { shanghaiBusinessDay } = require('../daily-tracking/business-date');
const { extractDeadlineFromText } = require('../policies/deadline');
const { checkIntake, splitEntries } = require('./check-intake');
const { checkTaskSmart } = require('./check-task-smart');
const { DECOMPOSITION_ITEM_LIMIT } = require('./decomposition-contracts');
const { runEvidenceAgent } = require('./evidence-agent');
const {
  assertFactAtomTrace,
  assertNoAtomIdDuplicates,
  validateMergedEvidence,
} = require('./evidence-contracts');

const { runReconciliationAgent } = require('./reconciliation-agent');
const { runCriticAgent } = require('./critic-agent');

const PIPELINE_VERSION = 'multi-agent-v2-phase3';

function publicError(code, message, status) {
  return Object.assign(new Error(message), { code, status, expose: true });
}

function outputError(stage, failedRules = []) {
  return Object.assign(
    publicError('MODEL_OUTPUT_INVALID', 'AI 返回格式异常，请重试。', 502),
    { stage, failedRules },
  );
}

function linesForEntries(entries) {
  return Object.fromEntries(
    CATEGORY_KEYS.map(key => [key, splitEntries(entries[key])]),
  );
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeEstimateRef(value) {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .trim()
    .replace(/[。；;，,]+$/u, '')
    .replace(/^(?:(?:预计|大约|约|耗时)\s*)+/u, '');
  const minutes = parseEstimatedMinutes(cleaned);
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  if (minutes < 60) return `${minutes}分钟`;
  return `${Number((minutes / 60).toFixed(2))}h`;
}

// 四个维度各跑一个 evidence agent（昨天/今天/明天/后天），并行无依赖。
// 每个 agent 只抽取自己维度的 FactAtom；空维度跳过。合并后做一次边界校验。
async function runEvidenceAgents({
  modelClient,
  entries,
  businessDate,
  signal,
  deadlineAt,
  responseFormatMode,
  maxTokens,
  onAttempt,
  monotonicNow,
}) {
  const startedAt = monotonicNow();
  const results = await Promise.all(CATEGORY_KEYS.map(dimension => {
    if (splitEntries(entries?.[dimension]).length === 0) {
      return { dimension, atoms: [], attempts: 0, durationMs: 0, responseFormat: null };
    }
    return runEvidenceAgent({
      dimension,
      entries,
      businessDate,
      modelClient,
      signal,
      deadlineAt,
      responseFormatMode,
      maxTokens,
      onAttempt,
      monotonicNow,
    });
  }));

  const byDimension = Object.fromEntries(results.map(result => [result.dimension, result.atoms]));
  const merged = { atoms: results.flatMap(result => result.atoms), byDimension };
  if (!validateMergedEvidence(merged)) {
    throw outputError('evidence-agents', ['MERGED_EVIDENCE_SCHEMA_INVALID']);
  }
  // 每个 agent 内部已做过行级 trace 校验；合并边界只需防跨维度 ID 重复
  assertNoAtomIdDuplicates(merged.atoms);
  const lines = linesForEntries(entries);
  for (const dimension of CATEGORY_KEYS) {
    assertFactAtomTrace(merged.byDimension[dimension], lines[dimension]);
  }

  return {
    atoms: merged.atoms,
    byDimension,
    totalAttempts: results.reduce((sum, result) => sum + result.attempts, 0),
    totalDurationMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
    responseFormat: results.find(result => result.responseFormat)?.responseFormat
      || (responseFormatMode === 'json_object' ? 'json_object' : 'json_schema'),
  };
}

function primaryAtomScore(atom) {
  let score = 0;
  if (atom.dimension === '今天' && atom.status === 'in_progress') score = 600;
  else if (atom.dimension === '今天' && atom.status === 'planned') score = 550;
  else if (atom.status === 'in_progress') score = 500;
  else if (atom.status === 'planned' && atom.dimension === '明天') score = 450;
  else if (atom.status === 'planned' && atom.dimension === '后天') score = 425;
  else if (atom.status === 'planned') score = 400;
  else if (atom.status === 'unfinished' && atom.dimension === '今天') score = 350;
  else if (atom.status === 'unfinished') score = 300;
  else score = 100;
  if (atom.actor?.role === 'explicit' && atom.actor?.name) score += 20;
  if (atom.dueRef) score += 10;
  if (atom.estimateRef) score += 5;
  return score;
}

function selectPrimaryAtom(workAtoms) {
  return [...workAtoms].sort((left, right) => (
    primaryAtomScore(right) - primaryAtomScore(left)
  ))[0];
}

function conflictsForCluster(conflicts, cluster) {
  const clusterAtoms = new Set(cluster.atomIds);
  return conflicts.filter(conflict => (
    conflict.atomIds.every(atomId => clusterAtoms.has(atomId))
  ));
}

function explicitAcceptanceCriteria(atoms) {
  const seen = new Set();
  const criteria = [];
  for (const atom of atoms) {
    for (const item of atom.acceptanceCriteria || []) {
      const normalized = String(item).trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      criteria.push(normalized);
      if (criteria.length >= 5) return criteria;
    }
  }
  return criteria;
}

function explicitNextAction(atoms, primary) {
  if (primary?.nextActionRef?.trim()) return primary.nextActionRef.trim();
  return atoms.find(atom => atom.nextActionRef?.trim())?.nextActionRef.trim() || '';
}

function unresolvedFieldForFinding(category) {
  if (category === 'owner_hallucination' || category === 'semantic_role_error') return 'owner';
  if (category === 'due_contamination') return 'due';
  if (category === 'missing_evidence' || category === 'orphan_evidence') return 'evidence';
  if (category === 'duplicate_task') return 'duplicate';
  if (category === 'wrong_source') return 'source';
  return 'review';
}

function applyCriticFindings(compiled, findings = []) {
  const blockerCount = findings.filter(finding => finding.severity === 'blocker').length;
  const warningCount = findings.filter(finding => finding.severity === 'warning').length;
  const compiledItems = compiled.compiledItems.map(item => {
    const relevant = findings.filter(finding => finding.taskIds.includes(item.task.id));
    if (relevant.length === 0) {
      return {
        ...item,
        atomIds: [...item.atomIds],
        unresolvedFields: [...item.unresolvedFields],
      };
    }
    const unresolvedFields = new Set(item.unresolvedFields);
    let task = { ...item.task };
    for (const finding of relevant) {
      const field = unresolvedFieldForFinding(finding.category);
      unresolvedFields.add(field);
      if (finding.severity !== 'blocker') continue;
      if (field === 'owner') {
        task.owner = '待确认';
      }
      if (field === 'due') {
        const { dueTime, ...withoutDueTime } = task;
        task = { ...withoutDueTime, due: '待确认' };
      }
    }
    return {
      ...item,
      task,
      atomIds: [...item.atomIds],
      reviewRequired: true,
      unresolvedFields: [...unresolvedFields],
    };
  });
  return {
    tasks: compiledItems.map(item => item.task),
    compiledItems,
    taskAtoms: compiled.taskAtoms.map(item => ({ ...item })),
    governanceStatus: blockerCount > 0
      ? 'needs_confirmation'
      : (warningCount > 0 ? 'review_recommended' : 'accepted'),
  };
}

// Phase 2 编译：每个 WorkItemCluster 产生一条规范任务（多对一归并）。
// 无 cluster 的 work 原子按 1:1 回退编译。
function compileTasksFromClusters({ clusters = [], conflicts = [], atoms, byDimension, entries, now }) {
  const instant = now();
  const deadlineContext = { now: () => instant, timeZone: 'Asia/Shanghai' };
  const atomById = new Map(atoms.map(a => [a.id, a]));
  const clusteredAtomIds = new Set(clusters.flatMap(c => c.atomIds));
  const compiled = [];

  for (const cluster of clusters) {
    const clusterAtoms = cluster.atomIds.map(id => atomById.get(id)).filter(Boolean);
    const workAtoms = clusterAtoms.filter(a => a.kind === 'work');
    if (workAtoms.length === 0) continue;
    const primary = selectPrimaryAtom(workAtoms);
    const matchedConflicts = conflictsForCluster(conflicts, cluster);
    const unresolvedFields = [...new Set(matchedConflicts
      .filter(conflict => conflict.resolution === 'human_needed')
      .map(conflict => conflict.field))];
    if (cluster.mergedOwner.source === 'conflict' && !unresolvedFields.includes('owner')) {
      unresolvedFields.push('owner');
    }
    const dueUnresolved = unresolvedFields.includes('due');
    const ownerUnresolved = unresolvedFields.includes('owner');
    const extracted = dueUnresolved
      ? null
      : extractDeadlineFromText(
        cluster.mergedDueRef || primary.dueRef || primary.quote, deadlineContext,
      );
    const candidate = {
      name: cluster.label || primary.action || primary.quote,
      source: CATEGORY_TO_SOURCE[primary.dimension],
      due: extracted?.date || '待确认',
      ...(extracted?.time ? { dueTime: extracted.time } : {}),
      owner: ownerUnresolved
        ? '待确认'
        : (cluster.mergedOwner.source === 'explicit'
          ? cluster.mergedOwner.name
          : extractOwnerFromText(primary.quote) || '待确认'),
      status: 'pending',
      est: normalizeEstimateRef(
        workAtoms.find(item => normalizeEstimateRef(item.estimateRef))?.estimateRef,
      ),
      importance: null,
      urgency: null,
      acceptanceCriteria: explicitAcceptanceCriteria(clusterAtoms),
      nextAction: explicitNextAction(clusterAtoms, primary),
      classificationSource: 'unclassified',
    };
    const task = normalizeDueForWrite(normalizeTask(candidate));
    compiled.push({
      task,
      clusterId: cluster.id,
      atomIds: [...cluster.atomIds],
      reviewRequired: unresolvedFields.length > 0,
      unresolvedFields,
    });
  }
  // 未聚类 work 原子：1:1 回退编译
  for (const atom of atoms) {
    if (clusteredAtomIds.has(atom.id)) continue;
    if (atom.kind !== 'work') continue;
    const extracted = extractDeadlineFromText(atom.dueRef || atom.quote, deadlineContext);
    const candidate = {
      name: atom.action || atom.quote,
      source: CATEGORY_TO_SOURCE[atom.dimension],
      due: extracted?.date || '待确认',
      ...(extracted?.time ? { dueTime: extracted.time } : {}),
      owner: atom.actor.role === 'explicit'
        ? atom.actor.name
        : extractOwnerFromText(atom.quote) || '待确认',
      status: 'pending',
      est: normalizeEstimateRef(atom.estimateRef),
      importance: null,
      urgency: null,
      acceptanceCriteria: explicitAcceptanceCriteria([atom]),
      nextAction: explicitNextAction([atom], atom),
      classificationSource: 'unclassified',
    };
    const task = normalizeDueForWrite(normalizeTask(candidate));
    compiled.push({
      task,
      clusterId: null,
      atomIds: [atom.id],
      reviewRequired: false,
      unresolvedFields: [],
    });
  }
  const keptIds = new Set(dedupeCrossSourceTasks(compiled.map(item => item.task)).map(task => task.id));
  const kept = compiled.filter(item => keptIds.has(item.task.id));
  return {
    tasks: kept.map(item => item.task),
    compiledItems: kept.map(item => ({
      task: item.task,
      clusterId: item.clusterId,
      atomIds: [...item.atomIds],
      reviewRequired: item.reviewRequired,
      unresolvedFields: [...item.unresolvedFields],
    })),
    taskAtoms: kept.flatMap(item => item.atomIds.map(atomId => ({
      taskId: item.task.id,
      ...(item.clusterId ? { clusterId: item.clusterId } : {}),
      atomId,
    }))),
  };
}

async function decomposeTasks({
  entries,
  modelClient,
  requestBody,
  now = () => new Date(),
  monotonicNow = () => performance.now(),
  signal,
  deadlineAt,
  responseFormatMode,
  maxTokens,
  onAttempt,
  decompositionId = randomUUID(),
} = {}) {
  const input = requestBody || { entries };
  const intake = checkIntake({ requestBody: input });
  if (intake.totalLines > DECOMPOSITION_ITEM_LIMIT) {
    throw publicError(
      'DECOMPOSITION_ITEM_LIMIT_EXCEEDED',
      `快速拆解单次最多处理 ${DECOMPOSITION_ITEM_LIMIT} 项事务。`,
      422,
    );
  }

  const instant = now();
  const businessDate = shanghaiBusinessDay(instant).trackingDate;
  const stage = await runEvidenceAgents({
    modelClient,
    entries: intake.entries,
    businessDate,
    signal,
    deadlineAt,
    responseFormatMode,
    maxTokens,
    onAttempt,
    monotonicNow,
  });
  // Phase 2: Reconciliation — 跨栏聚类去重
  let reconciliationStage = null;
  let clusters = [];
  let conflicts = [];
  try {
    const reconResult = await runReconciliationAgent({
      atoms: stage.atoms,
      byDimension: stage.byDimension,
      entries: intake.entries,
      businessDate,
      modelClient,
      signal,
      deadlineAt,
      responseFormatMode,
      maxTokens,
      onAttempt,
      monotonicNow,
    });
    clusters = reconResult.clusters;
    conflicts = reconResult.conflicts;
    reconciliationStage = {
      name: 'reconciliation',
      status: 'succeeded',
      attempts: reconResult.attempts,
      durationMs: reconResult.durationMs,
      output: { clusters, conflicts },
    };
  } catch (error) {
    // Reconciliation 失败不阻塞主流程，回退到 1:1 编译
    reconciliationStage = {
      name: 'reconciliation',
      status: 'degraded',
      errorCode: error.code || 'RECONCILIATION_ERROR',
      fallbackMode: 'one-to-one',
    };
  }
  const compiled = compileTasksFromClusters({
    clusters,
    conflicts,
    atoms: stage.atoms,
    byDimension: stage.byDimension,
    entries: intake.entries,
    now: () => instant,
  });
  if (compiled.tasks.length === 0) {
    throw publicError(
      'NO_ACTIONABLE_TASKS',
      '没有识别出可执行任务，请调整四栏内容后重试。',
      422,
    );
  }

  // Phase 3: Critic — 5 路并行审查
  let criticStage = null;
  let governed = compiled;
  try {
    const criticResult = await runCriticAgent({
      compiledItems: compiled.compiledItems,
      clusters,
      atoms: stage.atoms,
      entries: intake.entries,
      businessDate,
      modelClient,
      signal,
      deadlineAt,
      responseFormatMode,
      maxTokens,
      onAttempt,
      monotonicNow,
    });
    governed = applyCriticFindings(compiled, criticResult.findings);
    criticStage = {
      name: 'critic',
      status: criticResult.status,
      attempts: criticResult.attempts,
      durationMs: criticResult.durationMs,
      output: {
        findings: criticResult.findings,
        checkResults: criticResult.checkResults,
        governanceStatus: governed.governanceStatus,
      },
    };
  } catch (error) {
    criticStage = {
      name: 'critic',
      status: 'degraded',
      errorCode: error.code || 'CRITIC_ERROR',
    };
  }

  const smart = checkTaskSmart({ tasks: governed.tasks });
  return {
    intake: {
      lineCounts: intake.lineCounts,
      totalLines: intake.totalLines,
      warnings: intake.warnings,
    },
    tasks: governed.tasks,
    smart,
    decomposition: {
      pipelineVersion: PIPELINE_VERSION,
      decompositionId,
      businessDate,
      stages: [{
        name: 'evidence-agents',
        status: 'succeeded',
        attempts: stage.totalAttempts,
        durationMs: stage.totalDurationMs,
        responseFormat: stage.responseFormat,
        output: stage.byDimension,
      },
      ...(reconciliationStage ? [reconciliationStage] : []),
      ...(criticStage ? [criticStage] : []),
      ],
      taskAtoms: governed.taskAtoms,
    },
  };
}

module.exports = {
  applyCriticFindings,
  compileTasksFromClusters,
  decomposeTasks,
  runEvidenceAgents,
};
