# keel vs Vercel Workflow, Temporal, and Inngest

Durable execution is a crowded space. This page is an honest map of where keel
fits and where it does not. The short version: keel wins on local developer
experience, no build step, and zero lock-in. It is deliberately "good enough"
on the operational features the hosted engines were built around.

If you need a managed control plane, multi-language workers, or org-scale
throughput today, use Temporal or a hosted product. If you want durable
execution that runs in plain Node, debugs on your laptop, and never asks for an
account, keel is built for that.

## At a glance

| | keel | Vercel Workflow | Temporal | Inngest |
|---|---|---|---|---|
| Runtime model | plain `ctx.step()` calls | `"use workflow"` / `"use step"` directives | SDK + workflow worker | SDK + event functions |
| Build step required | no | yes (SWC + bundler integration) | no | no |
| Runs in plain Node | yes | no (needs the bundler transform) | yes | yes |
| Local observability | `npx keel dashboard`, zero config | cloud dashboard | Temporal Web (run a server) | dev server / cloud |
| Account or login to start | no | Vercel account for the hosted side | none for OSS server | account for cloud |
| Runtime dependencies (core) | zero | bundler + runtime | server + client libs | server + client libs |
| Durable store | in-memory, JSON file, or SQLite | managed | Cassandra / Postgres / MySQL | managed / Postgres |
| Multi-worker | yes (lease + CAS) | managed | yes | managed |
| Human-in-the-loop signals | yes (`ctx.waitForSignal`) | yes | yes | yes (`waitForEvent`) |
| Testing infra needed | none (in-memory + mock provider) | bundler + their tooling | test server / time-skipping | dev server |
| Hosting model | your process, anywhere Node runs | Vercel platform | self-host or Temporal Cloud | self-host or Inngest Cloud |
| License | MIT | Apache-2.0 | MIT (server) | various |

## Where keel wins

**No build step.** Vercel's Workflow SDK is built on `"use workflow"` and
`"use step"` directives that an SWC transform rewrites at build time. That is
elegant inside their bundler and impossible outside it: you cannot run those
files in plain `node file.js`. keel is ordinary function calls. `ctx.step(name,
fn)` is a method call, not a compiler directive. It runs anywhere Node runs, in
a script, a server, a cron job, a test, with no transform in the path.

**Local observability.** keel ships a dashboard that is a zero-dependency
`node:http` server reading the same store your app writes to. `npx keel
dashboard` and you see every run, every step, token counts, errors, and Resume
and Send-signal buttons. The hosted engines put their observability in the
cloud; local development is comparatively a black box. A dashboard that runs on
your laptop against a local JSON file is structurally hard for a cloud-first
product to match.

**Zero lock-in.** One tier, MIT, no account, no usage pricing, no
cloud-exclusive features. The store is an interface; your run history is a JSON
file or a SQLite database you own. Move it, diff it, commit it, delete it. There
is no control plane to be cut off from.

**Trivial testing.** Durable workflows are notoriously annoying to test because
the usual answer is "stand up the infra." keel's in-memory store plus a mock
provider plus an injectable clock means a durable workflow test needs zero
infrastructure and runs deterministically in milliseconds. Crash-and-resume is a
unit test, not an integration suite.

## Where keel does not win (be honest)

- **Scale and operations.** Temporal is built for very large fleets with a
  managed cluster, sharding, and years of production hardening. keel targets a
  single long-lived Node process or a small set of workers against one store. Its
  SQLite store does more than ten thousand step-commits per second on a laptop
  (see [BENCHMARKS.md](BENCHMARKS.md)), which is plenty for most apps, but it is
  not an org-wide execution backbone.
- **Hosted control plane.** Vercel and the cloud products give you managed
  retries, alerting, metrics, and a team dashboard you do not operate. keel gives
  you a local dashboard and a CLI; anything hosted you run yourself.
- **Multi-language.** Temporal has SDKs for Go, Java, Python, TypeScript, and
  more. keel is TypeScript only.
- **Ecosystem depth.** Vercel's tie-in with the AI SDK and the broader platform
  is deeper than keel's example provider adapters.
- **Edge / serverless.** keel assumes a long-lived process. Edge and
  short-lived serverless runtimes are out of scope by design; see
  [LIMITATIONS.md](LIMITATIONS.md).

## When to pick which

- **Pick keel** when you want durable execution in plain TypeScript with no
  build step, local debugging, and no vendor relationship: side projects, local
  agents, internal tools, self-hosted backends, anything where "runs on my
  machine with no account" is a feature.
- **Pick Vercel Workflow** when you are already on Vercel and want durable
  workflows wired into that platform and the AI SDK.
- **Pick Temporal** when you need a battle-tested, multi-language, large-scale
  execution platform and can run or buy the cluster.
- **Pick Inngest** when you want an event-driven, hosted workflow product with a
  managed dashboard.

keel does not try to be those. It tries to be the durable engine you reach for
first because it is the one with nothing to set up.
