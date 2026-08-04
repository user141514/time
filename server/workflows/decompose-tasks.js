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
const { hardenFactAtoms } = require('./evidence-hardening');
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
    .replace(/^(?:(?:预计(?:还)?(?:需要|需)?|大概|大约|约|耗时|还需要|还需)\s*)+/u, '');
  const minutes = parseEstimatedMinutes(cleaned);
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  if (minutes < 60) return `${minutes}分钟`;
  return `${Number((minutes / 60).toFixed(2))}h`;
}

const DIMENSION_DEADLINE_PREFIX = Object.freeze({
  今天: '今天',
  明天: '明天',
  后天: '后天',
});
const EXPLICIT_DATE_SIGNAL = /今天|今日|明天|明日|后天|本周|月底|月末|20\d{2}|\d{1,2}月/u;
const BARE_CLOCK_DEADLINE = /(?:(?:上午|下午|晚上|今晚|今夜|凌晨|中午|傍晚)\s*)?\d{1,2}(?::|：|点)\d{0,2}\s*(?:前|之前|截止|内)/u;

function anchorDeadlineText(text, dimension) {
  const value = String(text || '').trim();
  const prefix = DIMENSION_DEADLINE_PREFIX[dimension];
  if (!value || !prefix || EXPLICIT_DATE_SIGNAL.test(value) || !BARE_CLOCK_DEADLINE.test(value)) {
    return value;
  }
  return `${prefix}${value}`;
}

function deadlineRefForAtom(atom) {
  return anchorDeadlineText(atom?.dueRef, atom?.dimension);
}

function deadlineQuoteForAtom(atom) {
  const quote = String(atom?.quote || '').trim();
  if (
    atom?.dimension === '今天'
    && !String(atom?.dueRef || '').trim()
    && /^(?:今天|今日)/u.test(quote)
  ) {
    return quote.replace(/^(?:今天|今日)\s*/u, '');
  }
  return anchorDeadlineText(quote, atom?.dimension);
}

function groundedClusterDueRef(cluster, clusterAtoms) {
  const mergedDueRef = String(cluster?.mergedDueRef || '').trim();
  if (!mergedDueRef) return '';
  const backingAtom = clusterAtoms.find(atom => String(atom.dueRef || '').trim() === mergedDueRef);
  return backingAtom ? anchorDeadlineText(mergedDueRef, backingAtom.dimension) : '';
}

function firstParsedDeadline(texts, context) {
  for (const text of texts) {
    if (typeof text !== 'string' || !text.trim()) continue;
    const parsed = extractDeadlineFromText(text, context);
    if (parsed) return parsed;
  }
  return null;
}

function rewriteCrossAgentAtomIdCollisions(results) {
  const counts = new Map();
  const reserved = new Set();
  for (const result of results) {
    for (const atom of result.atoms) {
      counts.set(atom.id, (counts.get(atom.id) || 0) + 1);
      reserved.add(atom.id);
    }
  }

  let suffix = 0;
  return results.map((result, dimensionIndex) => ({
    ...result,
    atoms: result.atoms.map((atom, atomIndex) => {
      if (counts.get(atom.id) === 1) return atom;
      let candidate = `srv-atom-${dimensionIndex + 1}-${atomIndex + 1}`;
      while (reserved.has(candidate)) {
        suffix += 1;
        candidate = `srv-atom-${dimensionIndex + 1}-${atomIndex + 1}-${suffix}`;
      }
      reserved.add(candidate);
      return { ...atom, id: candidate };
    }),
  }));
}

// 四个维度各跑一个 evidence agent（昨天/今天/明天/后天），并行无依赖。
// 每个 agent 只抽取自己维度的 FactAtom；空维度跳过。合并后做一次边界校验。
// 各并行模型无法协调全局 ID，因此跨 agent 冲突由服务端统一改写。
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

  const lines = linesForEntries(entries);
  const normalizedResults = rewriteCrossAgentAtomIdCollisions(results).map(result => ({
    ...result,
    atoms: hardenFactAtoms(result.atoms, lines[result.dimension]),
  }));
  const byDimension = Object.fromEntries(
    normalizedResults.map(result => [result.dimension, result.atoms]),
  );
  const merged = { atoms: normalizedResults.flatMap(result => result.atoms), byDimension };
  if (!validateMergedEvidence(merged)) {
    throw outputError('evidence-agents', ['MERGED_EVIDENCE_SCHEMA_INVALID']);
  }
  // 每个 agent 内部已做过行级 trace 校验；合并边界只需防跨维度 ID 重复
  assertNoAtomIdDuplicates(merged.atoms);
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

