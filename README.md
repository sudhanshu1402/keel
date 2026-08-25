<h1>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/sudhanshu1402/keel/main/assets/banner-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/sudhanshu1402/keel/main/assets/banner-light.svg" />
  <img src="https://raw.githubusercontent.com/sudhanshu1402/keel/main/assets/banner-dark.svg" width="100%" alt="keel: durable execution for TypeScript, no server and no database. on npm, zero runtime dependencies, node >= 20. The failure it exists for: the process dies after the charge. restart replays from disk. charged once." />
</picture>
</h1>

[![CI](https://github.com/sudhanshu1402/keel/actions/workflows/ci.yml/badge.svg)](https://github.com/sudhanshu1402/keel/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/%40sudhanshu1402%2Fkeel.svg)](https://www.npmjs.com/package/@sudhanshu1402/keel) [![npm downloads](https://img.shields.io/npm/dm/%40sudhanshu1402%2Fkeel.svg)](https://www.npmjs.com/package/@sudhanshu1402/keel) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

Durable execution for TypeScript: crash-safe workflows replayed step by step from disk, with no server, no database cluster and no build step. Same idea as Temporal and Vercel Workflow, in a plain Node script.

![keel at a glance: steps replay from disk, zero dependencies, no infrastructure, 20,000 steps replayed in 434 milliseconds](https://raw.githubusercontent.com/sudhanshu1402/keel/main/assets/glance.svg)

![keel charges a card, crashes, then resumes and ships without charging again](demo/demo.gif)

Your code charges a card, reserves stock, then ships. The process dies after the charge. Restart it naively and the customer pays twice. Same trap with an AI agent: crash mid-run, restart, pay for every token again.

![Run 1 runs charge and reserve, saves both, then the process dies before ship. Run 2 serves charge and reserve from disk and runs ship once, so the card is charged exactly once](https://raw.githubusercontent.com/sudhanshu1402/keel/main/assets/replay.svg)

## Quick start

```bash
npm install @sudhanshu1402/keel
```

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
```

`ctx.step(name, fn)` runs `fn` once, persists the result under `name`, and on any later execution of the same run hands back the stored result without calling `fn`. That is the whole durability contract.

## Surviving a restart

```ts
import { Keel, FileStore, defineWorkflow } from '@sudhanshu1402/keel';

const keel = new Keel({ store: new FileStore('keel-data/orders.json') });
const result = await keel.run(order, { id: 'A-1001' });
// ...process crashes after the charge step...

// new process, workflow registered:
keel.register(order);
await keel.resume(result.runId);   // charge replays from disk, card not charged twice
```

Runnable version in [examples/order-workflow.ts](examples/order-workflow.ts). Reordering or renaming steps between runs is caught by a divergence guard.

## Dashboard

```bash
npx keel dashboard --store keel-data/orders.json
# keel dashboard on http://127.0.0.1:4500
```

A zero-dependency `node:http` server over the same store your app writes: run list, step timelines, token counts, errors, Resume and Send-signal. Started from the CLI it holds no engine, so a working Resume needs `startDashboard({ store, keel })` inside your app. Cancel is `keel cancel <runId>`.

## Delivery guarantee

**At-least-once**, like every durable engine. A `completed` step never re-runs; a step whose side effect landed before the result was persisted does, so keep side effects idempotent. Every step gets a stable `idempotencyKey` (default `"<runId>:<stepName>"`) as `helpers.idempotencyKey`. Use `ctx.now()`, `ctx.random()`, `ctx.uuid()` so they replay the same value. Detail in [LIMITATIONS.md](docs/LIMITATIONS.md).

| | keel | Vercel Workflow | Temporal |
|---|---|---|---|
| Build step | none | SWC + bundler | none |
| Plain Node | yes | no, needs their bundler | yes |
| Dashboard | built in, zero config | via build toolchain | run a server |
| Runtime deps | zero | bundler + runtime | server + client |
| Store | memory / JSON / SQLite | Postgres / managed | DB cluster |

Side by side in [COMPARISON.md](docs/COMPARISON.md).

## Docs

| | |
|---|---|
| [GUIDE.md](docs/GUIDE.md) | signals, durable sleep, LLM steps, agents, SQLite and multi-worker, testing, hardening |
| [API.md](docs/API.md) | full API and CLI reference |
| [BENCHMARKS.md](docs/BENCHMARKS.md) | throughput and recovery numbers, including the 434 ms above |
| [COMPARISON.md](docs/COMPARISON.md) | side by side with Vercel Workflow, Temporal, Inngest |
| [LIMITATIONS.md](docs/LIMITATIONS.md) | what keel deliberately does not do |
| [KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) | open correctness issues, read before production use |

## Status

v1.0, CI on Node 20 and 22. The `SqliteStore` suite is Node 22 only, because `node:sqlite` needs 22.5+ with `--experimental-sqlite`; the engine, `MemoryStore` and `FileStore` run on 20. keel targets a long-lived Node process; edge and serverless runtimes are out of scope by design.

Regenerate the diagrams with `npm run assets`.

## License

MIT
