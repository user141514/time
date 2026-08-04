# Multi-Agent Pipeline Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore end-to-end product behavior for the new `multi-agent-v2-phase3` decomposition pipeline while preserving legacy `task-first-v2` compatibility, full evidence lineage, time estimates, conflict visibility, critic governance, coaching, history, and replay evaluation.

**Architecture:** Keep the three-stage backend pipeline—parallel Evidence Agents, Reconciliation, and focused Critics—but introduce explicit adapters and compiler metadata between stages. Production tasks remain a stable public shape; internal lineage is carried separately as `{ taskId, clusterId, atomIds }`. Frontend and history consume a compatibility adapter that accepts both legacy evidence stages and multi-agent atom stages.

**Tech Stack:** Node.js 20.20.2, CommonJS, Ajv JSON Schema, `node:test`, browser ES modules, DeepSeek-compatible `completeJson` model client.

## Global Constraints

- Work on the existing `multi-agent-v2-phase3` uncommitted implementation; do not discard its Evidence, Reconciliation, or Critic agents.
- Preserve `task-first-v2` read compatibility in frontend, coaching, evaluator, and history.
- No real API keys in tracked files or test fixtures.
- Use TDD: every production behavior change begins with a failing test and a verified RED state.
- One checkout writer only; Claude subagents are read-only reviewers unless isolated in a separate worktree.
- Keep model stages bounded: four Evidence calls in parallel, one Reconciliation call, five Critic calls in parallel.
- History must reject invalid atom, cluster, task, relation, conflict, and finding references.

---

### Task 1: Frontend decomposition and coaching compatibility

**Files:**
- Modify: `frontend/app.js`
- Test: `tests/frontend/app.test.js` or the existing frontend behavior test file that imports app helpers
- Test: `tests/server/full-flow-smoke.test.js`

**Interfaces:**
- Produces: `evidenceForCoaching(decomposition)` returning legacy coaching evidence objects for either pipeline.
- Produces: `validateDecompositionResponse(result)` accepting `task-first-v2` and `multi-agent-v2-*`.

- [ ] **Step 1: Write failing tests** proving a multi-agent response with `evidence-agents.output.{昨天,今天,明天,后天}` is accepted and converted to coaching evidence, while a legacy `evidence-task-generation.output.evidence` response remains accepted.
- [ ] **Step 2: Run the focused frontend tests** and verify failure is caused by the hard-coded `evidence-task-generation` lookup.
- [ ] **Step 3: Implement compatibility helpers** in `frontend/app.js`; FactAtom conversion must map `action→observation`, `actor.name→owner|待确认`, `dueRef→due|待确认`, `note/ambiguous→context`, and `in_progress/unknown→planned` for the legacy coaching contract.
- [ ] **Step 4: Re-run focused tests** and verify both pipeline versions pass.
- [ ] **Step 5: Commit** `fix: support multi-agent decomposition in frontend`.

### Task 2: Canonical compiler lineage and classification state

**Files:**
- Modify: `server/contracts/time-management.js`
- Modify: `server/workflows/decompose-tasks.js`
- Test: `tests/server/decompose-tasks.test.js`
- Test: `tests/server/five-step-api.test.js`

**Interfaces:**
- Produces: `compileTasksFromClusters(...) -> { tasks, compiledItems, taskAtoms }`.
- `compiledItems[]`: `{ task, clusterId: string|null, atomIds: string[] }`.
- `taskAtoms[]`: one entry per task-atom edge: `{ taskId, clusterId?, atomId }`.

- [ ] **Step 1: Write failing tests** for a two-atom cluster: taskAtoms contains two non-empty edges, compiledItems preserves clusterId and atomIds, and the public task has `classificationSource: 'unclassified'` when importance/urgency are incomplete.
- [ ] **Step 2: Run focused tests** and verify current empty `atomId` and `ai-extraction` behavior fails.
- [ ] **Step 3: Implement compiler metadata** without exposing internal fields in unrelated API contracts; pass `compiledItems` to Critic and flatten every atom edge into `taskAtoms`.
- [ ] **Step 4: Re-run focused tests** and verify matrix input semantics accept generated tasks.
- [ ] **Step 5: Commit** `fix: preserve multi-agent task lineage`.

### Task 3: Restore time estimate extraction

**Files:**
- Modify: `server/workflows/evidence-contracts.js`
- Modify: `server/workflows/evidence-agent.js`
- Modify: `prompts/decomposition/evidence-agent.v1.md`
- Modify: `server/workflows/decompose-tasks.js`
- Test: `tests/server/decompose-tasks.test.js`
- Test: `tests/server/five-step-api.test.js`

**Interfaces:**
- FactAtom gains `estimateRef: string` and confidence key `estimate: 0|1`.
- Compiler writes normalized `est` from the explicit estimate expression only.

- [ ] **Step 1: Write failing tests** for `预计1小时`, `预计1.5小时`, and no estimate; assert compiled tasks preserve `1h`, `1.5h`, and empty string respectively.
- [ ] **Step 2: Run focused tests** and verify FactAtom schema rejects or compiler drops estimate data.
- [ ] **Step 3: Extend schema and prompt**, then add a deterministic estimate normalizer that accepts explicit minute/hour expressions and never invents a value.
- [ ] **Step 4: Verify SMART and distribution focused tests** pass for explicit estimates and still request user input when absent.
- [ ] **Step 5: Commit** `fix: preserve explicit task estimates`.

### Task 4: Reconciliation semantic validation and conflict propagation

**Files:**
- Modify: `server/workflows/reconciliation-contracts.js`
- Modify: `server/workflows/reconciliation-agent.js`
- Modify: `server/workflows/decompose-tasks.js`
- Test: `tests/server/decompose-tasks.test.js`