function isAncillaryAction(atom) {
  const action = String(atom?.action || atom?.quote || '').trim();
  return /^(?:并)?(?:抄送|知会|通知|同步给)/u.test(action)
    || /^(?:并)?(?:提交|上传|保存)到.{1,24}/u.test(action)
    || /^(?:并)?(?:发邮件|发送邮件|发送|提交)给.{1,24}(?:审阅|审核|审批)/u.test(action)
    || /^(?:并)?向.{1,24}(?:汇报|审阅|审核|审批)/u.test(action);
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
  if (isAncillaryAction(atom)) score -= 250;
  return score;
}

function relationPrimaryBonus(atom, relations = []) {
  let bonus = 0;
  let incomingContinuation = 0;
  let outgoingContinuation = 0;
  for (const relation of relations) {
    if (relation.toAtom === atom.id) {
      if (relation.type === 'continuation') {
        incomingContinuation += 1;
        bonus += 80;
      } else if (relation.type === 'dependency') bonus += 30;
      else if (relation.type === 'same_work_item') bonus += 10;
    }
    if (relation.fromAtom === atom.id && relation.type === 'continuation') {
      outgoingContinuation += 1;
      bonus -= 20;
    }
  }
  if (incomingContinuation > 0 && outgoingContinuation === 0) bonus += 180;
  return bonus;
}

function selectPrimaryAtom(workAtoms, relations = []) {
  const todayAtoms = workAtoms.filter(atom => atom.dimension === '今天');
  const candidates = todayAtoms.length ? todayAtoms : workAtoms;
  const candidateIds = new Set(candidates.map(atom => atom.id));
  const candidateRelations = relations.filter(relation => (
    candidateIds.has(relation.fromAtom) && candidateIds.has(relation.toAtom)
  ));
  return [...candidates].sort((left, right) => (
    primaryAtomScore(right) + relationPrimaryBonus(right, candidateRelations)
    - primaryAtomScore(left) - relationPrimaryBonus(left, candidateRelations)
  ))[0];
}

function stripProgressPrefix(value) {
  const stripped = String(value || '').replace(/^(?:接手|继续|开始|正在)\s*/u, '').trim();
  return stripped.replace(/^写(?=\p{Script=Han}|[A-Za-z0-9])/u, '编写');
}

function canonicalClusterTaskName(primary, cluster, clusterAtoms) {
  const workAtoms = clusterAtoms.filter(atom => atom.kind === 'work');
  const primaryAction = String(primary?.action || '').trim();
  const genericOutcome = /^(?:完成|提交|输出|形成)(初稿|终稿|草稿|最终版)$/u.exec(primaryAction);
  let baseName = stripProgressPrefix(primaryAction || cluster.label || primary?.quote);
  if (genericOutcome) {
    const outcome = genericOutcome[1];
    const objectAtom = [...workAtoms]
      .filter(atom => atom.id !== primary.id && atom.action && !isAncillaryAction(atom))
      .sort((left, right) => {
        const leftSameDimension = Number(left.dimension === primary.dimension);
        const rightSameDimension = Number(right.dimension === primary.dimension);
        return rightSameDimension - leftSameDimension || right.action.length - left.action.length;
      })
      .find(atom => !/^(?:完成|提交|输出|形成)(?:初稿|终稿|草稿|最终版)$/u.test(atom.action));
    const base = stripProgressPrefix(objectAtom?.action || cluster.label);
    if (base && !base.includes(outcome)) baseName = `${base}${outcome}`;
  }
  const ancillaryActions = clusterAtoms
    .filter(atom => atom.id !== primary.id && isAncillaryAction(atom))
    .map(atom => String(atom.action || atom.quote).replace(/^并/u, '').trim())
    .filter(action => action && !baseName.includes(action));
  return ancillaryActions.length ? `${baseName}并${ancillaryActions.join('并')}` : baseName;
}

function conflictsForCluster(conflicts, cluster) {
  const clusterAtoms = new Set(cluster.atomIds);
  return conflicts.filter(conflict => (
    conflict.atomIds.every(atomId => clusterAtoms.has(atomId))
  ));
}

function mergedOwnerForAtom(atom) {
  return atom.actor?.role === 'explicit' && atom.actor?.name
    ? { name: atom.actor.name, source: 'explicit' }
    : { name: '', source: 'implied' };
}

function mergedStatusForAtom(atom) {
  return atom.status === 'unfinished' ? 'unfinished' : 'planned';
}

