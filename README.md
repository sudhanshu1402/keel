# keel

[![CI](https://github.com/sudhanshu1402/keel/actions/workflows/ci.yml/badge.svg)](https://github.com/sudhanshu1402/keel/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

Durable execution for TypeScript AI agents. Crash-proof workflows that resume exactly where they left off, with zero cloud services and zero cost.

![keel charges a card, crashes, then resumes and ships without charging again](demo/demo.gif)

If your agent calls an LLM, charges a card, then crashes, you do not want to repeat the LLM call or the charge on restart. keel records every step. On resume, completed steps replay from a local store instead of running again. A workflow that died at step 7 picks up at step 7.

## Why

Temporal, Inngest, and DBOS solve this, but they pull in a server, a hosted control plane, or a database. keel is the same core idea in a few hundred lines of dependency-free TypeScript:

- **Zero runtime dependencies** in the core.
- **Local-first.** Default store is an in-memory map; the file store is a single JSON file. No database, no broker, no account.
- **Free LLMs.** Ships with an [Ollama](https://ollama.com) provider (local, no API key). Bring any provider by implementing one method.
- **Typed.** Workflows, steps, and results are fully typed end to end.

## Install

```bash
npm install @sudhanshu1402/keel
```

Requires Node.js 20 or newer.

## Quickstart

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

Ollama runs locally and free:

```bash
ollama serve
ollama pull llama3.2
```

No Ollama? The full agent example falls back to a mock provider:

```bash
npx tsx examples/agent-research.ts "durable execution" --mock
```

## Retries and durable sleep

Steps retry with exponential backoff. Override the policy per step:

```ts
await ctx.step('flaky-call', () => callFlakyApi(), {
  retry: { maxAttempts: 5, baseMs: 200, factor: 2, jitter: true },
});
```

`ctx.sleep(name, ms)` is a durable delay. Once it has elapsed, a resume skips it instead of waiting again.

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

Implement the `Store` interface to back runs with Redis, SQLite, or Postgres. The engine only depends on the interface.

## API

- `new Keel({ store?, provider? })` — engine. Defaults to `MemoryStore` and no provider.
- `keel.run(def, input)` — start a workflow, returns `{ runId, status, output? }`.
- `keel.resume(runId)` — resume a run after a crash. Register the workflow first if it is a fresh process.
- `defineWorkflow(name, handler)` — declare a workflow. The handler receives `(ctx, input)`.
- `ctx.step(name, fn, opts?)` — durable step with optional retry policy.
- `ctx.sleep(name, ms)` — durable delay.
- `ctx.llm(name, { prompt, model? })` — durable LLM step, captures token counts.
- Stores: `MemoryStore`, `FileStore`. Providers: `OllamaProvider`, `MockProvider`.

## Status

v0.1, the durable core. Planned next: a localhost run dashboard, human-in-the-loop signals (`ctx.waitForSignal`), and adapters for Redis and SQLite. Tracked in [docs/superpowers/specs](docs/superpowers/specs).

## License

MIT
