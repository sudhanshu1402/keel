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

- `new Supervisor(keel, store, { pollMs? })` - wakes sleeping and signal-ready runs.
- `new Worker(keel, store, { concurrency?, leaseMs?, pollMs? })` - multi-worker executor over a `ConcurrentStore`.
- `createTestKeel(opts?)` - in-memory deterministic engine for tests.
- `startDashboard({ store, port? })` / `runCli(argv)` - dashboard and CLI entry points.

## Stores and providers

- Stores: `MemoryStore`, `FileStore`, `SqliteStore` (imported from `@sudhanshu1402/keel/sqlite`).
- Providers: `OllamaProvider`, `MockProvider`.

## Errors

- `DivergenceError` - steps reordered or renamed between runs.
- `WorkflowVersionError` - resuming under a changed `version`.
- `CancelledError` - thrown into a run that was cancelled.

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