const CONTRASTING_SCOPE_GROUPS = Object.freeze([
  ['前端', '后端'],
  ['客户端', '服务端'],
  ['线上', '线下'],
  ['国内', '海外'],
]);

function hasContrastingScopes(workAtoms) {
  const texts = workAtoms.map(atom => `${atom.action || ''}\n${atom.quote || ''}`);
  return CONTRASTING_SCOPE_GROUPS.some(group => (
    group.filter(term => texts.some(text => text.includes(term))).length > 1
  ));
}

function hasContrastingTaskScopes(leftName, rightName) {
  const left = String(leftName || '');
  const right = String(rightName || '');
  return CONTRASTING_SCOPE_GROUPS.some(group => (
    group.some(term => left.includes(term))
    && group.some(term => right.includes(term))
    && !group.some(term => left.includes(term) && right.includes(term))
  ));
}

function canonicalCrossSourceTaskName(name) {
  return String(name || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/<[^>]*>/gu, '')
    .replace(/^(?:完成|继续|开始|正在|接手)\s*/u, '')
    .replace(/(?:项目计划书|计划书|项目|的)/gu, '')
    .replace(/[^\p{Script=Han}a-z0-9]/gu, '');
}

function crossSourceTaskNamesMatch(leftName, rightName) {
  if (hasContrastingTaskScopes(leftName, rightName)) return false;
  const left = canonicalCrossSourceTaskName(leftName);
  const right = canonicalCrossSourceTaskName(rightName);
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  return shorter.length >= 6
    && longer.includes(shorter)
    && shorter.length / longer.length >= 0.7;
}

function mergeCrossSourceCompiledItems(items = []) {
  const merged = items.map(item => ({
    ...item,
    task: { ...item.task },
    atomIds: [...(item.atomIds || [])],
    unresolvedFields: [...(item.unresolvedFields || [])],
  }));
  const removed = new Set();

  for (let todayIndex = 0; todayIndex < merged.length; todayIndex += 1) {
    const todayItem = merged[todayIndex];
    if (!['今天', '临时'].includes(todayItem.task.source)) continue;
    const reviewIndex = merged.findIndex((candidate, index) => (
      index !== todayIndex
      && !removed.has(index)
      && candidate.task.source === '复盘'
      && crossSourceTaskNamesMatch(candidate.task.name, todayItem.task.name)
    ));
    if (reviewIndex < 0) continue;

    const reviewItem = merged[reviewIndex];
    const acceptanceCriteria = [...new Set([
      ...(todayItem.task.acceptanceCriteria || []),
      ...(reviewItem.task.acceptanceCriteria || []),
    ])].slice(0, 5);
    todayItem.task = {
      ...reviewItem.task,
      ...todayItem.task,
      due: todayItem.task.due !== '待确认' ? todayItem.task.due : reviewItem.task.due,
      est: todayItem.task.est || reviewItem.task.est,
      owner: todayItem.task.owner !== '待确认' ? todayItem.task.owner : reviewItem.task.owner,
      acceptanceCriteria,
      nextAction: todayItem.task.nextAction || reviewItem.task.nextAction,
      source: todayItem.task.source,
      id: todayItem.task.id,
    };
    todayItem.clusterId = todayItem.clusterId || reviewItem.clusterId;
    todayItem.atomIds = [...new Set([
      ...todayItem.atomIds,
      ...reviewItem.atomIds,
    ])];
    todayItem.reviewRequired = todayItem.reviewRequired || reviewItem.reviewRequired;
    todayItem.unresolvedFields = [...new Set([
      ...todayItem.unresolvedFields,
      ...reviewItem.unresolvedFields,
    ])];
    removed.add(reviewIndex);
  }

  return merged.filter((_, index) => !removed.has(index));
}

function hasUmbrellaContext(clusterAtoms, workAtoms) {
  if (workAtoms.length < 2) return false;
  return clusterAtoms.some(atom => (
    atom.kind !== 'work'
    && atom.dueRef
    && /(?:完成|建立|推进|实现).{0,24}(?:提升|建设|机制|体系|项目|计划|目标)/u.test(atom.quote)
  ));
}

