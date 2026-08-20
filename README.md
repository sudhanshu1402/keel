<h1>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/sudhanshu1402/keel/main/assets/banner-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/sudhanshu1402/keel/main/assets/banner-light.svg" />
  <img src="https://raw.githubusercontent.com/sudhanshu1402/keel/main/assets/banner-dark.svg" width="100%" alt="keel: durable execution for TypeScript, no server and no database. on npm, zero runtime dependencies, node >= 20. The failure it exists for: the process dies after the charge. restart replays from disk. charged once." />
</picture>
</h1>

[![CI](https://github.com/sudhanshu1402/keel/actions/workflows/ci.yml/badge.svg)](https://github.com/sudhanshu1402/keel/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/%40sudhanshu1402%2Fkeel.svg)](https://www.npmjs.com/package/@sudhanshu1402/keel) [![npm downloads](https://img.shields.io/npm/dm/%40sudhanshu1402%2Fkeel.svg)](https://www.npmjs.com/package/@sudhanshu1402/keel) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

Durable execution for TypeScript, deliberately lighter. Same idea as Temporal and Vercel Workflow, but with no build tooling and no database: drop it into any Node script, persist to a file, debug on a local dashboard.

![keel charges a card, crashes, then resumes and ships without charging again](demo/demo.gif)

## What it does

Your code charges a card, reserves stock, then ships. The process dies after the charge. Restart it naively and the customer pays twice. Same trap with AI agents: crash mid-run, restart, pay for every token again.

Write the work as named steps. When a step finishes, keel saves its result. On restart it hands back the saved result instead of running the step again, so a run that died at step 7 picks up at step 7 with steps 1 through 6 served from disk. That's durable execution, and the demo above is exactly it: run 1 charges and crashes, run 2 resumes and ships without re-charging.

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
```

Each `ctx.step(name, fn)` runs `fn` once, persists the result under `name`, and on any later execution of the same run returns the stored result without calling `fn` again. That's the entire durability contract.

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

A zero-dependency `node:http` server reading the same store your app writes: run list, per-run step timelines, token counts, errors, and Resume and Send-signal buttons. No config, no account.

Started from the CLI it has no engine in the process, so a signal is only stored for a running Worker to pick up, and Resume returns an error because executing workflow code needs your registered workflows. Call `startDashboard({ store, keel })` from inside your app to get a Resume button that actually runs. Cancelling is `keel cancel <runId>`; the dashboard has no cancel route.

## Why keel

Temporal, Inngest, DBOS, and Vercel's Workflow SDK all do durable execution, and all of them bring a server, a control plane, a database, or a build-time transform. keel makes the opposite trade: a few hundred lines of dependency-free TypeScript, `package.json` with no `dependencies` field at all.

The one that matters most in practice: Vercel's SDK is built on `"use workflow"` directives that only work inside their bundler, so you can't run those files in plain Node. keel is ordinary method calls.

| | keel | Vercel Workflow | Temporal |
|---|---|---|---|
| Build step required | no | yes (SWC + bundler) | no |
| Runs in plain Node | yes | no | yes |
| Local dashboard, zero config | yes | local UI via build toolchain | run a server |
| Core runtime deps | zero | bundler + runtime | server + client |
| Store | memory / JSON / SQLite | Postgres / managed | DB cluster |

## Delivery guarantee

keel is **at-least-once**, like every durable engine. Be clear about what that buys you:

- A step that reached `completed` is never re-run. Its saved result replays.
- A step whose side effect ran but whose process died before the result was persisted **re-runs** on resume. So does a failed step you explicitly resume.
- Therefore: make side effects idempotent. Every step gets a stable `idempotencyKey` (default `"<runId>:<stepName>"`, or pass your own) and receives it as `helpers.idempotencyKey`. Forward it to APIs that accept one and a retried charge collapses to a single charge.
- Use `ctx.now()`, `ctx.random()`, and `ctx.uuid()` instead of the globals. Each is recorded as a step and replays the same value.

What keel does not promise is exactly-once side effects for free. No durable engine can. The honest version is at-least-once plus idempotency keys.

## Docs

- [GUIDE.md](docs/GUIDE.md) - signals, durable sleep, LLM steps, agents, SQLite and multi-worker, testing, hardening.
- [API.md](docs/API.md) - full API and CLI reference.
- [COMPARISON.md](docs/COMPARISON.md) - honest side-by-side with Vercel Workflow, Temporal, Inngest.
- [LIMITATIONS.md](docs/LIMITATIONS.md) - what keel deliberately doesn't do.
- [BENCHMARKS.md](docs/BENCHMARKS.md) - throughput and recovery numbers.
- [KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) - open correctness issues. Read this before production use.

## Status

v1.0, tested in CI on Node 20 and 22. The `SqliteStore` suite is Node 22 only, because `node:sqlite` needs 22.5+ with `--experimental-sqlite`; the engine, `MemoryStore` and `FileStore` have no such requirement and run on 20. keel targets a long-lived Node process; edge and serverless runtimes are out of scope by design.

## License

MIT
