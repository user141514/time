const COMPLETED_SIGNAL = /(?:已|已经|均已|也已|都已).{0,16}(?:完成|提交|发送|通过|解决|关闭|上线|交付|部署)|(?:完成|提交|发送|解决|通过)了/u;
const PARTIAL_COMPLETION_SIGNAL = /(?:实际)?(?:只|仅|部分).{0,12}完成|完成.{0,12}(?:一半|部分)/u;
const IN_PROGRESS_SIGNAL = /正在|进行中|尚在|仍在.{0,16}(?:进行|编写|处理|重构|执行|推进)/u;
const UNFINISHED_SIGNAL = /未完成|尚未完成|仍未完成|还没完成|没有完成|没完成|没做完|还没做完|尚未安排|未安排|待补充|需要继续|未达成|仍待|遗留/u;
const NEGATED_ACTION_SIGNAL = /(?:无需|无须|不需要|不用|不必).{0,24}(?:准备|处理|跟进|执行|提交|完成|安排|修改|修复|额外)/u;
const WORKAROUND_STATE_SIGNAL = /(?:暂时|临时)\s*(?:改用|使用|采用).{0,30}(?:代替|替代)/u;
const PROBLEM_SIGNAL = /报错|故障|异常|漏洞|问题|失败|阻塞|崩溃|不可用/u;
const EXPLICIT_ACTION_SIGNAL = /修复|处理|排查|解决|跟进|恢复|验证|分析|定位|整改|安排|提交|完成|编写|整理|输出|发送|同步|确认|联系|组织|建立|优化|重构|部署|翻译|测试|审核|校对|盘点|收集|回复/u;
const METRIC_RESULT_SIGNAL = /(?:新增|增长|提升至|下降至|达到|增至|降至|转化率|完成率|通过率|用户数|收入|成本).{0,16}(?:\d|%|％)/u;
const METRIC_ACTION_SIGNAL = /需要|需|计划|目标|争取|确保|实现|将|完成|优化|分析/u;
const BARE_DAY_PART = /^(?:上午|下午|晚上|今晚|今夜|凌晨|中午|傍晚)$/u;
const BARE_TODAY = /^(?:今天|今日)$/u;
const EXPLICIT_TODAY_DEADLINE_PREFIX = /^(?:今天|今日)\s*(?:\d{1,2}(?::|：|点)|(?:上午|下午|晚上)\s*\d{1,2}|前|内|之前|截止|必须|务必|需要|需|交付|上线|发布)/u;
const EXECUTOR_ACTION = '完成|提交|处理|修复|整理|编写|发送|确认|联系|组织|建立|部署|测试|校对|盘点|收集|回复|验证|分析|重构|优化|交付';
const ACTOR_NAME = '[\\p{Script=Han}A-Za-z0-9_-]{2,16}';
const TEAM_NAME = '[\\p{Script=Han}A-Za-z0-9_-]{1,12}(?:组|团队|部门|中心|小组)';
const EXECUTOR_PATTERNS = [
  new RegExp(`(?:由|安排)([\\p{Script=Han}A-Za-z0-9_-]{2,16}?)(?:负责|${EXECUTOR_ACTION})`, 'u'),
  new RegExp(`(?:^|[，,；;。\\s])(?:今天|明天|后天|昨天)?\\s*(${ACTOR_NAME})(?:负责|接手)(?:${EXECUTOR_ACTION})?`, 'u'),
  new RegExp(`请(${ACTOR_NAME})(?:在[^，。；;]{0,24})?(?:${EXECUTOR_ACTION})`, 'u'),
  new RegExp(`^(?:今天|明天|后天|昨天)?\\s*(${TEAM_NAME})\\s*(?:${EXECUTOR_ACTION})`, 'u'),
  new RegExp(`^([\\p{Script=Han}]{2,4})(?:今天|明天|后天|昨天)[^，。；;]{0,24}(?:${EXECUTOR_ACTION})`, 'u'),
];
const APPROVAL_ONLY_SIGNAL = new RegExp(
  `^\\s*请${ACTOR_NAME}(?:在[^，。；;]{0,24})?(?:审批|审阅|审核)(?:[。；;，,]|$)`,
  'u',
);
const NON_ACTOR_WORDS = new Set([
  '今天', '明天', '后天', '昨天', '今日', '明日',
  '尽量', '需要', '需在', '计划', '准备', '继续', '开始', '正在', '目前', '用户',
]);
const EXPLICIT_ESTIMATE_SIGNAL = /(?:预计(?:还)?(?:需要|需)?|大概|大约|约|耗时)\s*\d+(?:\.\d+)?\s*(?:h|小时|分钟)/iu;
const NEXT_ACTION_METADATA_SIGNAL = /^(?:下一步|第一步)(?:先)?|^先(?=完成|整理|录制|列出|收集|确认|搭建|配置|盘点)/u;
const ACCEPTANCE_METADATA_SIGNAL = /^(?:要求|验收标准|标准是|需覆盖|需要覆盖|应包含|必须包含|确保)|^.{1,16}(?:需|须|应|必须)包含|(?:需|须|应|必须)通过/u;
const COMPLETION_REQUIREMENT_SIGNAL = /^(?:需|须|应|必须)在[^，。；;]{0,32}(?:完成|提交|交付|审批|通过)/u;
const TODAY_COMMITMENT_SIGNAL = /^(?:今天|今日)\s*(?:完成|交付|提交|修复|发布|上线|关闭|解决)/u;
const CONDITIONAL_CLAUSE_SIGNAL = /(?:^|[。；;])\s*(?:如果|若|假如|一旦)/u;