function normalizeReconciliationClusters({ clusters = [], conflicts = [], atoms = [] }) {
  const atomById = new Map(atoms.map(atom => [atom.id, atom]));
  const normalized = [];

  for (const cluster of clusters) {
    const clusterAtoms = cluster.atomIds.map(id => atomById.get(id)).filter(Boolean);
    const workAtoms = clusterAtoms.filter(atom => atom.kind === 'work');
    const dimensions = new Set(workAtoms.map(atom => atom.dimension));
    const workIds = new Set(workAtoms.map(atom => atom.id));
    const workRelations = (cluster.relations || []).filter(relation => (
      workIds.has(relation.fromAtom) && workIds.has(relation.toAtom)
    ));
    const hasMergeRelation = workRelations.some(relation => (
      ['same_work_item', 'duplicate', 'conflict'].includes(relation.type)
    ));
    const hasClusterConflict = conflicts.some(conflict => (
      conflict.atomIds.some(atomId => cluster.atomIds.includes(atomId))
    ));
    const substantiveWorkAtoms = workAtoms.filter(atom => !isAncillaryAction(atom));
    const ancillaryOnlyExtras = substantiveWorkAtoms.length === 1
      && workAtoms.length > substantiveWorkAtoms.length;
    const scopeConflict = hasContrastingScopes(workAtoms);
    const umbrellaContext = hasUmbrellaContext(clusterAtoms, workAtoms);
    const shouldSplit = workAtoms.length > 1
      && !hasClusterConflict
      && !ancillaryOnlyExtras
      && (
        scopeConflict
        || umbrellaContext
        || (dimensions.size === 1 && !hasMergeRelation)
      );

    if (!shouldSplit) {
      normalized.push(cluster);
      continue;
    }

    const assignments = new Map(workAtoms.map(atom => [atom.id, [atom.id]]));
    const standalone = [];
    for (const atom of clusterAtoms.filter(item => item.kind !== 'work')) {
      const relatedWork = (cluster.relations || [])
        .flatMap(relation => {
          if (relation.fromAtom === atom.id && workIds.has(relation.toAtom)) return [relation.toAtom];
          if (relation.toAtom === atom.id && workIds.has(relation.fromAtom)) return [relation.fromAtom];
          return [];
        });
      const target = relatedWork[0];
      if (target && assignments.has(target)) assignments.get(target).push(atom.id);
      else standalone.push(atom);
    }

    for (const [index, workAtom] of workAtoms.entries()) {
      const atomIds = assignments.get(workAtom.id);
      const atomIdSet = new Set(atomIds);
      normalized.push({
        id: `${cluster.id}-split-${index + 1}`,
        label: workAtom.action || workAtom.quote,
        atomIds,
        relations: (cluster.relations || []).filter(relation => (
          atomIdSet.has(relation.fromAtom) && atomIdSet.has(relation.toAtom)
        )),
        mergedOwner: mergedOwnerForAtom(workAtom),
        mergedDueRef: workAtom.dueRef || '',
        mergedStatus: mergedStatusForAtom(workAtom),
      });
    }

    for (const [index, atom] of standalone.entries()) {
      normalized.push({
        id: `${cluster.id}-context-${index + 1}`,
        label: atom.quote,
        atomIds: [atom.id],
        relations: [],
        mergedOwner: mergedOwnerForAtom(atom),
        mergedDueRef: atom.dueRef || '',
        mergedStatus: mergedStatusForAtom(atom),
      });
    }
  }

  return { clusters: normalized, conflicts };
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

function taskDueIsGrounded(item, atomById, deadlineContext) {
  const task = item?.task;
  if (!task || !task.due || task.due === '待确认') return false;
  return (item.atomIds || []).some(atomId => {
    const atom = atomById.get(atomId);
    if (!atom) return false;
    const parsed = firstParsedDeadline(
      [deadlineRefForAtom(atom), deadlineQuoteForAtom(atom)],
      deadlineContext,
    );
    if (!parsed || parsed.date !== task.due) return false;
    return !task.dueTime || parsed.time === task.dueTime;
  });
}

function taskSourceIsGrounded(item, atomById) {
  const task = item?.task;
  const primaryAtom = atomById.get(item?.atomIds?.[0]);
  if (!task || !primaryAtom) return false;
  if (primaryAtom.dimension === '今天') {
    return ['今天', '临时'].includes(task.source);
  }
  return task.source === CATEGORY_TO_SOURCE[primaryAtom.dimension];
}

function filterGroundedCriticFindings({ findings = [], compiled, atoms = [], now = () => new Date() }) {
  const instant = typeof now === 'function' ? now() : now;
  const deadlineContext = { now: () => instant, timeZone: 'Asia/Shanghai' };
  const atomById = new Map(atoms.map(atom => [atom.id, atom]));
  const compiledItems = compiled?.compiledItems || [];
  const itemByTaskId = new Map(
    compiledItems.map(item => [item.task.id, item]),
  );
  const taskIdsByAtomId = new Map();
  for (const item of compiledItems) {
    for (const atomId of item.atomIds || []) {
      const taskIds = taskIdsByAtomId.get(atomId) || new Set();
      taskIds.add(item.task.id);
      taskIdsByAtomId.set(atomId, taskIds);
    }
  }

  return findings.filter(finding => {
    if (finding.category === 'orphan_evidence' && finding.atomIds?.length) {
      const allReferenced = finding.atomIds.every(atomId => {
        const linkedTaskIds = taskIdsByAtomId.get(atomId);
        if (!linkedTaskIds?.size) return false;
        if (!finding.taskIds?.length) return true;
        return finding.taskIds.some(taskId => linkedTaskIds.has(taskId));
      });
      if (allReferenced) return false;
    }
    if (!finding.taskIds?.length) return true;
    if (finding.category === 'due_contamination') {
      const allGrounded = finding.taskIds.every(taskId => {
        const item = itemByTaskId.get(taskId);
        return item && taskDueIsGrounded(item, atomById, deadlineContext);
      });
      return !allGrounded;
    }
    if (finding.category === 'wrong_source') {
      const allGrounded = finding.taskIds.every(taskId => {
        const item = itemByTaskId.get(taskId);
        return item && taskSourceIsGrounded(item, atomById);
      });
      return !allGrounded;
    }
    return true;
  });
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
    const primary = selectPrimaryAtom(workAtoms, cluster.relations);
    const matchedConflicts = conflictsForCluster(conflicts, cluster);
    const unresolvedFields = [...new Set(matchedConflicts
      .filter(conflict => conflict.resolution === 'human_needed')
      .map(conflict => conflict.field))];
    const explicitOwners = new Set(
      clusterAtoms
        .filter(atom => atom.actor?.role === 'explicit' && atom.actor?.name)
        .map(atom => atom.actor.name),
    );
    if (
      (cluster.mergedOwner.source === 'conflict' || explicitOwners.size > 1)
      && !unresolvedFields.includes('owner')
    ) {
      unresolvedFields.push('owner');
    }
    const dueUnresolved = unresolvedFields.includes('due');
    const ownerUnresolved = unresolvedFields.includes('owner');
    const extracted = dueUnresolved
      ? null
      : firstParsedDeadline(
        [
          groundedClusterDueRef(cluster, clusterAtoms),
          deadlineRefForAtom(primary),
          deadlineQuoteForAtom(primary),
        ],
        deadlineContext,
      );
    const candidate = {
      name: canonicalClusterTaskName(primary, cluster, clusterAtoms),
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
        clusterAtoms.find(item => normalizeEstimateRef(item.estimateRef))?.estimateRef,
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
      atomIds: [primary.id, ...cluster.atomIds.filter(atomId => atomId !== primary.id)],
      reviewRequired: unresolvedFields.length > 0,
      unresolvedFields,
    });
  }
  // 未聚类 work 原子：1:1 回退编译
  for (const atom of atoms) {
    if (clusteredAtomIds.has(atom.id)) continue;
    if (atom.kind !== 'work') continue;
    const extracted = firstParsedDeadline(
      [deadlineRefForAtom(atom), deadlineQuoteForAtom(atom)],
      deadlineContext,
    );
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
  const semanticallyMerged = mergeCrossSourceCompiledItems(compiled);
  const keptIds = new Set(dedupeCrossSourceTasks(semanticallyMerged.map(item => item.task)).map(task => task.id));
  const kept = semanticallyMerged.filter(item => keptIds.has(item.task.id));
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
    const normalizedReconciliation = normalizeReconciliationClusters({
      clusters: reconResult.clusters,
      conflicts: reconResult.conflicts,
      atoms: stage.atoms,
    });
    clusters = normalizedReconciliation.clusters;
    conflicts = normalizedReconciliation.conflicts;
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
    const effectiveFindings = filterGroundedCriticFindings({
      findings: criticResult.findings,
      compiled,
      atoms: stage.atoms,
      now: () => instant,
    });
    governed = applyCriticFindings(compiled, effectiveFindings);
    criticStage = {
      name: 'critic',
      status: criticResult.status,
      attempts: criticResult.attempts,
      durationMs: criticResult.durationMs,
      output: {
        findings: effectiveFindings,
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
  filterGroundedCriticFindings,
  mergeCrossSourceCompiledItems,
  normalizeReconciliationClusters,
  runEvidenceAgents,
};
