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

function atomToCoachingEvidence(atom) {
  const kind = atom?.kind === 'note' || atom?.kind === 'ambiguous'
    ? 'context'
    : atom?.kind;
  const status = atom?.status === 'in_progress' || atom?.status === 'unknown'
    ? 'planned'
    : atom?.status;
  return {
    id: atom.id,
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
