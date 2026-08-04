const CATEGORY_KEYS = Object.freeze(['昨天', '今天', '明天', '后天']);

function invalidResponseError() {
  return Object.assign(new Error('任务拆解响应格式不正确。'), {
    code: 'DECOMPOSITION_RESPONSE_INVALID',
  });
}

function legacyEvidence(decomposition) {
  const stage = decomposition?.stages?.find(
    item => item?.name === 'evidence-task-generation',
  );
  return Array.isArray(stage?.output?.evidence)
    ? stage.output.evidence
    : null;
}

function multiAgentAtoms(decomposition) {
  const stage = decomposition?.stages?.find(
    item => item?.name === 'evidence-agents',
  );
  if (!stage || !stage.output || typeof stage.output !== 'object') return null;
  const arrays = CATEGORY_KEYS.map(key => stage.output[key]);
  if (arrays.some(items => !Array.isArray(items))) return null;
  return arrays.flat();
}

function atomToCoachingEvidence(atom, index) {
  const kind = atom?.kind === 'note' || atom?.kind === 'ambiguous'
    ? 'context'
    : atom?.kind;
  const status = atom?.status === 'in_progress' || atom?.status === 'unknown'
    ? 'planned'
    : atom?.status;
  return {
    id: `E${index + 1}`,
    dimension: atom.dimension,
    sourceLineIndex: atom.sourceLineIndex,
    quote: atom.quote,
    observation: atom.action || atom.quote,
    kind,
    status,
    owner: atom.actor?.name || '待确认',
    due: atom.dueRef || '待确认',
  };
}

export function decompositionReviewNotice(decomposition) {
  if (!String(decomposition?.pipelineVersion || '').startsWith('multi-agent-v2')) {
    return null;
  }
  const critic = decomposition.stages?.find(stage => stage?.name === 'critic');
  const governanceStatus = critic?.output?.governanceStatus;
  if (governanceStatus === 'needs_confirmation') {
    return {
      level: 'warning',
      code: 'TASKS_NEED_CONFIRMATION',
      message: 'AI 审查发现部分任务的责任人、期限或证据需要人工确认；相关不确定字段已回退为待确认。',
    };
  }
  if (critic?.status === 'partial' || critic?.status === 'degraded') {
    return {
      level: 'warning',
      code: 'CRITIC_INCOMPLETE',
      message: '部分任务审查未完成，请在继续前重点核对责任人、截止时间、来源和重复项。',
    };
  }
  if (governanceStatus === 'review_recommended') {
    return {
      level: 'warning',
      code: 'TASK_REVIEW_RECOMMENDED',
      message: 'AI 审查提出了非阻断性提醒，请核对任务内容后继续。',
    };
  }
  const reconciliation = decomposition.stages?.find(
    stage => stage?.name === 'reconciliation',
  );
  if (reconciliation?.status === 'degraded') {
    return {
      level: 'warning',
      code: 'RECONCILIATION_FALLBACK',
      message: '跨栏事项未能完成聚类，系统已按每条事实独立生成任务；请重点检查重复项和前后依赖。',
    };
  }
  return null;
}

export function evidenceForCoaching(decomposition) {
  const legacy = legacyEvidence(decomposition);
  if (legacy) return legacy;
  const atoms = multiAgentAtoms(decomposition);
  if (!atoms) return null;
  return atoms.map(atomToCoachingEvidence);
}

export function validateDecompositionResponse(result) {
  const decomposition = result?.decomposition;
  if (
    !decomposition
    || typeof decomposition.decompositionId !== 'string'
    || !decomposition.decompositionId
    || typeof decomposition.businessDate !== 'string'
    || !decomposition.businessDate
    || !Array.isArray(result?.tasks)
    || !Array.isArray(decomposition.stages)
    || !Array.isArray(evidenceForCoaching(decomposition))
  ) {
    throw invalidResponseError();
  }
  return result;
}
