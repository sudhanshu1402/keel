# Launch copy (ready to paste)

Edit lightly to sound like you. Post Tue-Thu morning ET. Be present in the comments for the first 4 hours.

---

## Show HN

**Title** (HN strips emoji; keep it plain):

```
Show HN: Keel - durable execution for TypeScript AI agents, no server
```

**First comment (post immediately after submitting):**

```
I kept hitting the same problem building agents: the process dies halfway
through a run and on restart it repeats work it already did - re-calls the LLM,
re-charges the card, re-sends the email.

Temporal, Inngest, and DBOS solve this, but they want a server, a hosted control
plane, or a database. I wanted the core idea with none of that, so I wrote keel:
durable execution in a few hundred lines of dependency-free TypeScript.

You write a workflow as named steps. Each step runs once, its result is
persisted, and on a resume the completed steps replay from a local store instead
of running again. A run that died at step 7 picks up at step 7.

  const order = defineWorkflow('order', async (ctx, input) => {
    const charge = await ctx.step('charge', () => chargeCard(input.id));
    await ctx.step('reserve', () => reserveInventory(input.id));
    return ctx.step('ship', () => ship(input.id, charge));
  });

Default store is in-memory; the file store is a single JSON file, so there is no
database or broker to run. LLM steps go through a provider interface, and it
ships with an Ollama provider so you can run agents fully local with no API key.

It is single-process today, not a distributed scheduler - I am up front about
that. Next up is a localhost run dashboard and human-in-the-loop signals.

Repo and a runnable crash/resume demo in the README. Feedback welcome,
especially on the step API and what would make you actually use it.
```

---

## r/LocalLLaMA

**Title:**

```
I built a crash-proof, fully-local durable runtime for AI agents (no API key, no server)
```

**Body:**

```
If your agent crashes mid-run, you do not want it to repeat the LLM calls it
already made on restart. keel records each model call as a durable step; on
resume it replays the stored result instead of calling the model again.

It runs entirely local: Ollama as the default provider (no API key, no account),
and a single-JSON-file store, so there is nothing to host. Zero runtime
dependencies, TypeScript, Node 20+.

There is a two-step research-agent example you can run against Ollama, or with
--mock if you just want to see the durability without a model.

Link in the comments. Would love feedback from people running local agents on
what breaks in long multi-step runs.
```

---

## r/node

**Title:**

```
keel: durable execution (crash-proof workflows) in dependency-free TypeScript
```

**Body:**

```
Workflows that resume exactly where they left off after a crash. You write named
steps; each runs once, the result is persisted, and a resume replays completed
steps instead of re-running them. No double charges, no repeated side effects.

Default store is in-memory, file store is one JSON file with atomic writes - no
database or broker. Zero runtime deps, fully typed, Node 20+. There is a runnable
crash/resume demo in the README (charge a card, crash, resume, ship once).

It is single-process for now. Curious what folks here think of the step API and
where you would want a Redis/SQLite adapter.
```

---

## r/typescript

**Title:**

```
A fully-typed durable execution engine in a few hundred lines, zero deps
```

**Body:**

```
keel runs TypeScript workflows as durable, named steps that survive a process
crash and resume from a local store. The whole public surface is typed end to
end - workflow input/output, step results, providers.

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

2/ Temporal/Inngest/DBOS fix it - but they need a server, a control plane, or a
database. I wanted the core idea with none of that.

3/ So I built keel: durable execution in dependency-free TypeScript. Workflows
are named steps. Each runs once, persists, and replays on resume. Died at step
7? Resume at step 7. Default store is a single JSON file. LLMs via Ollama, local
and free.

4/ It is open source, MIT, runs on your laptop with zero setup. Repo + a
crash/resume demo GIF: <link>
```