**Interfaces:**
- New validators: `assertClusterAtomIdsExist`, `assertRelationsStayWithinCluster`, `assertConflictAtomIdsExist`.
- Compiler metadata gains `reviewRequired`, `unresolvedFields`, and matched conflict references internally; public response exposes unresolved conflict information inside the reconciliation stage.

- [ ] **Step 1: Write failing tests** for phantom cluster atom, cross-cluster relation, phantom conflict atom, owner conflict with `human_needed`, and deterministic primary-atom selection.
- [ ] **Step 2: Run focused tests** and verify each malformed response currently passes or conflict is hidden.
- [ ] **Step 3: Implement semantic validators** and choose primary atom deterministically: actionable today/in-progress first, then planned future, then unfinished yesterday; explicit actor and explicit due break ties.
- [ ] **Step 4: Preserve conflicts** instead of selecting a hidden owner/due when resolution is `human_needed` or source is `conflict`.
- [ ] **Step 5: Re-run focused tests** and commit `fix: validate reconciliation semantics`.

### Task 5: Critic evidence input, partial failure, and governance

**Files:**
- Modify: `server/workflows/critic-agent.js`
- Modify: `server/workflows/critic-contracts.js`
- Modify: `server/workflows/decompose-tasks.js`
- Test: `tests/server/decompose-tasks.test.js`

**Interfaces:**
- Critic consumes `compiledItems`, not stripped public tasks.
- Critic returns `{ findings, checkResults, status: 'succeeded'|'partial'|'degraded' }`.
- Blockers sanitize deterministic fields or mark tasks for confirmation; they are never ignored.

- [ ] **Step 1: Write failing tests** proving owner/due critics receive real atom quotes and cluster atomIds, one failed critic does not cancel the other four, invalid finding IDs are rejected, and blocker findings change the returned governance state.
- [ ] **Step 2: Run focused tests** and verify current empty evidence and `Promise.all` behavior fail.
- [ ] **Step 3: Fix field names and use `Promise.allSettled`**; validate finding taskIds/atomIds against current inputs and preserve per-check metadata.
- [ ] **Step 4: Add minimal blocker handling**: owner blocker sets owner to `待确认`; due blocker sets due to `待确认` and removes dueTime; duplicate/source/coverage blockers mark the result `needs_confirmation` and expose findings.
- [ ] **Step 5: Re-run focused tests** and commit `fix: make critic findings actionable`.

### Task 6: History schema and coaching persistence

**Files:**
- Modify: `server/history/contracts.js`
- Modify: `server/repositories/history-repository.js` only if schema routing requires it
- Modify: `frontend/app.js`
- Test: `tests/server/history-contracts.test.js`
- Test: `tests/server/full-flow-smoke.test.js`

**Interfaces:**
- Multi-agent history validates full FactAtom, Reconciliation, Critic, and taskAtoms reference integrity.
- Coaching claims reference the converted evidence IDs consistently.

- [ ] **Step 1: Write failing tests** for valid multi-agent history, empty/phantom task atom, invalid relation/conflict/finding references, and production frontend coaching/history payloads.
- [ ] **Step 2: Run focused tests** and verify current permissive `{type:'object'}` shapes or frontend payloads fail expectations.
- [ ] **Step 3: Reuse exported agent schemas** or equivalent strict local schemas; validate every taskAtoms edge and every stage reference.
- [ ] **Step 4: Ensure full-flow snapshot always carries a contract-valid distribution**, explicitly marked unavailable rather than fabricated as today=100%.
- [ ] **Step 5: Re-run focused tests** and commit `fix: persist multi-agent decomposition safely`.

### Task 7: Replay and evaluator fidelity

**Files:**
- Modify: `server/evals/decomposition-evaluator.js`
- Modify: `tests/evals/decomposition-cases.jsonl`
- Modify: `tests/evals/decomposition-cases-phase1.jsonl`
- Test: `tests/server/decomposition-evaluator.test.js`

**Interfaces:**
- Replay model dispatches by `responseSchemaName` for evidence, reconciliation, and each critic.

- [ ] **Step 1: Write failing tests** proving replay returns schema-correct responses for all three stages and does not silently degrade Reconciliation or Critic.
- [ ] **Step 2: Run evaluator tests** and verify current dimension-only dispatch fails later stages.
- [ ] **Step 3: Implement stage-aware replay responses** and update fixtures without weakening expected task/evidence accuracy.
- [ ] **Step 4: Re-run evaluator tests** and commit `fix: replay multi-agent decomposition stages`.

### Task 8: Integration verification and cleanup

**Files:**
- Review all modified files
- Remove or intentionally retain: `scripts/fix-remaining-cases.js`, `scripts/generate-phase1-cases*.js`, `scripts/apply-history-fix.js`, `shape-errors.json`

**Interfaces:** None; final integration gate.

- [ ] **Step 1: Run `git diff --check`** and inspect the complete diff for secrets, generated artifacts, and accidental line-ending churn.
- [ ] **Step 2: Run focused server and frontend tests** for decomposition, history, evaluator, five-step API, and full-flow smoke.
- [ ] **Step 3: Run the complete project test suite under Node 20.20.2**; document any environment-only failure separately.
- [ ] **Step 4: Run one real local DeepSeek flow through `start-deepseek-local.bat`** without printing secrets.
- [ ] **Step 5: Dispatch read-only Claude audits** for frontend integration, compiler/history, and reconciliation/critic; fix verified blockers only.
- [ ] **Step 6: Commit the integrated repair**, verify a clean worktree, then SSH-push only after user authorization or an explicit push instruction.
