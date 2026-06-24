import { describe, it, expect } from 'vitest';
import {
  Keel,
  MemoryStore,
  Worker,
  Supervisor,
  defineWorkflow,
} from '../src/index.js';

const instant = async (): Promise<void> => {};
const at = (t: number) => (): number => t;

describe('lease renewal', () => {
  it('lets the same owner extend its lease and keeps others out until the extended expiry', async () => {
    const store = new MemoryStore();
    await store.createRun({
      id: 'r',
      workflowName: 'w',
      status: 'running',
      input: {},
      version: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    // w1 claims at 1000 with a 1000ms lease -> expires 2000.
    expect(await store.claimRun('r', 'w1', 1000, 1000)).toBe(true);
    // The heartbeat re-claims as the same owner at 1500 -> expiry pushed to 2500.
    expect(await store.claimRun('r', 'w1', 1000, 1500)).toBe(true);
    // At 2100 the ORIGINAL lease would have expired, but the renewal holds it.
    expect(await store.claimRun('r', 'w2', 1000, 2100)).toBe(false);
    // Only past the renewed expiry can another worker reclaim it.
    expect(await store.claimRun('r', 'w2', 1000, 2600)).toBe(true);
  });
});

describe('orphan reclaim end to end', () => {
  it('a second worker reclaims a run whose lease expired mid-execution and finishes it without re-running completed steps', async () => {
    const store = new MemoryStore();
    const keel = new Keel({ store, sleepFn: instant });
    let aRuns = 0;
    let bRuns = 0;
    const wf = defineWorkflow<unknown, string>('job', async (ctx) => {
      await ctx.step('a', () => {
        aRuns += 1;
        return 1;
      });
      await ctx.step('b', () => {
        bRuns += 1;
        return 2;
      });
      return 'done';
    });
    keel.register(wf);

    // Simulate a worker that claimed 'r1', completed step 'a', then crashed:
    // the run is left 'running' with an already-expired lease and 'a' persisted.
    await store.createRun({
      id: 'r1',
      workflowName: 'job',
      status: 'running',
      input: {},
      version: 1,
      leaseOwner: 'deadWorker',
      leaseExpiresAt: 500,
      createdAt: 0,
      updatedAt: 0,
    });
    await store.saveStep({
      runId: 'r1',
      name: 'a',
      index: 0,
      status: 'completed',
      attempts: 1,
      result: 1,
      startedAt: 0,
      finishedAt: 0,
    });

    // A live worker polls well after the dead worker's lease expired.
    const w = new Worker(keel, store, { workerId: 'live', now: at(1000) });
    const executed = await w.tick();

    expect(executed).toBe(1);
    expect(aRuns).toBe(0); // step 'a' was memoized, not re-run by the new owner
    expect(bRuns).toBe(1); // step 'b' ran exactly once
    const run = await store.getRun('r1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe('done');
  });
});

describe('two workers racing the same run', () => {
  it('executes a single queued run exactly once when both workers target it', async () => {
    const store = new MemoryStore();
    let n = 0;
    const keel = new Keel({
      store,
      sleepFn: instant,
      idFactory: () => `run_${++n}`,
    });
    let execs = 0;
    const wf = defineWorkflow<unknown, string>('solo', async (ctx) =>
      ctx.step('do', () => {
        execs += 1;
        return 'k';
      }),
    );
    const runId = await keel.enqueue(wf, {});

    const w1 = new Worker(keel, store, { workerId: 'w1', now: at(1000) });
    const w2 = new Worker(keel, store, { workerId: 'w2', now: at(1000) });
    const [a, b] = await Promise.all([w1.tick(), w2.tick()]);

    // Exactly one worker won the claim and ran the run.
    expect(a + b).toBe(1);
    expect(execs).toBe(1);
    expect((await store.getRun(runId))?.status).toBe('completed');
  });
});

describe('worker + durable timer', () => {
  it('claims and resumes a run whose durable timer is due', async () => {
    let clock = 1000;
    const now = (): number => clock;
    const store = new MemoryStore();
    const keel = new Keel({ store, now, durableTimers: true });
    let afterRuns = 0;
    const wf = defineWorkflow<unknown, string>('napper', async (ctx) => {
      await ctx.step('before', () => 'b');
      await ctx.sleep('nap', 5000);
      return ctx.step('after', () => {
        afterRuns += 1;
        return 'woke';
      });
    });
    const runId = await keel.enqueue(wf, {});

    // First tick at 1000 starts the run; it suspends on the durable sleep.
    const w = new Worker(keel, store, { workerId: 'w1', now });
    expect(await w.tick()).toBe(1);
    expect((await store.getRun(runId))?.status).toBe('paused');
    expect(afterRuns).toBe(0);

    // Advance past the wake time; the next tick finds the ready timer and finishes.
    clock = 7000;
    expect(await w.tick()).toBe(1);
    const run = await store.getRun(runId);
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe('woke');
    expect(afterRuns).toBe(1);
  });
});

describe('two supervisors over one store', () => {
  it('wake a due timer exactly once when both poll concurrently', async () => {
    let clock = 1000;
    const now = (): number => clock;
    const store = new MemoryStore();
    const keel = new Keel({ store, now, durableTimers: true });
    let afterRuns = 0;
    const wf = defineWorkflow<unknown, string>('shared', async (ctx) => {
      await ctx.sleep('nap', 5000);
      return ctx.step('after', () => {
        afterRuns += 1;
        return 'a';
      });
    });
    const r = await keel.run(wf, {});
    expect(r.status).toBe('paused');

    const sup1 = new Supervisor(keel, store, { workerId: 's1', now });
    const sup2 = new Supervisor(keel, store, { workerId: 's2', now });

    clock = 7000;
    const [a, b] = await Promise.all([sup1.tick(), sup2.tick()]);

    // The lease guard means only one supervisor actually resumed the run.
    expect(a + b).toBe(1);
    expect(afterRuns).toBe(1);
    expect((await store.getRun(r.runId))?.status).toBe('completed');
  });
});
