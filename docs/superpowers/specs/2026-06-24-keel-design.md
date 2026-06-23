# keel - design spec

Date: 2026-06-24
Status: approved (build authorized)
Working name: keel (renameable via one find/replace)

## One line

Durable execution for TypeScript AI agents. Write a workflow as a plain async
function; keel makes it crash-proof: every completed step is persisted and never
re-run on restart, with retries, durable sleep, and human-in-the-loop pauses,
plus a local dashboard that shows every run, step, token, and cost.

## Why this project

Dual goal: strongest possible recruiter signal for backend and platform roles,
plus genuine open-source star potential. keel hits both because it IS the
author's existing work (distributed-queue-engine, llm-assessment-pipeline,
otel-sdk-node) composed into one coherent system. The AI angle and local-first
developer experience earn the stars; the distributed-systems mechanics earn the
interviews.

## Hard constraints (non-negotiable)

- Zero money. No paid hosting, no paid LLM keys, no managed infra.
- No accounts or logins required to build, run, or demo.
- Local-first. The runtime and dashboard run on the developer's machine.

How each is satisfied:

- LLM access defaults to Ollama (local, free, no key, no signup). OpenAI,
  Anthropic, and Gemini are optional adapters behind env vars.
- Persistence defaults to an in-memory store for dev and a zero-dependency file
  store for durability across restarts. Redis and SQLite are optional adapters.
- The dashboard is a local web UI started with a CLI command and bound to
  localhost. Nothing is deployed. Demos are recorded locally as a GIF.
- Docs ship on GitHub Pages (free). The package publishes to npm (free). CI runs
  on GitHub Actions (free for public repos).

## Users and use cases

Primary user: a TypeScript developer building an LLM agent or multi-step AI
pipeline who needs it to survive crashes, retries, and long waits without
rebuilding queue and state plumbing by hand.

Representative use cases:

1. A research agent that calls a model several times, each call an expensive
   step that must not repeat if the process restarts.
2. A multi-step pipeline (extract, transform, validate, persist) where a failure
   in step 3 must resume from step 3, not step 1.
3. A workflow that pauses for human approval, then resumes hours later.

## Architecture

Single npm package for v1 (modules are folders, not separate packages - YAGNI).
Boundaries are interface-driven so adapters can be added without touching core.

- `core` (runtime, workflow, context, retry): the durable execution engine.
  Replays a workflow function, short-circuiting completed steps from the store.
  No knowledge of any specific store or provider.
- `store` (interface plus MemoryStore, FileStore): persistence of runs and step
  results. Interface lets Redis or SQLite adapters drop in later.
- `providers` (interface plus OllamaProvider, MockProvider): LLM access. Ollama
  is the zero-cost default; Mock is for tests.
- `dashboard` (v1.1): a local web UI that reads the store and renders runs, step
  timelines, token and cost totals, and a replay button. Separate from core.
- `sdk` (public exports in index.ts): the surface developers import.

### Data flow

defineWorkflow(name, handler) registers a handler. runtime.run(workflow, input)
creates a run record, then invokes the handler with a WorkflowContext. Each
ctx.step(name, fn) call:

1. Looks up a persisted result for (runId, stepName) in the store.
2. If found, returns it without executing fn (replay path).
3. If not found, executes fn with the retry policy, persists the result, returns
   it.

On crash and restart, runtime.resume(runId) re-invokes the same handler. Steps
that completed before the crash return instantly from the store; execution
proceeds from the first step without a persisted result. This is the standard
deterministic-replay model used by durable execution engines.

### Persistence model

- RunRecord: id, workflowName, status (running, completed, failed, paused),
  input, output, error, createdAt, updatedAt.
- StepRecord: runId, name, status, attempts, result, error, tokensIn, tokensOut,
  costUsd, startedAt, finishedAt.

Determinism contract: workflow logic outside ctx.step must be deterministic.
Side effects and nondeterminism (network, random, time, model calls) go inside
steps so their results are captured and replayed. Documented prominently.

### Retry

Per-step policy: maxAttempts, backoff (exponential with jitter), retryable
predicate. Reuses the backoff approach from distributed-queue-engine. Attempts
are recorded on the StepRecord.

### Durable sleep (v1)

ctx.sleep(name, ms) persists a wake-at timestamp as a step. On replay, if the
wake-at has passed, it returns immediately; otherwise the run yields and is
resumed by the scheduler when due. v1 supports single-process scheduling; a
distributed scheduler is a later milestone.

### Human-in-the-loop (v1.1)

ctx.waitForSignal(name) pauses the run (status paused) and persists the wait.
runtime.signal(runId, name, payload) resumes it. Enables approval gates.

## Testing strategy

Vitest. Core is tested with no network and no real model calls:

- Memoization: a step with a side-effect counter executes once; on replay it
  does not execute again and returns the persisted value.
- Crash recovery: a workflow that throws after step 1 is resumed; step 1 does not
  re-run; step 2 completes; final status is completed.
- Retry: a flaky step that fails N times then succeeds; assert attempt count and
  result, and that a step exceeding maxAttempts fails the run.
- Provider: MockProvider drives ctx.llm; assert token capture and that the llm
  step is memoized on replay.
- Store: FileStore persists across a fresh store instance (simulated restart).

CI runs typecheck, test, and build on Node 20 and 22. No secrets, no services.

## Scope

v1 (this milestone, the credible first release):
- defineWorkflow, runtime.run and runtime.resume, ctx.step with retry,
  ctx.sleep, ctx.llm.
- MemoryStore and FileStore.
- OllamaProvider and MockProvider.
- Full test suite, CI, README, two runnable examples (a plain workflow and an
  Ollama agent), MIT license.

v1.1:
- Local dashboard (CLI: keel studio) reading the store.
- Human-in-the-loop signals.

Later (explicitly deferred, YAGNI for launch):
- Redis and SQLite store adapters.
- OpenAI, Anthropic, Gemini provider adapters.
- Distributed scheduler and multi-worker execution.
- OpenTelemetry export (natural tie-in to otel-sdk-node).

## Surrounding program (tracked separately in PLAN.md and DISTRIBUTION.md)

1. keel flagship (this spec).
2. Spin-off micro-libs extracted from keel once stable.
3. Distribution and launch playbook (where stars actually come from).
4. Authentic activity cadence and upstream contributions.
5. Technical content driving repo traffic.
6. Profile betterment tying the narrative together.