function nonActionableAtom(atom) {
  return {
    ...atom,
    kind: 'note',
    action: '',
    dueRef: '',
    status: 'unknown',
    confidence: {
      ...atom.confidence,
      due: 0,
      status: 1,
    },
  };
}

function looksLikeMetricResult(quote) {
  return METRIC_RESULT_SIGNAL.test(quote) && !METRIC_ACTION_SIGNAL.test(quote);
}

function looksLikeProblemOnly(quote) {
  return PROBLEM_SIGNAL.test(quote) && !EXPLICIT_ACTION_SIGNAL.test(quote);
}

function safeActorName(value) {
  const name = String(value || '').trim();
  return name && !NON_ACTOR_WORDS.has(name) ? name : '';
}

function extractExplicitActor(quote) {
  for (const pattern of EXECUTOR_PATTERNS) {
    const match = pattern.exec(String(quote || ''));
    const name = safeActorName(match?.[1]);
    if (name) return name;
  }
  return '';
}

function extractExecutorAction(quote, actor) {
  const text = String(quote || '');
  const actorIndex = text.indexOf(actor);
  if (actorIndex < 0) return '';
  const tail = text.slice(actorIndex + actor.length);
  const match = new RegExp(`(?:负责|接手)?[^，。；;]{0,24}?((?:${EXECUTOR_ACTION})[^，。；;]*)`, 'u').exec(tail);
  return match?.[1]?.trim() || '';
}

function extractSourceLineActors(sourceLine) {
  const text = String(sourceLine || '');
  const names = new Set();
  const responsible = /(?:^|[，,；;。\s])([\p{Script=Han}]{2,4})(?=负责|接手)/gu;
  const progress = /(?:^|[，,；;。\s])(?:今天|明天|后天|昨天)?\s*([\p{Script=Han}]{2,4})(?=开始|继续|正在)/gu;
  for (const pattern of [responsible, progress]) {
    for (const match of text.matchAll(pattern)) {
      const name = safeActorName(match[1]);
      if (name) names.add(name);
    }
  }
  return [...names];
}

function extractSourceLineActor(sourceLine) {
  const names = extractSourceLineActors(sourceLine);
  return names.length === 1 ? names[0] : '';
}

function clearActor(atom) {
  return {
    ...atom,
    actor: { role: 'unknown', name: '' },
    confidence: { ...atom.confidence, actor: 0 },
  };
}

function hardenActor(atom) {
  const quote = String(atom.quote || '');
  if (APPROVAL_ONLY_SIGNAL.test(quote)) return nonActionableAtom(clearActor(atom));
  const explicitActor = extractExplicitActor(quote);
  if (explicitActor) {
    const action = extractExecutorAction(quote, explicitActor);
    return {
      ...atom,
      ...(atom.kind !== 'work' && action ? {
        kind: 'work',
        action,
        status: 'planned',
      } : {}),
      actor: { role: 'explicit', name: explicitActor },
      confidence: {
        ...atom.confidence,
        actor: 1,
        ...(atom.kind !== 'work' && action ? { status: 1 } : {}),
      },
    };
  }
  if (atom.actor?.role === 'explicit' || atom.actor?.name) return clearActor(atom);
  return atom;
}

