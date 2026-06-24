# Limitations

keel is small on purpose. Honesty about what it does not do is part of the
pitch. Read this before betting something important on it.

## Target deployment: one long-lived process (or a few)

keel is designed for a long-running Node process, or a small set of workers
sharing one store. It is not a managed cluster and does not pretend to be. For a
single app, an internal tool, a local agent, or a self-hosted backend, that is
the right shape. For an org-wide execution platform spanning many teams and
machines, use Temporal or a hosted product.

## FileStore rewrites the whole file on every write

`FileStore` persists the entire run database as one JSON file and rewrites it on
every step commit. That makes it dead simple, diffable, and zero-dependency, but
the write cost grows with the file size, and each commit is fsynced for
durability. For one workflow with thousands of steps, or thousands of runs
accumulating in one file, writes get slower over time. The benchmark shows
roughly 90 step-commits per second on a long single run, versus about 13,000 per
second for SQLite (see [BENCHMARKS.md](BENCHMARKS.md)).

**Guidance:** `FileStore` is great for development, small workloads, and
anything you want to read by opening a file. The moment you have real volume or
long-lived runs, switch to `SqliteStore`. It is a one-line change and the
durability contract is identical.

## SqliteStore needs Node 22.5+ and a flag (or Node 24+)

`SqliteStore` is built on the built-in `node:sqlite` module so it stays
zero-dependency. That module requires Node 22.5+ run with the
`--experimental-sqlite` flag, or Node 24+ where it is enabled by default. The
core engine and `FileStore` run on Node 20+. If you are on Node 20, you have the
in-memory and file stores; SQLite is opt-in on a newer runtime. Importing
`@sudhanshu1402/keel/sqlite` on a runtime without `node:sqlite` throws a clear
error telling you exactly which Node version and flag to use.

## Cancellation is cooperative

`keel.cancel(runId)` marks a run cancelled. The cancellation takes effect at the
next durable boundary: keel checks the cancelled flag at the start of each
`step`, `sleep`, `waitForSignal`, and `llm` call and throws `CancelledError`
there. It does not interrupt code running inside a step. If you are in the
middle of a long synchronous computation or a network call with no timeout, that
call finishes before cancellation is observed. Use `StepOptions.timeoutMs` to
bound a step that might hang.

## Determinism is your responsibility

Durable replay only works if your workflow body is deterministic. The same run,
replayed, must hit the same `ctx.step` / `ctx.sleep` / `ctx.llm` calls in the
same order with the same names. keel guards against the obvious failure with a
divergence check (reordered or renamed steps throw `DivergenceError`), and
`defineWorkflow(name, handler, { version })` lets you peg a run to the code
version that started it. But keel cannot stop you from branching on
`Date.now()`, `Math.random()`, or unmemoized I/O inside the workflow body. Put
nondeterministic work inside `ctx.step` so its result is recorded, and keep the
orchestration around the steps pure.

## No edge or short-lived serverless runtime

keel assumes a process that stays alive long enough to run a workflow, or one
that can be resumed by a supervisor or worker. Edge runtimes and very
short-lived serverless invocations are out of scope. You can persist to a store
from a serverless function and resume later from a worker, but keel does not ship
an edge-native execution model. This is a deliberate trade, not a TODO.

## Parallel steps yes, child workflows no

`ctx.all(name, [fn, ...])` runs sibling steps concurrently within one run, with
deterministic replay. What keel does **not** have is first-class child workflows:
spawning a separate run from inside a workflow and awaiting it as a unit, with
its own durable identity and independent ret/resume. You can approximate it by
calling `keel.run` or `keel.enqueue` from inside a `ctx.step` (the child's id is
then recorded as that step's result and survives replay), but there is no
built-in parent/child tree, no automatic cancellation propagation, and no
fan-out/fan-in across many child runs. If your design needs a deep tree of
independently-durable sub-workflows, that is a Temporal-shaped problem.

## No built-in scheduler or cron

keel runs a workflow when you call `keel.run` or `keel.enqueue`. It does not have
a cron syntax or a recurring-schedule engine. Drive recurring work from whatever
you already use (an OS cron job, a queue, a `setInterval` in your process) and
call keel to start each occurrence. Durable `ctx.sleep` handles delays *within* a
run once it has started; it is not a substitute for a scheduler that starts runs.

## Observability is a hook, not a backend

`new Keel({ onEvent })` emits a `step:start` / `step:complete` / `step:fail`
event for every step, which is enough to create OpenTelemetry spans, increment
metrics, or log. But keel ships no exporter, no metrics backend, and no trace
collector: wiring those is your code. The queryable history is just the `Store`
API (`listRuns`, `listSteps`, `getRun`) and the local dashboard built on it;
there is no rich query language, no search index, and no retention policy. For
fleet-wide dashboards and alerting, export the events to your own stack.

## Signals and timers are polled

The supervisor wakes sleeping runs and the worker picks up runnable runs by
polling the store on an interval. That is simple and robust, but it means wakeups
are accurate to the poll interval, not to the millisecond. For human-in-the-loop
flows and minute-or-longer timers this is invisible; if you need sub-100ms timer
precision, keel is not the right tool.

## What this all means

keel trades operational scale and managed infrastructure for radical
simplicity: zero dependencies, no account, no build step, runs on your laptop.
Within its target shape it is genuinely durable and crash-proof. Outside it, the
hosted engines exist for a reason. Pick accordingly. See
[COMPARISON.md](COMPARISON.md) for the side-by-side.
