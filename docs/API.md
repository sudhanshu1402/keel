# API reference

## Engine

- `new Keel({ store?, provider?, sleepFn?, now?, idFactory?, durableTimers?, onEvent? })` - defaults to `MemoryStore`, no provider, `durableTimers: false`.
- `keel.run(def, input)` - start a workflow. Returns `{ runId, status, output? }`; `output` is set on a completed run.
- `keel.resume(runId)` - resume after a crash. Register the workflow first in a fresh process. A completed or cancelled run resumes to a no-op.
- `keel.sendSignal(runId, name, value)` - deliver a signal, resuming the run if it was paused on it.
- `keel.cancel(runId)` - cancel cooperatively at the next durable boundary.
- `keel.register(def)` - register a workflow definition.

## Defining work

- `defineWorkflow(name, handler, opts?)` - declare a workflow. `opts.version` pegs a run to the code version that started it.
- `defineAgent(name, opts)` - durable multi-turn tool-calling agent. `opts.maxTurns`, `opts.maxTokens`, `opts.maxCostUsd`, `opts.historyWindow`, per-tool `validateArgs`.

## Context

- `ctx.step(name, fn, opts?)` - durable step. `opts.retry`, `opts.timeoutMs`, `opts.idempotencyKey`. `fn` receives `{ attempt, signal, idempotencyKey }`.
- `ctx.all(name, [fn, ...], opts?)` - sibling steps concurrently, deterministic on replay. Each child reserves its call position before any run.
- `ctx.now()` / `ctx.random()` / `ctx.uuid()` - replay-stable clock, RNG, and ids. Each is recorded as a step.
- `ctx.sleep(name, ms)` - delay. Durable suspend when `durableTimers` is on, in-process block otherwise.
- `ctx.waitForSignal(name)` - pause until a signal arrives.
- `ctx.llm(name, { prompt, model? })` - durable LLM step with token capture.

## Runtime

- `new Supervisor(keel, store, { pollMs?, now?, workerId?, leaseMs?, renewMs?, onError? })` - wakes sleeping and signal-ready runs.
- `new Worker(keel, store, { workerId?, concurrency?, leaseMs?, renewMs?, pollMs?, now?, onError? })` - multi-worker executor over a `ConcurrentStore`.
- `onError` on both takes background failures from the poll loop and the lease heartbeat. Those are fire-and-forget, so without it a store rejection becomes an unhandled rejection. Defaults to `console.error`.
- `createTestKeel(opts?)` - in-memory deterministic engine for tests.
- `startDashboard({ store, keel?, port?, host?, allowRemote? })` - resolves to `{ server, port }`. Without `keel` the dashboard is read-only plus store writes: Resume reports that no engine is registered and a signal is only stored. Binds to `127.0.0.1`; a non-loopback `host` throws unless `allowRemote: true`, because it has no auth.
- `createDashboard(opts)` - the same server, unstarted, if you want to own `listen`.
- `runCli(argv, io?)` - CLI entry point. Resolves to the process exit code and closes any store it opened.

## Stores and providers

- Stores: `MemoryStore`, `FileStore`, `SqliteStore` (imported from `@sudhanshu1402/keel/sqlite`).
- `Store`: `createRun`, `getRun`, `updateRun`, `getStep`, `saveStep`, `listRuns`, `listSteps`, `getReadySteps`, `saveSignal`, `getSignal`. Every write path bumps the run's `version`.
- `ConcurrentStore` adds `claimRun`, `releaseClaim`, `updateRunCAS`. `isConcurrentStore(store)` narrows to it. `MemoryStore` implements it for in-process fan-out, `SqliteStore` for cross-process workers. The engine serialises on leases, so it never calls `updateRunCAS`; that is for your own read-decide-write code.
- `SqliteStore.close()` checkpoints the WAL and releases the handle. Call it on shutdown; the other two stores need no close.
- Providers: `OllamaProvider`, `MockProvider`.

## Errors

- `DivergenceError` - steps reordered or renamed between runs.
- `WorkflowVersionError` - resuming under a changed `version`.
- `CancelledError` - thrown into a run that was cancelled.
- `StepFailedError` - a step exhausted its retries, or was already poisoned. Carries the underlying error.
- `TimeoutError` - a step passed its `timeoutMs`. Not retried by default, because the side effect may still be running.
- `PausedError` - internal control flow for `waitForSignal` and durable sleep; it suspends a run rather than failing it.

## CLI

```bash
keel runs                            # list runs in the store
keel inspect <runId>                 # show a run and its steps
keel resume <runId>                  # requeue a failed or paused run for a Worker
keel cancel <runId>                  # cancel a run
keel signal <runId> <name> [json]    # deliver a signal
keel dashboard [--port <n>]          # serve the dashboard

# every command takes --store <file.json> or --db <file.sqlite>
```