function hardenDueRef(atom) {
  const dueRef = String(atom.dueRef || '').trim();
  if (!dueRef) return atom;
  const quote = String(atom.quote || '').trim();

  if (BARE_DAY_PART.test(dueRef)) {
    return {
      ...atom,
      dueRef: '',
      confidence: { ...atom.confidence, due: 0 },
    };
  }

  if (
    BARE_TODAY.test(dueRef)
    && quote.startsWith(dueRef)
    && !EXPLICIT_TODAY_DEADLINE_PREFIX.test(quote)
  ) {
    return {
      ...atom,
      dueRef: '',
      confidence: { ...atom.confidence, due: 0 },
    };
  }

  return atom;
}

function hardenFactAtom(atom) {
  const quote = String(atom.quote || '');

  if (PARTIAL_COMPLETION_SIGNAL.test(quote) && atom.kind === 'work') {
    return hardenActor(hardenDueRef({
      ...atom,
      status: 'unfinished',
      confidence: { ...atom.confidence, status: 1 },
    }));
  }

  if (COMPLETED_SIGNAL.test(quote)) return nonActionableAtom(atom);

  if (
    NEGATED_ACTION_SIGNAL.test(quote)
    || WORKAROUND_STATE_SIGNAL.test(quote)
    || looksLikeMetricResult(quote)
    || looksLikeProblemOnly(quote)
    || /照常召开/u.test(quote)
  ) {
    return nonActionableAtom(atom);
  }

  let hardened = { ...atom, confidence: { ...atom.confidence } };
  if (IN_PROGRESS_SIGNAL.test(quote)) {
    hardened.status = 'in_progress';
    hardened.confidence.status = 1;
  } else if (UNFINISHED_SIGNAL.test(quote)) {
    hardened.status = 'unfinished';
    hardened.confidence.status = 1;
  }

  hardened = hardenDueRef(hardened);
  hardened = hardenActor(hardened);
  return hardened;
}

function atomGroupKey(atom) {
  return `${atom.dimension}:${atom.sourceLineIndex}`;
}

function plannedActionFromQuote(quote) {
  const match = /^(?:昨天|今天|明天|后天)?\s*(?:原计划|计划|目标是?)\s*(.+)$/u.exec(
    String(quote || '').trim(),
  );
  if (!match || !EXPLICIT_ACTION_SIGNAL.test(match[1])) return '';
  return match[1]
    .split(/(?:，|,)?\s*(?:实际|但|不过|可是)/u, 1)[0]
    .replace(/[。；;，,]+$/u, '')
    .trim();
}

function metadataNote(atom) {
  return {
    ...atom,
    kind: 'note',
    action: '',
    dueRef: '',
    status: 'unknown',
    confidence: {
      ...atom.confidence,
      due: 0,
      status: 1,
    },
  };
}

function groupIndexes(atoms) {
  const groups = new Map();
  atoms.forEach((atom, index) => {
    const key = atomGroupKey(atom);
    const indexes = groups.get(key) || [];
    indexes.push(index);
    groups.set(key, indexes);
  });
  return groups;
}

