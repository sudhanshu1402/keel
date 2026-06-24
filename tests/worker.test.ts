import { describe, it, expect } from 'vitest';
import { Keel, MemoryStore, Worker, defineWorkflow } from '../src/index.js';

const instant = async (): Promise<void> => {};
const at = (t: number) => (): number => t;

describe('ConcurrentStore claim semantics', () => {
  it('lets only one worker claim a run when two race', async () => {
    const store = new MemoryStore();
    await store.createRun({
      id: 'r1',
      workflowName: 'w',
      status: 'queued',
      input: {},
      version: 0,
      createdAt: 0,
      updatedAt: 0,
    });

    const [a, b] = await Promise.all([
      store.claimRun('r1', 'w1', 1000, 5000),
      store.claimRun('r1', 'w2', 1000, 5000),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
  });

  it('reclaims a run only after its lease expires', async () => {
    const store = new MemoryStore();
    await store.createRun({
      id: 'r2',
      workflowName: 'w',
      status: 'queued',
      input: {},
      version: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    expect(await store.claimRun('r2', 'w1', 1000, 1000)).toBe(true);
    // Before expiry, a different worker cannot take it.
    expect(await store.claimRun('r2', 'w2', 1000, 1500)).toBe(false);
    // After expiry (lease ended at 2000), it is reclaimable.
    expect(await store.claimRun('r2', 'w2', 1000, 2001)).toBe(true);
  });

  it('rejects a compare-and-set update against a stale version', async () => {
    const store = new MemoryStore();
    await store.createRun({
      id: 'r3',
      workflowName: 'w',
      status: 'queued',
      input: {},
      version: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    expect(await store.updateRunCAS('r3', { status: 'completed' }, 0)).toBe(true);
    // Version is now 1; an update expecting 0 must fail and not apply.
    expect(await store.updateRunCAS('r3', { status: 'failed' }, 0)).toBe(false);
    expect((await store.getRun('r3'))?.status).toBe('completed');
  });
});

describe('multi-worker execution', () => {
  it('fans out queued runs across workers with no double-execution', async () => {
    const store = new MemoryStore();
    let n = 0;
    const keel = new Keel({
      store,
      sleepFn: instant,
      idFactory: () => `run_${++n}`,
    });

    const execCount = new Map<string, number>();
    const wf = defineWorkflow<{ k: string }, string>('job', async (ctx, input) =>
      ctx.step('do', () => {
        execCount.set(input.k, (execCount.get(input.k) ?? 0) + 1);
        return input.k;
      }),
    );

    const runIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      runIds.push(await keel.enqueue(wf, { k: `k${i}` }));
    }

    const w1 = new Worker(keel, store, {
      workerId: 'w1',
      concurrency: 4,
      now: at(1000),
    });
    const w2 = new Worker(keel, store, {
      workerId: 'w2',
      concurrency: 4,
      now: at(1000),
    });

    const [a, b] = await Promise.all([w1.tick(), w2.tick()]);

    // Every run executed exactly once, total across both workers.
    expect(a + b).toBe(12);
    expect(execCount.size).toBe(12);
    for (const count of execCount.values()) expect(count).toBe(1);
    for (const id of runIds) {
      expect((await store.getRun(id))?.status).toBe('completed');
    }
  });
});
