# Changelog

## 1.0.2

A failing dashboard request used to answer with the underlying error message. That
message can carry a run id, a store path or a stack from workflow code, and
`startDashboard` accepts `allowRemote: true`, so the response is not necessarily
staying on loopback. Unexpected failures now return a generic body plus a short
`ref`, and the full detail goes to the dashboard process output under the same
`ref`. Nothing is lost for whoever is running it; nothing useful is handed to
whoever is not.

The dashboard's Resume and Signal buttons previously discarded the response
entirely, so a failure looked like nothing happening. They now surface the error
and its `ref` in the run detail pane.

## 1.0.1

Correctness fixes. If you installed 1.0.0 from npm, upgrade — that build predates
all three. Details and reproductions in [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md);
each fix landed with a failing-first regression in
[`tests/correctness-regressions.test.ts`](tests/correctness-regressions.test.ts).

- **Concurrent resume double-executed a step (critical).** Two overlapping passes
  for one run each cleared the step memo before either persisted it, so the side
  effect ran twice. The engine now serializes `run`, `resume`, and signal-driven
  resumes per run with an in-process mutex.
- **A zombie pass clobbered terminal state (critical).** A stale pass finishing
  after its lease was reclaimed overwrote the new owner's status and output.
  Terminal and paused writes now go through `finalizeRun`, which defers to any
  terminal state already recorded.
- **A non-JSON-safe step result re-ran forever (medium).** A step returning a
  `Date`, `Map`, `bigint`, or class instance threw at persist time, so it was
  never recorded and re-ran its side effect on every resume. Deterministic
  serialization failures now mark the step `poisoned`, a new `StepStatus` that
  resume refuses to re-run. Transient persist failures still re-throw, preserving
  at-least-once.

CI now runs the `node:sqlite` suite on Node 22.x, so the concurrency tests are
gated rather than skipped.

Cross-process lease expiry mid-step remains at-least-once by design. Use
`StepOptions.idempotencyKey`. See [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## 1.0.0

Durable timers, signals, replay safety, concurrent and SQLite stores.

## 0.1.0

Initial release. See [docs/RELEASE_NOTES_v0.1.0.md](docs/RELEASE_NOTES_v0.1.0.md).
