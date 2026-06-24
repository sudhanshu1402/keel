import { describe, it, expect } from 'vitest';
import { Keel, MemoryStore, defineWorkflow } from '../src/index.js';

const instant = async (): Promise<void> => {};

describe('ctx.all', () => {
  it('runs siblings concurrently and returns results in input order', async () => {
    const keel = new Keel({ sleepFn: instant });
    const order: string[] = [];
    const wf = defineWorkflow<unknown, string[]>('fanout', async (ctx) =>
      ctx.all('fetch', [
        async () => {
          await new Promise((r) => setTimeout(r, 20));
          order.push('a');
          return 'a';
        },
        () => {
          order.push('b');
          return 'b';
        },
      ]),
    );
    const r = await keel.run(wf, {});
    expect(r.status).toBe('completed');
    // Results follow input order even though 'b' settled first.
    expect(r.output).toEqual(['a', 'b']);
    expect(order).toEqual(['b', 'a']);
  });

  it('records each child as its own memoized step and never re-runs on resume', async () => {
    const store = new MemoryStore();
    const keel = new Keel({ store, sleepFn: instant });
    let runs = 0;
    const wf = defineWorkflow<unknown, number[]>('fanout2', async (ctx) => {
      const out = await ctx.all('work', [
        () => {
          runs += 1;
          return 1;
        },
        () => {
          runs += 1;
          return 2;
        },
      ]);
      await ctx.waitForSignal('go');
      return out;
    });

    const r = await keel.run(wf, {});
    expect(r.status).toBe('paused');
    expect(runs).toBe(2);
    const steps = (await store.listSteps(r.runId)).map((s) => s.name).sort();
    expect(steps).toContain('work#0');
    expect(steps).toContain('work#1');

    const resumed = await keel.sendSignal(r.runId, 'go', 1);
    expect(resumed?.status).toBe('completed');
    expect(resumed?.output).toEqual([1, 2]);
    // The two children replayed from the store; their fns did not run again.
    expect(runs).toBe(2);
  });
});

describe('durable now / random / uuid', () => {
  // Each helper records its value once and replays it on resume. Proven by
  // pausing the run, resuming it, and asserting the value did not change even
  // though the underlying source (an incrementing clock, Math.random,
  // randomUUID) would produce a different value if it were recomputed.
  it('ctx.now replays the recorded instant instead of reading the clock again', async () => {
    const store = new MemoryStore();
    let tick = 1000;
    const keel = new Keel({ store, sleepFn: instant, now: () => tick++ });
    const wf = defineWorkflow<unknown, number>('clock', async (ctx) => {
      const t = await ctx.now('t');
      await ctx.waitForSignal('go');
      return t;
    });
    const r = await keel.run(wf, {});
    expect(r.status).toBe('paused');
    const recorded = (await store.getStep(r.runId, 't'))?.result as number;
    const resumed = await keel.sendSignal(r.runId, 'go', 1);
    expect(resumed?.output).toBe(recorded);
  });

  it('ctx.random and ctx.uuid stay stable across a resume', async () => {
    const store = new MemoryStore();
    const keel = new Keel({ store, sleepFn: instant });
    const wf = defineWorkflow<unknown, { r: number; id: string }>(
      'rng',
      async (ctx) => {
        const rnd = await ctx.random('r');
        const id = await ctx.uuid('id');
        await ctx.waitForSignal('go');
        return { r: rnd, id };
      },
    );
    const r = await keel.run(wf, {});
    expect(r.status).toBe('paused');
    const rRec = (await store.getStep(r.runId, 'r'))?.result as number;
    const idRec = (await store.getStep(r.runId, 'id'))?.result as string;
    expect(typeof idRec).toBe('string');
    expect(idRec.length).toBeGreaterThan(0);
    const resumed = await keel.sendSignal(r.runId, 'go', 1);
    expect(resumed?.output).toEqual({ r: rRec, id: idRec });
  });
});

describe('idempotency key', () => {
  it('defaults to runId:stepName and is surfaced to the step fn', async () => {
    const store = new MemoryStore();
    const keel = new Keel({ store, sleepFn: instant });
    let seen = '';
    const wf = defineWorkflow<unknown, string>('idem', async (ctx) =>
      ctx.step('charge', (h) => {
        seen = h.idempotencyKey;
        return 'ok';
      }),
    );
    const r = await keel.run(wf, {});
    expect(seen).toBe(`${r.runId}:charge`);
  });

  it('uses a caller-supplied idempotency key verbatim', async () => {
    const keel = new Keel({ sleepFn: instant });
    let seen = '';
    const wf = defineWorkflow<unknown, string>('idem2', async (ctx) =>
      ctx.step(
        'charge',
        (h) => {
          seen = h.idempotencyKey;
          return 'ok';
        },
        { idempotencyKey: 'order-42' },
      ),
    );
    await keel.run(wf, {});
    expect(seen).toBe('order-42');
  });
});
