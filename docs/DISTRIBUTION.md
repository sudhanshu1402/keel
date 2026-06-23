# keel Distribution Playbook

How to take keel from a local repo to a starred, used project. Ordered by leverage. Do not launch publicly until the pre-launch checklist is fully green; a launch you only get once should land on a polished repo.

## The one-line pitch

> Durable execution for TypeScript AI agents. Crash-proof workflows that resume exactly where they left off. Zero cloud, zero cost, zero dependencies.

Every post, README, and comment leads with a variant of this. Anchor on the pain (agent crashes mid-run and repeats LLM calls / charges) and the unfair advantage (no server, no account, runs on a laptop with Ollama).

## Pre-launch checklist (must be 100% before any public post)

- [ ] CI green on Node 20 and 22 (badge live in README).
- [ ] `npm run typecheck`, `npm test`, `npm run build` all clean.
- [ ] README quickstart copy-pastes and works on a fresh clone.
- [ ] Both examples run: `npm run example:order` (crash/resume) and `npm run example:agent -- "topic" --mock`.
- [ ] A 20-30s terminal GIF of the crash/resume demo at the top of the README. This is the single highest-converting asset. Record the two `example:order` runs side by side so the viewer sees "charging..." then "crash" then resume WITHOUT a second charge. Use `asciinema` + `agg`, or `vhs` (charmbracelet) for a scripted, reproducible recording.
- [ ] Repo About description + homepage + topics set (`durable-execution`, `workflow-engine`, `ai-agents`, `llm`, `typescript`, `ollama`, `local-first`).
- [ ] LICENSE present (MIT). CONTRIBUTING.md with a one-command dev setup.
- [ ] Social preview image (1280x640) uploaded in repo Settings.
- [ ] npm package name secured. `keel` is likely taken; publish as a scope (`@sudhanshu1402/keel`) or pick a free name and keep the repo name as the brand. Verify with `npm view <name>` before announcing.
- [ ] Version tagged `v0.1.0`, GitHub Release created with notes.

## Publish to npm

```bash
npm login
npm publish --access public   # required for a scoped package
```

Add the npm version + downloads badges to the README once live:

```
[![npm](https://img.shields.io/npm/v/@sudhanshu1402/keel.svg)](https://www.npmjs.com/package/@sudhanshu1402/keel)
[![downloads](https://img.shields.io/npm/dm/@sudhanshu1402/keel.svg)](https://www.npmjs.com/package/@sudhanshu1402/keel)
```

## Launch channels (in order)

Launch over one day, not one post. Stagger so you can answer comments live in each place.

1. **Show HN** (`Show HN: keel - durable execution for TypeScript AI agents, no server`). Best signal-to-star channel for infra/dev tools. Post Tue-Thu, ~8am ET. First comment from you: the "why" (Temporal/Inngest need a server; this is the core idea in a few hundred dependency-free lines) plus the GIF link. Reply to every comment for the first 4 hours.
2. **r/LocalLLaMA** — the zero-cost + Ollama angle is native to this audience. Lead with "runs entirely local, no API key, crash-proof agent runs."
3. **r/node** and **r/typescript** — lead with the DX and the typed step API. Code snippet first, link second.
4. **dev.to / Hashnode article** — "Why your AI agent shouldn't lose its work when it crashes (and how durable execution fixes it)." Teaches the concept, then shows keel as the minimal implementation. Cross-post to your own blog.
5. **X/Twitter + LinkedIn thread** — the GIF + 4-tweet thread: problem, the naive failure, the fix, the repo. LinkedIn version doubles as recruiter signal.
6. **Lobsters** (`programming`, `javascript` tags) — smaller but high-quality infra audience.

## Awesome-list PRs (compounding, evergreen discovery)

Open one focused PR each, with a one-line entry that matches the list's format:

- `awesome-ai-agents`
- `awesome-llm` / `awesome-llmops`
- `awesome-nodejs` (workflow/job-queue section)
- `awesome-typescript`
- `awesome-workflow-engines` / durable-execution lists

Each merged entry is a permanent backlink and a steady trickle of qualified traffic.

## Content flywheel (weeks 2-6, keeps stars compounding after launch)

- Comparison page in docs: keel vs Temporal vs Inngest vs DBOS — honest table (keel wins on zero-setup/local/cost; loses on scale/distributed — say so). Honesty earns trust and ranks for the comparison searches people actually run.
- A second example that hits a nerve: a durable multi-step agent that calls a tool, sleeps, and resumes after a restart mid-tool-call.
- Short blog post per shipped feature (dashboard, HITL signals, Redis adapter). Each is a fresh reason to re-share.
- Answer Stack Overflow / Reddit / Discord questions about "agent crashed and repeated work" with a genuine solution that mentions keel where it fits. Never spam.

## Roadmap that earns the next wave of stars

Ship these in order; each is a launchable update:

1. **Localhost run dashboard** — `keel dashboard` opens a local page showing runs, steps, status, tokens, and a replay button. Visual, demo-able, screenshot-friendly. Highest star-per-effort after v1.
2. **Human-in-the-loop signals** — `ctx.waitForSignal(name)` pauses durably until an external `keel.signal(runId, name, payload)`. Unlocks approval workflows, a top agent use case.
3. **SQLite store adapter** — still zero-config and local, but durable and queryable. Natural upgrade from the JSON file store.
4. **Redis store adapter** — the multi-process / horizontal story for people who outgrow local.
5. **OpenTelemetry export** — ties into the existing otel-sdk-node project; cross-promote both.

## Metrics to watch

- GitHub stars and the referrer breakdown (Insights -> Traffic) to learn which channel converts.
- npm weekly downloads.
- Issues opened by real users (not you) and time-to-first-response. Fast responses are the cheapest retention lever a young project has.

## Guardrails

- Never overstate. keel is single-process durable execution today, not a distributed scheduler. Say that plainly; it builds more trust than hype and pre-empts the top HN critique.
- No fabricated benchmarks or fake testimonials.
- Respond to criticism with code or a roadmap item, not defensiveness.
