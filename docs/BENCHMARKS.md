# Benchmarks

These are honest local numbers, not a competitive claim. They exist so the docs
can cite something real and so you know roughly where the performance cliffs are.
Run them yourself:

```bash
npm run bench
```

The script is [bench/throughput.ts](../bench/throughput.ts). It measures four
things: how fast steps commit, how fast independent runs complete, the in-memory
replay ceiling (an upper bound, not recovery), and real crash-restart recovery
against a reopened durable store.

## Environment

- Node v22.12.0 (single process)
- Apple Silicon laptop
- SQLite store in WAL mode with `synchronous = FULL`, via the built-in `node:sqlite`
- Numbers vary with hardware; treat them as orders of magnitude, not guarantees

## Step throughput

One workflow, one long run, committing N sequential durable steps. This is the
metric that exposes the FileStore write-amplification cliff.

| Store | Steps | Time | Throughput |
|---|---|---|---|
| MemoryStore | 50,000 | 191 ms | ~262,000 steps/sec |
| FileStore (rewrite + fsync per step) | 5,000 | 54,700 ms | ~91 steps/sec |
| SqliteStore (WAL) | 20,000 | 1,494 ms | ~13,400 steps/sec |

The takeaway is the gap. FileStore rewrites the entire JSON database and fsyncs
it on every commit, so a single long run pays an O(n) cost that compounds: the
5,000th step is far more expensive than the first, and the fsync makes each write
durable but slow. FileStore is for development and small workloads, where its
single-file simplicity is the point. For volume, use SqliteStore (here ~150x
faster) or keep it in memory. See [LIMITATIONS.md](LIMITATIONS.md).

MemoryStore deep-copies values in and out of the store (so a workflow mutating a
returned value cannot corrupt durable state, matching how the disk stores behave
after a JSON round-trip). That copy is why it lands at ~262k steps/sec rather
than higher; it is still far from the bottleneck.

## Run throughput

Many short, independent runs against the in-memory store, five steps each. Closer
to a "lots of small workflows" workload.

| Store | Workload | Time | Throughput |
|---|---|---|---|
| MemoryStore | 10,000 runs x 5 steps | 1,818 ms | ~5,500 runs/sec |

## Replay ceiling (in-memory, not recovery)

How fast `keel.resume` can fast-forward an already-completed step history when
the store is in memory and nothing is read from disk. This is an **upper bound**
on replay speed, not a recovery measurement: no process actually restarted and
nothing was read back from durable storage.

| Replayed steps | Time | Throughput |
|---|---|---|
| 10,000 | 34 ms | ~299,000 steps/sec |
| 50,000 | 176 ms | ~285,000 steps/sec |

## Crash-restart recovery (the real number)

This is the one that matters. A first engine writes N committed steps to a
durable store and "crashes" (the run fails mid-flight). A **second** engine then
opens a **fresh** handle on the same backing file/database and calls `resume` --
exactly what happens after a process restart. The timing covers reading the
history back from storage and fast-forwarding to the failure point.

| Store | Recovered steps | Time | Throughput |
|---|---|---|---|
| FileStore | 2,000 | 44 ms | ~46,000 steps/sec |
| SqliteStore | 20,000 | 434 ms | ~46,000 steps/sec |

Recovery is cheap: a run that crashed 20,000 steps deep into a SQLite-backed
history is back to its failure point in well under a second, then continues from
there. That is the whole promise of durable execution, measured against a store
that was actually reopened -- not an in-memory shortcut.

## How to read these numbers

- MemoryStore numbers are the engine's ceiling: no durability, just the cost of
  the memoization machinery plus a deep copy. They show the engine is not the
  bottleneck.
- FileStore numbers are the simple-durability floor: fully fsynced, single file,
  and slow under volume by design. Great for dev and small workloads.
- SqliteStore numbers are the durable workhorse: real on-disk durability at
  five-figure step rates with no degradation as history grows.
- The replay-ceiling and crash-restart-recovery sections measure different
  things on purpose. Recovery (reopen the store, read the history back) is the
  honest one; the in-memory ceiling just shows replay logic itself is not where
  the time goes.

Re-run `npm run bench` on your target hardware before making any decision that
depends on a specific number.
