import { describe, it, expect } from 'vitest';
import { Keel, MemoryStore, Worker, defineWorkflow } from '../src/index.js';

const instant = async (): Promise<void> => {};
// Flush pending microtasks + timers by yielding a macrotask.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

let idc = 0;
const idFactory = (): string => `run_${++idc}`;

// ---------------------------------------------------------------------------
// Regression 1: two overlapping executions of the SAME run must not both clear
// the "already completed?" memo before either persists it, or a step's side
// effect runs twice. sendSignal() and Worker/Supervisor all call resume(), so
// any two overlapping resumes could double-charge. The per-run execution mutex
// serializes them within the process.
// ---------------------------------------------------------------------------
describe('concurrent resume does not double-execute a step side effect', () => {
  it('runs a charge once when two resume passes overlap', async () => {
    const store = new MemoryStore();
    const keel = new Keel({ store, sleepFn: instant, idFactory });
    let charges = 0;

    const wf = defineWorkflow<unknown, string>('pay', async (ctx) => {
      await ctx.step('charge', async () => {
        charges += 1;
        await flush(); // real external-call latency
        return { amount: 100 };
      });
      return 'done';
    });
    keel.register(wf);
    const id = await keel.enqueue(wf, {});

    await Promise.all([keel.resume(id), keel.resume(id)]);

    expect(charges).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Regression 2 (multi-worker path): a worker whose lease expires mid-step is
// reclaimed by a second worker sharing the same engine. The engine must not run
// the same not-yet-saved step twice.
// ---------------------------------------------------------------------------
describe('lease reclaim under a shared engine does not double-charge', () => {
  it('charges once when worker B reclaims while worker A is still in the step', async () => {
    const clock = { t: 1000 };
    const now = (): number => clock.t;
    const store = new MemoryStore();
    const keel = new Keel({ store, sleepFn: instant, now, idFactory });

    let charges = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const wf = defineWorkflow<unknown, string>('charge-slow', async (ctx) => {
      await ctx.step('charge', async () => {
        charges += 1;
        await gate;
        return { amount: 100 };
      });
      return 'done';
    });
    keel.register(wf);
    const id = await keel.enqueue(wf, {});

    const wOpts = { leaseMs: 1000, renewMs: 10_000_000, now };
    const wA = new Worker(keel, store, { workerId: 'A', ...wOpts });
    const wB = new Worker(keel, store, { workerId: 'B', ...wOpts });

    const pA = wA.tick();
    await flush();
    expect(charges).toBe(1);

    // Time passes past A's lease expiry; A is still inside the step.
    clock.t = 3000;

    const pB = wB.tick();
    await flush();

    release();
    await Promise.all([pA, pB]);

    expect(charges).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Regression 3: a stale/zombie execution pass that finishes after a new owner
// has already completed the run must not clobber the new owner's status+output.
// ---------------------------------------------------------------------------
describe('a zombie execution pass does not clobber terminal state', () => {
  it('does not overwrite a run already completed by another owner', async () => {
    const store = new MemoryStore();
    const keel = new Keel({ store, sleepFn: instant, idFactory });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const wf = defineWorkflow<unknown, string>('zombie', async (ctx) => {
      await ctx.step('gate', async () => {
        await gate;
        return 1;
      });
      return 'A-OUTPUT-STALE';
    });
    keel.register(wf);
    const id = await keel.enqueue(wf, {});

    const pA = keel.resume(id);
    await flush();

    // The run's rightful new owner finishes it correctly while A is parked.
    await store.updateRun(id, {
      status: 'completed',
      output: 'B-OUTPUT-CORRECT',
      updatedAt: 1,
    });
    expect((await store.getRun(id))?.output).toBe('B-OUTPUT-CORRECT');

    release();
    await pA;

    const run = await store.getRun(id);
    expect(run?.output).toBe('B-OUTPUT-CORRECT');
  });
});

// ---------------------------------------------------------------------------
// Regression 4: a step returning a non-JSON-safe value (Date/Map/bigint/class
// instance) can never be recorded completed, so it must be poisoned rather than
// re-running its side effect on every resume forever.
// ---------------------------------------------------------------------------
describe('a non-JSON-safe step result is poisoned, not re-run on resume', () => {
  it('never re-charges once the step result fails to persist', async () => {
    const store = new MemoryStore();
    const keel = new Keel({ store, sleepFn: instant, idFactory });
    let charges = 0;

    const wf = defineWorkflow<unknown, unknown>('bad-return', async (ctx) =>
      ctx.step(
        'charge',
        () => {
          charges += 1;
          return new Date(); // valid JS value, not JSON-safe for keel's store
        },
        { retry: { maxAttempts: 1 } },
      ),
    );
    keel.register(wf);

    const r1 = await keel.run(wf, {});
    expect(r1.status).toBe('failed');
    expect(charges).toBe(1);

    // Operator retries: the step is poisoned, so it must not re-charge.
    const r2 = await keel.resume(r1.runId);
    expect(r2.status).toBe('failed');
    expect(charges).toBe(1);

    // And it never heals into a repeat charge on further resumes.
    await keel.resume(r1.runId);
    expect(charges).toBe(1);
  });
});
