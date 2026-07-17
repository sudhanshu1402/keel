# Launch copy (ready to paste)

Edit lightly to sound like you. Post Tue-Thu morning ET. Be present in the
comments for the first 4 hours. The "vs Vercel Workflow" reply below is the most
important thing in this file: someone will raise it in the first 10 minutes, so
own the comparison instead of being cornered by it.

---

## Show HN

**Title** (HN strips emoji; keep it plain):

```
Show HN: keel - durable execution for TypeScript, no build step, no database
```

One-line positioning (use as the repo description and the lede everywhere):
Same idea as Temporal and Vercel Workflow, deliberately lighter - durable
execution with zero build tooling and zero database, for side projects, local
agents, and internal tools.

**First comment (post immediately after submitting):**

```
I kept hitting the same problem building agents: the process dies halfway
through a run and on restart it repeats work it already did - re-calls the LLM,
re-charges the card, re-sends the email.

Durable execution fixes that. Temporal, Inngest, DBOS, and now Vercel's Workflow
SDK all do it - but they each want something heavy: a server, a hosted control
plane, a database, or a build-time compiler transform. I wanted the core idea
with none of that, so I wrote keel: durable execution in a few hundred lines of
dependency-free TypeScript.

You write a workflow as named steps. Each completed step's result is persisted,
and on a resume those steps replay from a local store instead of running again. A
run that died at step 7 picks up at step 7. (It is at-least-once with idempotency
keys, like every durable engine - the steps that already finished are never
redone.)

  const order = defineWorkflow('order', async (ctx, input) => {
    const charge = await ctx.step('charge', () => chargeCard(input.id));
    await ctx.step('reserve', () => reserveInventory(input.id));
    return ctx.step('ship', () => ship(input.id, charge));
  });

The three trades keel makes that the others do not:

  1. No build step. ctx.step() is a plain method call. It runs in `node file.js`,
     in a test, in a cron job. No bundler, no directives, no transform.
  2. Local observability with nothing to stand up. `npx keel dashboard` serves a
     run dashboard straight from your own store - every run, step, token count,
     error, plus Resume and Send-signal buttons. No build toolchain, no queue
     backend, no account.
  3. Zero lock-in. MIT, one tier, no account. Your history is a JSON file or a
     SQLite db you own.

It does durable timers, human-in-the-loop signals (ctx.waitForSignal), replay
divergence and version guards, a SQLite store with lease-based multi-worker
claiming, durable agents (each model turn and tool call is a memoized step), and
in-memory testing helpers so a crash/resume test needs zero infra.

What it is NOT: a managed cluster or a multi-language platform. It targets a
long-lived Node process, not an org-wide scheduler, and edge/serverless is out
of scope on purpose. I wrote an honest Limitations page rather than hand-wave it.

Repo, comparison table, benchmarks, and a runnable crash/resume demo in the
README. Feedback welcome, especially on the step API and what would make you
actually use it.
```

**Canned reply for "isn't this just Vercel Workflow / didn't Vercel just ship this?":**

```
Vercel's Workflow SDK is good and solves the same core problem - and to be fair,
it has gotten more self-contained: v4 can self-host, and `npx workflow web`
gives you a local run UI. The difference is structural, not feature-count.

Their design is built on "use workflow" and "use step" directives that an SWC
transform rewrites at build time. Elegant inside a bundler, but those files
cannot run in plain `node file.js` - the build toolchain is always in the path,
for dev, for tests, for the local UI. keel is ordinary ctx.step() method calls:
no transform, zero runtime dependencies, runs anywhere Node runs. The whole
engine, dashboard included, reads a JSON file or SQLite db you own - nothing to
build and no queue backend to stand up. Testing is an in-memory store plus a
mock provider: crash/resume is a milliseconds-fast unit test with no infra.

If you are already on Vercel and want durable workflows wired into that platform
and the AI SDK, use theirs - it is the better fit there. If you want durable
execution in plain TypeScript with no build step and no infrastructure, that is
the gap keel fills. Full side-by-side is in docs/COMPARISON.md.
```

---

## r/LocalLLaMA

**Title:**

```
I built a crash-proof, fully-local durable runtime for AI agents (no API key, no server, local dashboard)
```

**Body:**

```
If your agent crashes mid-run, you do not want it to repeat the LLM calls it
already made on restart. keel records each model call and each tool call as a
durable step; on resume it replays the stored result instead of calling the
model again. There is a durable-agent example that crashes mid-tool-call and
resumes without re-calling the model.

It runs entirely local: Ollama as the default provider (no API key, no account),
a single-JSON-file or SQLite store, and `npx keel dashboard` to watch runs on
localhost. Zero runtime dependencies, TypeScript, Node 20+.

Link in the comments. Would love feedback from people running local agents on
what breaks in long multi-step runs.
```

---

## r/node

**Title:**

```
keel v1: durable execution (crash-proof workflows) in dependency-free TypeScript, no build step
```

**Body:**

```
Workflows that resume where they left off after a crash. You write named steps;
each completed step's result is persisted, and a resume replays those steps
instead of re-running them. It is at-least-once with idempotency keys (the steps
that already finished are never redone), not magic exactly-once.

Unlike Vercel's Workflow SDK there is no build-time transform - ctx.step() is a
plain method call that runs in plain Node. Stores go from an in-memory map to one
JSON file to a SQLite store with lease-based multi-worker claiming. There is a
zero-config localhost dashboard and a CLI. Zero runtime deps, fully typed,
Node 20+ (SQLite store needs Node 22.5+ with a flag, or Node 24+).

Runnable crash/resume demo, a comparison table, and benchmarks in the README.
Curious what folks here think of the step API.
```

---

## r/typescript

**Title:**

```
A fully-typed durable execution engine, zero deps, no build step
```

**Body:**

```
keel runs TypeScript workflows as durable, named steps that survive a process
crash and resume from a local store. The whole public surface is typed end to
end - workflow input/output, step results, providers - and there is no build-time
transform, so it runs in plain Node.

  const research = defineWorkflow<{ topic: string }, string>('research',
    async (ctx, input) => {
      const plan = await ctx.llm('plan', { prompt: `Questions about ${input.topic}` });
      const out  = await ctx.llm('summary', { prompt: `Brief on ${input.topic}: ${plan.text}` });
      return out.text;
    });

Zero runtime dependencies, Node 20+. Link in comments - feedback on the type
design especially welcome.
```

---

## X / LinkedIn thread (4 posts)

```
1/ Your AI agent calls an LLM, charges a card, then the process dies.
On restart it does all of it again. That is the durable execution problem.

2/ Temporal, Inngest, and now Vercel Workflow fix it - but they need a server, a
control plane, a database, or a build-time compiler transform. I wanted the core
idea with none of that.

3/ So I built keel: durable execution in dependency-free TypeScript, no build
step. Workflows are named steps. Completed steps persist and replay on resume.
Died at step 7? Resume at step 7. And `npx keel dashboard` shows every run on
localhost - no cloud, no account.

4/ Scales from a single JSON file to a SQLite-backed multi-worker pool. Durable
timers, signals, durable agents, zero-infra testing. Open source, MIT, runs on
your laptop. Repo + crash/resume demo + comparison vs Vercel: <link>
```
