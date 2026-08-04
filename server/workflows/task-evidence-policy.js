const SOURCE_FOR_DIMENSION = Object.freeze({
  昨天: '复盘',
  今天: '今天',
  明天: '短期目标',
  后天: '中长期',
});

const ACTIONABLE_EVIDENCE_STATUSES = Object.freeze(new Set(['planned', 'unfinished']));
const NON_ACTIONABLE_EVIDENCE_STATUSES = Object.freeze(new Set(['completed', 'not_actionable']));
// ponytail: hardcoded Chinese stop-word list for n-gram overlap filtering.
// Domain-specific terms that happen to match these tokens will be silently excluded.
// Replace with a configurable list or per-tenant override if false negatives appear.
const RELATION_STOP_TOKENS = Object.freeze(new Set([
  '今天', '明天', '昨天', '后天', '上午', '下午', '晚上', '目前', '已经', '还有',
  '完成', '任务', '工作', '计划', '继续', '进行', '需要', '相关', '事项', '项目',
  '今天前', '明天前', '待确认',
]));

function taskSourceMatchesPrimary(task, primary) {
  if (!primary) return false;
  if (primary.dimension === '今天') {
    return ['今天', '临时'].includes(task.source);
  }
  return task.source === SOURCE_FOR_DIMENSION[primary.dimension];
}

function relationTokens(text) {
  const normalized = String(text || '').normalize('NFKC').toLowerCase();
  const tokens = new Set(
    (normalized.match(/[a-z0-9]{2,}/g) || [])
      .filter(token => !/^\d+$/.test(token)),
  );
  const compact = normalized.replace(/[^\p{Script=Han}a-z0-9]+/gu, '');
  for (const size of [4, 3, 2]) {
    for (let index = 0; index + size <= compact.length; index += 1) {
      const token = compact.slice(index, index + size);
      if (/^\d+$/.test(token) || RELATION_STOP_TOKENS.has(token)) continue;
      tokens.add(token);
    }
  }
  return tokens;
}

function isDirectlyRelatedAuxiliary(primary, auxiliary) {
  if (!primary || !auxiliary || primary.id === auxiliary.id) return false;
  const primaryTokens = relationTokens(primary.quote);
  const auxiliaryTokens = relationTokens(auxiliary.quote);
  let sharedShortTokens = 0;
  for (const token of auxiliaryTokens) {
    if (!primaryTokens.has(token)) continue;
    if (token.length >= 3) return true;
    sharedShortTokens += 1;
    if (sharedShortTokens >= 2) return true;
  }
  return false;
}

module.exports = {
  ACTIONABLE_EVIDENCE_STATUSES,
  NON_ACTIONABLE_EVIDENCE_STATUSES,
  SOURCE_FOR_DIMENSION,
  isDirectlyRelatedAuxiliary,
  taskSourceMatchesPrimary,
};
