# Known Issues

Tracked correctness issues and their status. Reproductions live in
[`tests/correctness-regressions.test.ts`](../tests/correctness-regressions.test.ts);
each was written as a failing test first and now passes.

## Fixed

### 1. Concurrent resume double-executed a step (critical) — fixed

Two overlapping passes for the *same* run (an operator retry racing a `Worker`, a
`sendSignal` delivery racing a `resume`, or a reclaimed lease under a shared
engine) both cleared a step's "already completed?" memo before either persisted
it, so the step's side effect ran twice — a real double-charge.

**Fix:** the engine now holds a per-run in-process execution mutex
(`serializeRun`). `run`, `resume`, and every `sendSignal`/`Worker`-driven resume
for one run are serialized within the process, so the second pass observes the
first pass's committed step and memoizes it instead of re-running.

### 2. A zombie pass clobbered terminal state (critical) — fixed

`execute`'s terminal write was a blind `store.updateRun` that only special-cased
`cancelled`. A stale pass (its lease reclaimed by a new owner mid-step) that
finished after the new owner had already completed the run overwrote the new
owner's status and output.

**Fix:** terminal/paused writes now go through `finalizeRun`, which re-reads the
run and defers to any terminal state already recorded rather than overwriting it.

### 3. A non-JSON-safe step result re-ran forever (medium) — fixed

`assertJsonSafe` runs inside `saveStep`, i.e. *after* the side effect ran. A step
returning a value that cannot be persisted (`Date`, `Map`, `bigint`, a class
instance) threw at persist time, so the step was never recorded completed and
re-ran its side effect on *every* resume — it never healed.

**Fix:** when a completed-step write fails, the engine classifies it. A
deterministic serialization failure (the result is inherently unstorable) marks
the step `poisoned` — a new `StepStatus` that resume refuses to re-run, failing
the run non-retryably with a clear error. A *transient* persist failure (a crash
or power loss before the write landed) is re-thrown unchanged, preserving the
documented at-least-once behavior of re-running on resume.

## Residual boundary (by design, not a bug)

**Cross-process lease expiry mid-step is still at-least-once.** The per-run mutex
serializes overlapping passes *within one process*. Two genuinely separate
processes (separate `Keel` instances) whose shared store lets one reclaim a
lease while the other is still inside a step can each run that step once, because
no in-process lock spans processes. This is the same at-least-once window keel
documents for crash-before-persist: use `StepOptions.idempotencyKey` (stable per
step by default) to make the repeat safe downstream. See
[Delivery guarantee](../README.md#delivery-guarantee) and
[LIMITATIONS.md](LIMITATIONS.md).
