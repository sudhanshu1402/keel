# keel v1.0.0

Durable execution for TypeScript. Zero build step, zero lock-in, a dashboard that
runs on your laptop. Scales from a single JSON file to a SQLite-backed,
multi-worker setup.

v0.1.0 shipped the durable core: named steps that persist and replay, crash
recovery, retries, durable LLM steps. v1.0.0 turns that core into a complete
engine: timers that survive a process exit, human-in-the-loop signals, replay
safety, stores that scale, multi-worker execution, a local dashboard and CLI, a
durable agent loop, and zero-infrastructure testing. Still zero runtime
dependencies.

## What is new since v0.1.0

### Durable timers that actually wake
`ctx.sleep(name, ms)` now suspends the run and records a wake time. A `Supervisor`
polls the store and resumes due runs, so a sleeping workflow survives a process
exit and is picked up by a fresh process. Sleeps do not re-wait once elapsed.

### Human-in-the-loop signals
`ctx.waitForSignal(name)` pauses a run until `keel.sendSignal(runId, name, value)`
delivers a value. The value is memoized, so a later replay returns it without
pausing again. Approvals, callbacks, and external events are first-class.

### Replay safety
A divergence guard verifies that a replayed run hits the same steps in the same
order; a reordered or renamed step throws `DivergenceError` instead of silently
corrupting state. `defineWorkflow(name, handler, { version })` pegs a run to the
code version that started it (`WorkflowVersionError` on mismatch).

### Stores that scale, and concurrency
- `SqliteStore` (`@sudhanshu1402/keel/sqlite`) built on the built-in `node:sqlite`
  module, so it stays zero-dependency. Roughly 13,000 step-commits per second on a
  laptop versus about 90 for a long single-run `FileStore` (see
  [BENCHMARKS.md](BENCHMARKS.md)).
- `ConcurrentStore` adds `claimRun` (lease) and `updateRunCAS`, so multiple
  workers share one store safely.
- `Worker` runs runnable and due runs against a concurrent store with leases and
  heartbeat renewal; N workers race without double-executing a step.

### Local observability: dashboard and CLI
- `npx keel dashboard` serves a zero-dependency `node:http` view of every run,
  step, token count, and error, with Resume and Send-signal buttons. No account,
  no cloud, reads the same store your app writes.
- CLI: `keel runs`, `keel inspect <runId>`, `keel resume <runId>`,
  `keel signal <runId> <name> [json]`.

### Durable agents
`defineAgent` / `runAgentLoop` give a multi-turn tool loop where each model call
and each tool call is a durable step. An agent that crashes mid-tool-call resumes
without re-calling the model for prior turns. Includes a token budget, a
max-turns guard, and per-tool argument validation.

### Zero-infrastructure testing
`createTestKeel` builds an in-memory engine with a mock provider and an
injectable clock. Crash-and-resume is a unit test that runs in milliseconds with
no infra to stand up.

### Hardening and ergonomics
- `keel.cancel(runId)` with cooperative `CancelledError` at the next durable
  boundary.
- `StepOptions.timeoutMs` with a per-attempt `AbortSignal`; timeouts are not
  retried by default.
- `ctx.all(name, [fn, ...])` runs sibling steps concurrently with deterministic
  replay.
- `ctx.now()`, `ctx.random()`, `ctx.uuid()` record their values so replay is
  deterministic.
- Idempotency keys on every step for the crash-mid-side-effect window.
- Observability hook: `new Keel({ onEvent })` emits `step:start` /
  `step:complete` / `step:fail` for OpenTelemetry, metrics, or logs.

## Honest durability contract

keel is at-least-once, not exactly-once. Completed steps replay from the store
and are never re-run. If a process dies after a step's side effect runs but
before its result is persisted, that step re-runs on resume; the duplicate is
collapsed by a stable idempotency key, not prevented. Make side effects
idempotent. This is the same physics every durable engine shares; keel states it
plainly rather than implying magic.

## How it compares

keel wins on local developer experience, no build step, and zero lock-in. Vercel
Workflow's `"use workflow"` / `"use step"` directives need an SWC transform and a
bundler and cannot run in plain `node file.js`; keel is ordinary `ctx.step()`
calls that run anywhere Node runs. It is deliberately "good enough" on the
operational scale the hosted engines were built around. See
[COMPARISON.md](COMPARISON.md) and the honest [LIMITATIONS.md](LIMITATIONS.md).

## Install

```bash
npm install @sudhanshu1402/keel
```

Core and `FileStore` run on Node 20+. `SqliteStore` needs Node 22.5+ with
`--experimental-sqlite`, or Node 24+.

## Try it

```bash
npm run example:order                       # charge, crash, resume, ship once
npm run example:durable-agent -- --mock     # agent survives a crash mid-tool-call
npx keel dashboard                          # local run dashboard, zero config
```

## License

MIT