function hardenFactAtoms(atoms, sourceLines = []) {
  const source = atoms || [];
  const hardened = source.map(hardenFactAtom);
  const partialGroups = new Set(
    source
      .filter(atom => PARTIAL_COMPLETION_SIGNAL.test(String(atom.quote || '')))
      .map(atomGroupKey),
  );

  const promoted = hardened.map((atom, index) => {
    const original = source[index];
    if (!partialGroups.has(atomGroupKey(original)) || original.kind !== 'goal') return atom;
    const action = plannedActionFromQuote(original.quote);
    if (!action) return atom;
    return hardenActor(hardenDueRef({
      ...atom,
      kind: 'work',
      action,
      status: 'unfinished',
      confidence: { ...atom.confidence, status: 1 },
    }));
  });

  const grouped = groupIndexes(promoted);
  const metadataHardened = [...promoted];

  for (let index = 0; index < metadataHardened.length; index += 1) {
    const atom = metadataHardened[index];
    const sourceLine = String(sourceLines[atom.sourceLineIndex] || '');
    const conditionalMatch = CONDITIONAL_CLAUSE_SIGNAL.exec(sourceLine);
    if (!conditionalMatch) continue;
    const quoteIndex = sourceLine.indexOf(String(atom.quote || ''));
    if (quoteIndex >= conditionalMatch.index) {
      metadataHardened[index] = metadataNote(atom);
    }
  }

  for (const indexes of grouped.values()) {
    const workIndexes = indexes.filter(index => metadataHardened[index].kind === 'work');
    if (workIndexes.length < 3) continue;
    const sourceLine = String(sourceLines[metadataHardened[workIndexes[0]].sourceLineIndex] || '');
    const colonIndex = sourceLine.search(/[：:]/u);
    if (colonIndex < 0) continue;
    const beforeColon = workIndexes.filter(index => {
      const quote = String(metadataHardened[index].quote || '');
      const quoteIndex = sourceLine.indexOf(quote);
      return quoteIndex >= 0 && quoteIndex + quote.length <= colonIndex;
    });
    const afterColon = workIndexes.filter(index => {
      const quoteIndex = sourceLine.indexOf(String(metadataHardened[index].quote || ''));
      return quoteIndex > colonIndex;
    });
    if (beforeColon.length !== 1 || afterColon.length < 2) continue;
    const parentIndex = beforeColon[0];
    const parent = metadataHardened[parentIndex];
    const inheritedDue = String(parent.dueRef || '').trim();
    metadataHardened[parentIndex] = {
      ...metadataNote(parent),
      dueRef: inheritedDue,
      confidence: { ...parent.confidence, due: inheritedDue ? 1 : 0, status: 1 },
    };
    if (inheritedDue) {
      for (const index of afterColon) {
        const child = metadataHardened[index];
        if (String(child.dueRef || '').trim()) continue;
        metadataHardened[index] = {
          ...child,
          dueRef: inheritedDue,
          confidence: { ...child.confidence, due: 1 },
        };
      }
    }
  }

  for (const indexes of grouped.values()) {
    const workCount = indexes.filter(index => metadataHardened[index].kind === 'work').length;
    if (workCount < 2) continue;
    for (const index of indexes) {
      const atom = metadataHardened[index];
      const quote = String(atom.quote || '').trim();
      const sourceLine = String(sourceLines[atom.sourceLineIndex] || '');
      const substantiveNextAction = String(atom.nextActionRef || '').trim().length >= 3;
      const appearsAfterBoundary = sourceLine.includes(`，${quote}`)
        || sourceLine.includes(`,${quote}`)
        || sourceLine.includes(`；${quote}`)
        || sourceLine.includes(`;${quote}`);
      const isNextAction = NEXT_ACTION_METADATA_SIGNAL.test(quote)
        && (substantiveNextAction || appearsAfterBoundary);
      const isCompletionRequirement = COMPLETION_REQUIREMENT_SIGNAL.test(quote);
      const isAcceptance = (
        (atom.acceptanceCriteria || []).length > 0
        && ACCEPTANCE_METADATA_SIGNAL.test(quote)
      ) || isCompletionRequirement;
      if (atom.kind === 'work' && (isNextAction || isAcceptance)) {
        let note = metadataNote(atom);
        if (isCompletionRequirement) {
          note = clearActor({
            ...note,
            dueRef: atom.dueRef,
            acceptanceCriteria: (atom.acceptanceCriteria || []).length > 0
              ? atom.acceptanceCriteria
              : [quote],
            confidence: { ...note.confidence, due: atom.dueRef ? 1 : 0 },
          });
        }
        metadataHardened[index] = isNextAction
          ? { ...note, nextActionRef: quote }
          : note;

        if (isAcceptance) {
          const quotePosition = sourceLine.indexOf(quote);
          const priorWorkIndexes = indexes
            .filter(otherIndex => otherIndex !== index && metadataHardened[otherIndex].kind === 'work')
            .map(otherIndex => ({
              index: otherIndex,
              position: sourceLine.indexOf(String(metadataHardened[otherIndex].quote || '')),
            }))
            .filter(item => item.position >= 0 && item.position < quotePosition)
            .sort((left, right) => right.position - left.position);
          const targetIndex = priorWorkIndexes[0]?.index;
          if (targetIndex !== undefined) {
            const target = metadataHardened[targetIndex];
            const criteria = [...new Set([
              ...(target.acceptanceCriteria || []),
              ...((note.acceptanceCriteria || []).length > 0 ? note.acceptanceCriteria : [quote]),
            ])];
            metadataHardened[targetIndex] = {
              ...target,
              ...(note.dueRef && !target.dueRef ? {
                dueRef: note.dueRef,
                confidence: { ...target.confidence, due: 1 },
              } : {}),
              acceptanceCriteria: criteria,
            };
          }
        }
      }
    }
  }

  for (let index = 0; index < metadataHardened.length; index += 1) {
    const atom = metadataHardened[index];
    if (atom.kind !== 'note') continue;
    const quote = String(atom.quote || '').trim();
    let updated = atom;
    if (
      NEXT_ACTION_METADATA_SIGNAL.test(quote)
      && String(atom.nextActionRef || '').trim().length < quote.length
    ) {
      updated = { ...updated, nextActionRef: quote };
    }
    if (
      ACCEPTANCE_METADATA_SIGNAL.test(quote)
      && (updated.acceptanceCriteria || []).length === 0
    ) {
      updated = { ...updated, acceptanceCriteria: [quote] };
    }
    metadataHardened[index] = updated;
  }

  for (const indexes of grouped.values()) {
    const workIndexes = indexes.filter(index => metadataHardened[index].kind === 'work');
    if (workIndexes.length === 0) continue;
    const sourceLine = String(sourceLines[metadataHardened[workIndexes[0]].sourceLineIndex] || '');
    const relativeDay = /^(明天|后天)(?=\s|\p{Script=Han}|[A-Za-z0-9])/u.exec(sourceLine.trim())?.[1] || '';
    if (relativeDay) {
      for (const index of workIndexes) {
        const atom = metadataHardened[index];
        if (String(atom.dueRef || '').trim()) continue;
        metadataHardened[index] = {
          ...atom,
          dueRef: relativeDay,
          confidence: { ...atom.confidence, due: 1 },
        };
      }
    }
    const sourceActors = extractSourceLineActors(sourceLine);
    if (sourceActors.length === 1) {
      for (const index of workIndexes) {
        const atom = metadataHardened[index];
        if (atom.actor?.role === 'explicit' && atom.actor?.name) continue;
        metadataHardened[index] = {
          ...atom,
          actor: { role: 'explicit', name: sourceActors[0] },
          confidence: { ...atom.confidence, actor: 1 },
        };
      }
    }
  }

  for (const indexes of grouped.values()) {
    const workIndexes = indexes.filter(index => metadataHardened[index].kind === 'work');
    if (workIndexes.length !== 1) continue;
    const workIndex = workIndexes[0];
    let atom = metadataHardened[workIndex];
    const sourceLine = String(sourceLines[atom.sourceLineIndex] || '');

    if (atom.actor?.role !== 'explicit' || !atom.actor?.name) {
      const actorName = extractSourceLineActor(sourceLine);
      if (actorName) {
        atom = {
          ...atom,
          actor: { role: 'explicit', name: actorName },
          confidence: { ...atom.confidence, actor: 1 },
        };
      }
    }

    if (!String(atom.estimateRef || '').trim()) {
      const estimateRef = EXPLICIT_ESTIMATE_SIGNAL.exec(sourceLine)?.[0] || '';
      if (estimateRef) {
        atom = {
          ...atom,
          estimateRef,
          confidence: { ...atom.confidence, estimate: 1 },
        };
      }
    }

    if (
      atom.dimension === '今天'
      && !String(atom.dueRef || '').trim()
      && TODAY_COMMITMENT_SIGNAL.test(sourceLine.trim())
    ) {
      atom = {
        ...atom,
        dueRef: '今天',
        confidence: { ...atom.confidence, due: 1 },
      };
    }

    metadataHardened[workIndex] = atom;
  }

  return metadataHardened;
}

module.exports = {
  hardenFactAtom,
  hardenFactAtoms,
};
