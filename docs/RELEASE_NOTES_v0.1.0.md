# keel v0.1.0

The first release: the durable execution core.

## What it does

Run a workflow as a sequence of named steps. Each completed step's result is persisted, and on any later execution of the same run the stored result replays instead of running again. If the process crashes at step 7, a resume picks up at step 7. It is at-least-once (a step interrupted mid-side-effect re-runs on resume); the steps that already finished are never redone.

## Highlights

- **Durable steps** with `ctx.step(name, fn)` — completed steps replay from the store; at-least-once with idempotency keys for the crash-mid-step window.
- **Crash recovery** — `keel.resume(runId)` rebuilds state from the store after a restart.
- **Durable sleep** — `ctx.sleep(name, ms)` survives restarts and does not re-wait once elapsed.
- **Retries** with exponential backoff and a per-step policy.
- **Durable LLM steps** — `ctx.llm(name, { prompt })` with token capture; memoized so a resume never repays for a completion.
- **Stores** — `MemoryStore` (default) and `FileStore` (single JSON file, atomic writes).
- **Providers** — `OllamaProvider` (free, local, no API key) and `MockProvider` for tests.
- **Zero runtime dependencies.** Fully typed. Node 20+.

## Install

```bash
npm install @sudhanshu1402/keel
```

## Try it

```bash
npm run example:order                     # charge, crash, resume, ship once
npm run example:agent -- "durable execution" --mock
```

## Not yet (on the roadmap)

Single-process today; not a distributed scheduler. Next: a localhost run dashboard, human-in-the-loop signals, and SQLite/Redis store adapters.

## License

MIT
