const assert = require('node:assert/strict');
const test = require('node:test');

const { FULL_FLOW_ENTRIES, runFullFlow } = require('../helpers/full-flow-runner');

function claim(text, evidenceIds = []) {
  return { text, evidenceIds };
}

function coachingAnalysis() {
  const supported = claim('今天需要按时提交接口联调结果。', ['E1']);
  const unknown = claim('证据不足：当前输入未提供该维度信息。');
  return {
    yesterday_analysis: {
      key_problem: unknown,
      gap: unknown,
      root_cause: unknown,
      management_insight: unknown,
    },
    today_focus: {
      key_work: supported,
      priority_reason: supported,
      manager_action: supported,
      possible_delegation: supported,
    },
    tomorrow_optimization: {
      management_improvement: unknown,
      system_building: unknown,
      capability_upgrade: unknown,
    },
    future_direction: {
      long_term_goal: unknown,
      organization_capability: unknown,
      future_focus: unknown,
    },
    connection_analysis: {
      problem_to_action: supported,
      action_to_optimization: unknown,
      optimization_to_future: unknown,
    },
    coaching_suggestions: [],
    overall_insight: supported,
  };
}

test('全流程冒烟：认证、五步、历史和每日跟踪全部串联', async (t) => {
  const calls = [];
  const modelClient = {
    async completeJson(input) {
      calls.push(input);
      const user = typeof input.user === 'string' ? JSON.parse(input.user) : input.user || {};
      // Evidence agent calls (Phase 1: per-dimension)
      if (user.dimension !== undefined) {
        return {
          dimension: user.dimension,
          atoms: user.dimension === '今天' ? [{
            id: 'atom-1', dimension: '今天', sourceLineIndex: 0,
            quote: FULL_FLOW_ENTRIES.今天,
            kind: 'work', action: '提交接口联调结果',
            actor: { role: 'explicit', name: '张三' }, dueRef: '今天17:00前',
            estimateRef: '预计耗时1小时', status: 'planned', relatedTo: '',
            confidence: { actor: 1, due: 1, estimate: 1, status: 1 },
          }] : [],
        };
      }
      // Reconciliation call (Phase 2)
      if (user.atoms !== undefined && user.byDimension !== undefined) {
        return {
          clusters: [{
            id: 'cluster-1',
            label: '提交接口联调结果',
            atomIds: user.atoms.map(atom => atom.id),
            relations: [],
            mergedOwner: { name: '张三', source: 'explicit' },
            mergedDueRef: '今天17:00前',
            mergedStatus: 'planned',
          }],
          conflicts: [],
        };
      }
      // Critic calls (Phase 3)
      if (user.tasks !== undefined && input.responseSchemaName?.startsWith('time_critic_')) {
        return { findings: [] };
      }
      // Coaching call
      if (input.responseSchemaName === 'time_coaching_analysis_v2') {
        return { coachingAnalysis: coachingAnalysis() };
      }
      // Matrix classify call
      if (user.tasks && input.responseSchemaName === 'time_classify_matrix_v2') {
        return {
          classifications: user.tasks.map(task => ({
            taskId: task.id, importance: '高', urgency: '高',
          })),
          note: '单任务直接进入第一象限。',
        };
      }
      // Report generate call
      return {
        order: (user.priorityContext?.recommendedTaskIds || user.tasks?.map(t => t.id) || []).map(taskId => ({
          taskId,
          reason: '该任务今天到期，应优先完成。',
        })),
        energyRules: ['先完成今天到期的第一象限任务。'],
        adjustments: ['完成后立即登记接口联调结果。'],
      };
    },
  };

  const result = await runFullFlow(t, {
    modelClient,
    now: () => new Date('2026-08-02T04:00:00.000Z'),
    usernamePrefix: 'smoke',
  });

  assert.equal(calls.filter(call => call.responseSchemaName === 'time_evidence_atomization_v1').length, 1);
  assert.equal(calls.filter(call => call.responseSchemaName === 'time_reconciliation_v1').length, 1);
  assert.equal(calls.filter(call => call.responseSchemaName === 'time_critic_combined_v1').length, 1);
  assert.equal(calls.filter(call => call.responseSchemaName === 'time_coaching_analysis_v2').length, 1);
  assert.equal(calls.filter(call => call.responseSchemaName === 'time_classify_matrix_v2').length, 1);
  assert.equal(result.decomposed.tasks.length, 1);
  assert.equal(result.decomposed.tasks[0].owner, '张三');
  assert.equal(result.decomposed.tasks[0].due, '2026-08-02');
  assert.equal(result.distribution.totalMinutes, 60);
  assert.equal(result.history.decomposition.stages.length, 4);
});
