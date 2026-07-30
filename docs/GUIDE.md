# Guide

Everything past the quick start. API signatures live in [API.md](API.md).

## Durable sleep and signals

`ctx.waitForSignal(name)` pauses a run until an outside event arrives. The run stays suspended in the store the whole time, so the process can exit and come back.

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
await keel.sendSignal(runId, 'decision', 'approved');
```

`ctx.sleep(name, ms)` blocks the current process by default, which is right for single-shot scripts and tests. Construct with `new Keel({ store, durableTimers: true })` to make a sleep survive a restart: the run suspends durably and a running `Supervisor` wakes it when the timer is due.

## LLM steps

`ctx.llm` is a step backed by a provider, with token capture. It's memoized like any step, so a resume never repays for a completion already received.

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
```

Ollama runs locally and free (`ollama serve && ollama pull llama3.2`). Without it, the example falls back to a mock: `npx tsx examples/agent-research.ts "durable execution" --mock`. OpenAI and Anthropic providers are in [examples/providers](../examples/providers).

## Durable agents

`defineAgent` wraps a multi-turn tool-calling loop where every model turn is a `ctx.llm` and every tool call is a `ctx.step`. The whole loop is memoized, so an agent that crashes mid-tool-call resumes without re-calling the model for turns it already took.

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

The model replies with one JSON object per turn, either `{"tool": "...", "args": {...}}` or `{"final": "..."}`. The loop always terminates. `stopReason` is `'final'`, `'max_turns'`, or `'budget'`, and only `'final'` means the model actually produced an answer. A malformed reply is fed back as an error observation, never silently treated as final. Crash-and-resume demo in [examples/durable-agent.ts](../examples/durable-agent.ts).

## SQLite store and multi-worker

`FileStore` rewrites its JSON file on every commit. Simple and diffable, but it doesn't scale to long runs or high volume (see [BENCHMARKS.md](BENCHMARKS.md)). For volume, use the SQLite store, built on Node's own `node:sqlite` so the dependency count stays at zero. Needs Node 22.5+ run with `--experimental-sqlite`, or Node 24+ where it's on by default.

```ts
import { SqliteStore } from '@sudhanshu1402/keel/sqlite';
import { Worker } from '@sudhanshu1402/keel';

const store = new SqliteStore('keel-data/keel.sqlite');
const keel = new Keel({ store });

const w1 = new Worker(keel, store, { concurrency: 4 });
const w2 = new Worker(keel, store, { concurrency: 4 });
w1.start();
w2.start();
```

`SqliteStore` is a `ConcurrentStore`: lease-based claiming plus compare-and-swap updates, so multiple workers drain one store without double-executing a step.

## Testing with zero infrastructure

`createTestKeel` builds a fully in-memory deterministic engine: a `MemoryStore`, a `MockProvider` with a counted call log, instant sleeps, stable run ids, and a controllable clock. No database, no broker, no real time, no API keys.

```ts
import { createTestKeel } from '@sudhanshu1402/keel';

const t = createTestKeel({ respond: () => 'ok' });
const r = await t.keel.run(myWorkflow, input);
expect(t.provider.calls).toBe(1); // model called exactly once
t.advance(60_000);                // drive durable timers without waiting
```

## Hardening

- `ctx.step(name, fn, { timeoutMs })` fails a step that hangs past its deadline and aborts the attempt's `AbortSignal` so cooperative work can stop. Timeouts aren't retried by default, since a timed-out side effect may still be running.
- `keel.cancel(runId)` cancels at the next durable boundary, throwing `CancelledError`. A cancel landing during the final step wins over completion.
- `ctx.all(name, [fn, ...])` runs siblings concurrently with deterministic replay.
- `new Keel({ onEvent })` emits `step:start` / `step:complete` / `step:fail` per step for OpenTelemetry spans or metrics. Errors thrown by the callback are swallowed, so observability can't break a run.
- `defineWorkflow(name, handler, { version })` pegs a run to its code version; resuming under a changed version throws `WorkflowVersionError`.
- Steps retry with exponential backoff. Override per step with `{ retry: { maxAttempts, baseMs, factor, jitter } }`.

## Custom providers and stores

One method to use any LLM:

```ts
import type { Provider } from '@sudhanshu1402/keel';

const openai: Provider = {
  async complete({ prompt, model }) {
    const res = await callOpenAI(prompt, model);
    return { text: res.text, tokensIn: res.usage.prompt, tokensOut: res.usage.completion };
  },
};
```

Implement the `Store` interface, or `ConcurrentStore` for multi-worker, to back runs with Redis, Postgres, or anything else. The engine only depends on the interface.
