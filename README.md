# keel

[![CI](https://github.com/sudhanshu1402/keel/actions/workflows/ci.yml/badge.svg)](https://github.com/sudhanshu1402/keel/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

Durable execution for TypeScript. Zero build step, zero lock-in, and a dashboard that runs on your laptop. Scales from a single JSON file to a SQLite-backed multi-worker pool. No cloud, no account, no cost.

![keel charges a card, crashes, then resumes and ships without charging again](demo/demo.gif)

## What is this?

keel keeps a program running correctly even when it crashes partway through.

Say your code runs three things in order: charge a card, reserve stock, ship the order. If the process dies after the charge but before the ship, restarting it the naive way charges the card a second time. The same trap hits AI agents: crash mid-run and on restart you re-call the model and pay for the tokens all over again.

keel removes that risk. You write the work as named steps. When a step completes, keel saves its result; on restart it hands back the saved result instead of running the step again, so the run continues from where it failed. A run that died at step 7 picks up at step 7, with steps 1 through 6 served from their saved results rather than re-run.

keel is at-least-once, not exactly-once: if a crash lands in the narrow window after a step's side effect ran but before its result was saved, that one step re-runs on restart. That is true of every durable engine. keel gives each step an idempotency key (and you can supply your own) so you can make a repeat safe; see [Delivery guarantee](#delivery-guarantee). The point it buys you is that the steps that already finished are never redone.

That idea is called durable execution. The demo above shows it: run 1 charges the card and crashes, run 2 resumes and ships without re-charging.

## Why keel

Temporal, Inngest, DBOS, and Vercel's Workflow SDK all do durable execution. They also pull in a server, a hosted control plane, a database, or a build-time compiler transform. keel is the same core idea in a few hundred lines of dependency-free TypeScript, with the trade made in the opposite direction:

- **No build step.** Vercel's Workflow SDK is built on `"use workflow"` / `"use step"` directives that only work inside their bundler; you cannot run those files in plain Node. keel is ordinary `ctx.step()` method calls. It runs anywhere Node runs, with no transform in the path.
- **Local observability.** `npx keel dashboard` serves a zero-config run dashboard from your own store. Every run, every step, token counts, errors, Resume and Send-signal buttons, on `http://127.0.0.1`. The hosted engines put this in the cloud.
- **Zero lock-in.** One tier, MIT, no account, no usage pricing. Your run history is a JSON file or a SQLite database you own.
- **Trivial testing.** In-memory store plus a mock provider plus an injectable clock means a durable workflow test needs zero infrastructure and runs deterministically in milliseconds. Crash-and-resume is a unit test.
- **Zero runtime dependencies** in the core. `package.json` has no `dependencies` field at all.

A full, honest side-by-side is in [docs/COMPARISON.md](docs/COMPARISON.md), and what keel deliberately does not do is in [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

| | keel | Vercel Workflow | Temporal |
|---|---|---|---|
| Build step required | no | yes | no |
| Runs in plain Node | yes | no | yes |
| Local dashboard, zero config | yes | cloud only | run a server |
| Account to start | no | yes | no |
| Core runtime deps | zero | bundler + runtime | server + client |
| Store | memory / JSON / SQLite | managed | DB cluster |

## Install

```bash
npm install @sudhanshu1402/keel
```

## Quick start

```ts
import { Keel, defineWorkflow } from '@sudhanshu1402/keel';

const order = defineWorkflow<{ id: string }, { shipped: boolean }>(
  'order',
  async (ctx, input) => {
    const charge = await ctx.step('charge', () => chargeCard(input.id));
    await ctx.step('reserve', () => reserveInventory(input.id));
    return ctx.step('ship', () => ship(input.id, charge));
  },
);

const keel = new Keel(); // in-memory store by default
const result = await keel.run(order, { id: 'A-1001' });
console.log(result.status); // "completed"
```

Each `ctx.step(name, fn)` runs `fn` once, persists the result under `name`, and on any later execution of the same run returns the stored result without calling `fn` again. That is the entire durability contract.

## Crash recovery

Use the file store to survive a process restart, then `resume` by run id:

```ts
import { Keel, FileStore, defineWorkflow } from '@sudhanshu1402/keel';

const keel = new Keel({ store: new FileStore('keel-data/orders.json') });

const result = await keel.run(order, { id: 'A-1001' });
// ...process crashes after the charge step...

// In a new process, with the workflow registered:
keel.register(order);
const resumed = await keel.resume(result.runId);
// charge step is replayed from disk; the card is not charged twice
```

A runnable version is in [examples/order-workflow.ts](examples/order-workflow.ts).

## Durable sleep and human-in-the-loop signals

`ctx.waitForSignal(name)` pauses a run until an outside event arrives. The run is
suspended in the store the whole time it waits, so the process can exit and come
back, then resume when the signal is delivered.

```ts
import { Keel, FileStore, Supervisor, defineWorkflow } from '@sudhanshu1402/keel';

const approval = defineWorkflow<{ docId: string }, string>(
  'approval',
  async (ctx, input) => {
    await ctx.step('submit', () => submitForReview(input.docId));
    const decision = await ctx.waitForSignal<string>('decision'); // pauses here
    return ctx.step('finalize', () => finalize(input.docId, decision));
  },
);

const store = new FileStore('keel-data/approvals.json');
const keel = new Keel({ store });
const supervisor = new Supervisor(keel, store); // wakes signal-ready runs
supervisor.start();

const { runId } = await keel.run(approval, { docId: 'D-7' });
// ...later, when a human clicks Approve...
await keel.sendSignal(runId, 'decision', 'approved'); // resumes the run
```

`ctx.sleep(name, ms)` is a delay. By default (`durableTimers` off) it simply
blocks the current process, which is right for single-shot scripts and tests. To
make a sleep survive a restart, construct the engine with
`new Keel({ store, durableTimers: true })`: the run then suspends durably and a
running `Supervisor` wakes it once the timer is due, even across a process exit.

Reordering or renaming steps between runs is caught by a divergence guard that
throws `DivergenceError`.

## The dashboard

Point the CLI at your store and open the dashboard. No config, no account.

```bash
npx keel dashboard --store keel-data/orders.json
# keel dashboard on http://127.0.0.1:4500
```

It is a zero-dependency `node:http` server that reads the same store your app
writes to: a run list, per-run step timelines with status, token counts and
errors, plus Resume and Send-signal actions. You can also embed it:

```ts
import { startDashboard } from '@sudhanshu1402/keel';
const { port } = await startDashboard({ store, port: 4500 });
```

## CLI

```bash
keel runs                       # list runs in the store
keel inspect <runId>            # show a run and its steps
keel resume <runId>             # requeue a failed or paused run for a Worker
keel cancel <runId>             # cancel a run
keel signal <runId> <name> [json]   # deliver a signal
keel dashboard [--port <n>]     # serve the dashboard

# any command takes --store <file.json> or --db <file.sqlite>
```

## LLM steps

`ctx.llm` is a step backed by a provider, with token capture. The call is memoized like any step, so a resume never repays for a completion already received.

```ts
import { Keel, OllamaProvider, defineWorkflow } from '@sudhanshu1402/keel';

const research = defineWorkflow<{ topic: string }, string>(
  'research',
  async (ctx, input) => {
    const plan = await ctx.llm('plan', {
      prompt: `Three research questions about ${input.topic}`,
    });
    const summary = await ctx.llm('summary', {
      prompt: `Write a briefing on ${input.topic}:\n${plan.text}`,
    });
    return summary.text;
  },
);

const keel = new Keel({ provider: new OllamaProvider() });
const result = await keel.run(research, { topic: 'durable execution' });
```

Ollama runs locally and free (`ollama serve && ollama pull llama3.2`). No Ollama?
The example falls back to a mock provider: `npx tsx examples/agent-research.ts "durable execution" --mock`.
Example OpenAI and Anthropic providers live in [examples/providers](examples/providers).

## Durable agents

`defineAgent` wraps a multi-turn tool-calling loop where every model turn is a
`ctx.llm` and every tool call is a `ctx.step`. The whole loop is memoized, so an
agent that crashes mid-tool-call resumes without re-calling the model for turns
it already took.

```ts
import { defineAgent } from '@sudhanshu1402/keel';

const agent = defineAgent('researcher', {
  tools: [
    { name: 'search', description: 'web search', run: async ({ q }) => search(q) },
    { name: 'fetch', description: 'read a url', run: async ({ url }) => fetch(url) },
  ],
  maxTurns: 8,
});

const result = await keel.run(agent, { prompt: 'Summarize durable execution' });
if (result.status === 'completed' && result.output?.stopReason === 'final') {
  console.log(result.output.answer);
}
```

The model replies with one JSON object per turn, either `{"tool": "...", "args":
{...}}` or `{"final": "..."}`. The loop always terminates, and the result carries
a `stopReason` of `'final'`, `'max_turns'`, or `'budget'` (set `maxTurns`,
`maxTokens`, or `maxCostUsd`). Only `'final'` means the model actually produced
an answer; a malformed reply is fed back as an error observation, never silently
treated as the final answer. A crash-and-resume demo is in
[examples/durable-agent.ts](examples/durable-agent.ts).

## Scaling: SQLite store and multi-worker

The default `FileStore` rewrites its JSON file on every commit, which is simple
and diffable but does not scale to long runs or high volume (see
[docs/BENCHMARKS.md](docs/BENCHMARKS.md)). For volume, switch to the SQLite store
(built on Node's built-in `node:sqlite`, still zero-dependency; needs Node 22.5+
run with `--experimental-sqlite`, or Node 24+ where it is on by default):

```ts
import { SqliteStore } from '@sudhanshu1402/keel/sqlite';

const store = new SqliteStore('keel-data/keel.sqlite');
const keel = new Keel({ store });
```

`SqliteStore` is a `ConcurrentStore`: it supports lease-based claiming and
compare-and-swap updates, so multiple `Worker`s can drain one store without ever
double-executing a step.

```ts
import { Worker } from '@sudhanshu1402/keel';

const w1 = new Worker(keel, store, { concurrency: 4 });
const w2 = new Worker(keel, store, { concurrency: 4 });
w1.start();
w2.start();
```

## Testing with zero infrastructure

`createTestKeel` builds a fully in-memory, deterministic engine: a `MemoryStore`,
a `MockProvider` with a counted call log, instant sleeps, stable run ids, and a
controllable clock. No database, no broker, no real time, no API keys.

```ts
import { createTestKeel } from '@sudhanshu1402/keel';

const t = createTestKeel({ respond: () => 'ok' });
const r = await t.keel.run(myWorkflow, input);
expect(t.provider.calls).toBe(1); // model called exactly once
t.advance(60_000);                // drive durable timers without waiting
```

## Delivery guarantee

keel is **at-least-once**, like every durable engine. The contract:

- A step that has reached `completed` is never re-run; its saved result replays. A run that has reached `completed` or `cancelled` is terminal and a stray `resume` is a no-op.
- A step whose side effect ran but whose process died before the result was persisted **re-runs** on resume. A failed step also re-runs when you resume the run.
- So: make side effects idempotent. Every step gets a stable `idempotencyKey` (default `"<runId>:<stepName>"`, or pass your own via `ctx.step(name, fn, { idempotencyKey })`); the step function receives it as `helpers.idempotencyKey` alongside `helpers.attempt` and an `AbortSignal`. Forward it to APIs that support idempotency keys (Stripe, etc.) and a retried charge collapses to one.
- For values that must be stable across replays, use `ctx.now()`, `ctx.random()`, and `ctx.uuid()` instead of `Date.now()` / `Math.random()` / `randomUUID()` in workflow code: each is recorded as a step and replays the same value.

What keel does **not** promise is exactly-once side effects with no work on your part. No durable engine can; the honest version is at-least-once plus idempotency keys.

## Hardening

- `ctx.step(name, fn, { timeoutMs })` fails a step that hangs past the deadline. The attempt's `AbortSignal` is aborted so cooperative work can stop. Timeouts are not retried by default (a timed-out side effect may still be running).
- `keel.cancel(runId)` cancels a run cooperatively at the next durable boundary, throwing `CancelledError`. A cancel that lands during the final step wins over completion.
- `ctx.all(name, [fn, ...])` runs sibling steps concurrently with deterministic replay (each child reserves its call position before any runs).
- `new Keel({ onEvent })` emits a `step:start` / `step:complete` / `step:fail` event per step so you can wire OpenTelemetry spans or metrics; thrown callback errors are swallowed so observability never breaks a run.
- `defineWorkflow(name, handler, { version })` pegs a run to the code version that started it; resuming under a changed version throws `WorkflowVersionError`.
- Steps retry with exponential backoff; override per step with `{ retry: { maxAttempts, baseMs, factor, jitter } }`.

## Custom providers and stores

Implement one method to use any LLM:

```ts
import type { Provider } from '@sudhanshu1402/keel';

const openai: Provider = {
  async complete({ prompt, model }) {
    const res = await callOpenAI(prompt, model);
    return { text: res.text, tokensIn: res.usage.prompt, tokensOut: res.usage.completion };
  },
};
```

Implement the `Store` interface (or `ConcurrentStore` for multi-worker) to back runs with Redis, Postgres, or anything else. The engine only depends on the interface.

## API

- `new Keel({ store?, provider?, sleepFn?, now?, idFactory?, durableTimers?, onEvent? })` - engine. Defaults to `MemoryStore`, no provider, `durableTimers: false`.
- `keel.run(def, input)` - start a workflow, returns `{ runId, status, output? }` (`output` is set on a completed run).
- `keel.resume(runId)` - resume a run after a crash. Register the workflow first if it is a fresh process. A completed or cancelled run resumes to a no-op.
- `keel.sendSignal(runId, name, value)` - deliver a signal; resumes the run if it was paused on it.
- `keel.cancel(runId)` - cancel a run cooperatively.
- `defineWorkflow(name, handler, opts?)` - declare a workflow. `opts.version` pegs the run version.
- `ctx.step(name, fn, opts?)` - durable step. `opts.retry`, `opts.timeoutMs`, `opts.idempotencyKey`. `fn` receives `{ attempt, signal, idempotencyKey }`.
- `ctx.all(name, [fn, ...], opts?)` - run sibling steps concurrently, deterministic on replay.
- `ctx.now()` / `ctx.random()` / `ctx.uuid()` - replay-stable clock, RNG, and ids (each recorded as a step).
- `ctx.sleep(name, ms)` - delay; durable suspend when `durableTimers` is on, in-process block otherwise.
- `ctx.waitForSignal(name)` - pause until a signal arrives.
- `ctx.llm(name, { prompt, model? })` - durable LLM step, captures token counts.
- `defineAgent(name, opts)` - durable multi-turn tool-calling agent workflow. `opts.maxTurns`, `opts.maxTokens`, `opts.maxCostUsd`, `opts.historyWindow`; per-tool `validateArgs`.
- `new Supervisor(keel, store, { pollMs? })` - wakes sleeping and signal-ready runs.
- `new Worker(keel, store, { concurrency?, leaseMs?, pollMs? })` - multi-worker executor over a `ConcurrentStore`.
- `createTestKeel(opts?)` - in-memory deterministic engine for tests.
- `startDashboard({ store, port? })` / `runCli(argv)` - dashboard and CLI.
- Stores: `MemoryStore`, `FileStore`, `SqliteStore` (via `@sudhanshu1402/keel/sqlite`).
- Providers: `OllamaProvider`, `MockProvider`.

## Docs

- [docs/COMPARISON.md](docs/COMPARISON.md) - keel vs Vercel Workflow, Temporal, Inngest.
- [docs/LIMITATIONS.md](docs/LIMITATIONS.md) - what keel deliberately does not do.
- [docs/BENCHMARKS.md](docs/BENCHMARKS.md) - throughput and recovery numbers, with `npm run bench`.

## Status

v1.0. The durable core, durable timers and signals, replay-divergence and
version guards, a SQLite store with multi-worker claiming, a local dashboard and
CLI, durable agents, and zero-infra testing helpers are all built and tested
(Node 20 and 22). keel targets a long-lived Node process; edge and serverless
runtimes are out of scope by design (see [docs/LIMITATIONS.md](docs/LIMITATIONS.md)).

## License

MIT
