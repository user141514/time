# Multi-Agent Pipeline Repair Design

## Goal

Repair the current `multi-agent-v2-phase3` refactor without abandoning its architecture. The repaired flow must preserve existing product capabilities while making evidence extraction, cross-dimension reconciliation, task compilation, critic review, coaching, history persistence, and the frontend operate on one coherent contract.

## Scope

This design covers only the current time-management decomposition pipeline and its direct consumers:

- four-dimension Evidence Agents
- Reconciliation Agent
- Task Compiler
- five focused Critic checks
- frontend decomposition and coaching integration
- SMART, distribution, matrix, and report compatibility
- history persistence and replay/evaluation fixtures

It does not redesign authentication, daily tracking, matrix policy, report semantics, or the overall UI.

## Principles

1. **One writer, parallel readers.** Only one implementation agent edits the active checkout. Claude subagents may perform read-only audits or isolated worktree patches.
2. **Preserve facts before interpretation.** FactAtoms remain faithful extractions from one source line.
3. **Keep lineage outside the public task shape where possible.** Task-to-atom and task-to-cluster relationships belong in decomposition metadata, not duplicated inconsistently across consumers.
4. **No silent loss of user facts.** Explicit owner, due time, and estimated duration must survive extraction and compilation.
5. **No silent conflict resolution.** Unresolved owner/due/status conflicts must become review metadata rather than arbitrary values.
6. **Critic findings must affect behavior.** Blockers require one repair pass or an explicit `needs_confirmation` result.
7. **Backward compatibility.** The frontend and history reader must continue accepting `task-first-v2` records while supporting `multi-agent-v2-phase3`.

## Target Data Flow

```text
Four raw input dimensions
    -> four parallel Evidence Agents
    -> merged FactAtom set
    -> Reconciliation Agent
    -> WorkItemClusters + conflicts
    -> deterministic Task Compiler
    -> five parallel Critic checks
    -> one bounded repair pass for blockers
    -> deterministic invariant checks
    -> tasks + decomposition metadata
    -> frontend / coaching / SMART / distribution / matrix / report / history
```

## Canonical Contracts

### FactAtom

Each FactAtom remains tied to one source line and adds duration support:

```json
{
  "id": "A1",
  "dimension": "今天",
  "sourceLineIndex": 0,
  "quote": "由王芳负责今天18:00前提交新版排期表，预计1小时。",
  "kind": "work",
  "action": "提交新版排期表",
  "actor": { "role": "explicit", "name": "王芳" },
  "dueRef": "今天18:00前",
  "estimateRef": "预计1小时",
  "estimatedMinutes": 60,
  "status": "planned",
  "relatedTo": "",
  "confidence": {
    "actor": 1,
    "due": 1,
    "estimate": 1,
    "status": 1
  }
}
```

`estimateRef` must be an original substring. `estimatedMinutes` is either a positive integer derived from that substring or `null`.

### WorkItemCluster

A cluster contains only existing atom IDs. Relations must reference atoms inside the same cluster. Conflicts may only reference existing atoms.

```json
{
  "id": "C1",
  "label": "提交新版排期表",
  "atomIds": ["A1", "A4"],
  "relations": [],
  "mergedOwner": { "name": "王芳", "source": "explicit" },
  "mergedDueRef": "今天18:00前",
  "mergedEstimateMinutes": 60,
  "mergedStatus": "planned"
}
```

### CompiledTaskRecord

The compiler operates on an internal record:

```json
{
  "task": { "id": "T1", "name": "提交新版排期表" },
  "clusterId": "C1",
  "atomIds": ["A1", "A4"],
  "unresolvedFields": [],
  "reviewRequired": false
}
```

The public task retains existing fields. Until matrix classification occurs, it must use:

```text
importance = null
urgency = null
classificationSource = unclassified
```

The compiler preserves `due`, `dueTime`, `owner`, and `est` when grounded. It selects the primary atom deterministically: active planned/in-progress work before unfinished history; today before yesterday; explicit actor before unknown; explicit due before none.

### Decomposition Lineage

`taskAtoms` becomes one entry per task with all atom IDs:

```json
{
  "taskId": "T1",
  "clusterId": "C1",
  "atomIds": ["A1", "A4"]
}
```

Legacy `taskEvidence` remains supported only for legacy pipeline versions.

## Critic Behavior

Five checks remain independent: owner, due, coverage, dedupe, and source.

- Use `Promise.allSettled` so one transport failure does not erase the other four results.
- Each check records `ok`, `attempts`, `durationMs`, `errorCode`, and finding count.
- Finding IDs must reference existing tasks and atoms.
- `info` findings are recorded.
- `warning` findings set `reviewRequired`.
- `blocker` findings trigger one bounded deterministic/model-assisted repair pass.
- If blockers remain, affected tasks are returned with `reviewRequired: true` and explicit unresolved fields, rather than guessed values.

The critic stage status is:

- `succeeded`: all checks completed
- `partial`: at least one check failed but at least one completed
- `degraded`: no check completed

## Frontend Compatibility

Introduce one decomposition adapter in `frontend/app.js`:

- legacy `task-first-v2`: read `evidence-task-generation.output.evidence`
- multi-agent: flatten `evidence-agents.output` by dimension

The adapter is used by both response validation and coaching request construction. The UI must no longer hard-code one stage name.

FactAtoms are converted to the existing coaching evidence shape through one shared function. IDs remain stable so coaching claims can be checked against the stored atoms.

The frontend may display reconciliation degradation, critic partial/degraded state, and task review requirements, but no major layout redesign is included.

## History Compatibility

History schema version 3 continues to read legacy records and gains a strict multi-agent branch:

- validate FactAtoms with the same schema used by the live pipeline
- validate reconciliation and critic stage shapes
- validate every `taskAtoms.taskId` and `atomIds`
- require every generated task to have lineage
- validate source/owner/due grounding where deterministic
- keep legacy `taskEvidence` validation unchanged

No database migration is required because decomposition is stored as JSON and discriminated by `pipelineVersion`.

## Failure and Degradation Rules

- Evidence Agent failure remains blocking because source coverage cannot be trusted.
- Reconciliation failure falls back to one-to-one compilation and records `fallbackMode: "one-to-one"`.
- Critic partial failure does not discard successful checks.
- Missing estimates produce SMART/distribution guidance only when the user did not provide an estimate. Explicit estimates must never be lost.
- Unresolved semantic conflicts remain visible and never become fabricated facts.

## Implementation Phases

### Phase 1: Restore end-to-end compatibility

- frontend decomposition adapter and coaching adapter
- internal compiled records with cluster and atom lineage
- correct Critic inputs and field names
- `classificationSource: unclassified`
- strict multi-agent history lineage support

### Phase 2: Restore business capability and governance

- duration extraction and compilation
- reconciliation ID validation
- conflict/review metadata
- `Promise.allSettled` critic execution
- one blocker repair pass

### Phase 3: Evaluation and cleanup

- replay model support for reconciliation and critic calls
- regression tests for frontend adapters, lineage, history, durations, conflicts, and partial critic failures
- remove or archive one-off generation/fix scripts and temporary files
- full verification, review, commit, and SSH push

## Verification Criteria

The implementation is complete only when all of these are true:

1. The browser accepts both legacy and multi-agent decomposition responses.
2. Coaching works from FactAtoms without test-only conversion code.
3. Every generated task has non-empty, valid atom lineage.
4. Cluster tasks preserve all atom IDs.
5. Matrix accepts newly compiled unclassified tasks.
6. Explicit duration input reaches `task.est` and distribution calculations.
7. Reconciliation rejects phantom and cross-cluster IDs.
8. Critic partial failure is visible; blocker findings affect task output.
9. New decomposition snapshots save and reload through history.
10. Existing legacy history remains readable.
11. Replay/evaluation covers Evidence, Reconciliation, and Critic stages.
12. Targeted and complete test suites pass under Node.js 20.20.2.

## Non-Goals

- replacing the current model provider
- redesigning the four input dimensions
- changing matrix quadrant policy
- redesigning the report UI
- adding distributed queues or asynchronous background processing
