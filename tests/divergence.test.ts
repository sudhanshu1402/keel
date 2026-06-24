import { describe, it, expect } from 'vitest';
import {
  Keel,
  MemoryStore,
  DivergenceError,
  defineWorkflow,
} from '../src/index.js';

const instant = async (): Promise<void> => {};

describe('replay divergence guard', () => {
  it('throws when a resumed workflow reorders its steps', async () => {
    const store = new MemoryStore();
    const keel = new Keel({ store, sleepFn: instant });

    // First version: step "a" runs, then the run crashes before "b".
    const v1 = defineWorkflow('drift', async (ctx) => {
      await ctx.step('a', () => 1);
      throw new Error('crash before b');
    });
    const r1 = await keel.run(v1, {});
    expect(r1.status).toBe('failed');

    // Second version registered under the same name swaps the step order.
    const v2 = defineWorkflow('drift', async (ctx) => {
      await ctx.step('b', () => 2);
      await ctx.step('a', () => 1);
      return 'done';
    });
    keel.register(v2);

    await expect(keel.resume(r1.runId)).rejects.toThrow(DivergenceError);
  });

  it('throws when a step is renamed under a live run', async () => {
    const store = new MemoryStore();
    const keel = new Keel({ store, sleepFn: instant });

    const v1 = defineWorkflow('rename', async (ctx) => {
      await ctx.step('charge', () => 'ok');
      throw new Error('crash');
    });
    const r1 = await keel.run(v1, {});
    expect(r1.status).toBe('failed');

    const v2 = defineWorkflow('rename', async (ctx) => {
      await ctx.step('charge-card', () => 'ok');
      return 'done';
    });
    keel.register(v2);

    await expect(keel.resume(r1.runId)).rejects.toThrow(/expected "charge"/);
  });

  it('does not flag an unchanged workflow on resume', async () => {
    const store = new MemoryStore();
    const keel = new Keel({ store, sleepFn: instant });
    let crash = true;

    const wf = defineWorkflow('stable', async (ctx) => {
      const a = await ctx.step('a', () => 1);
      if (crash) throw new Error('crash');
      const b = await ctx.step('b', () => a + 1);
      return b;
    });

    const r1 = await keel.run(wf, {});
    expect(r1.status).toBe('failed');
    crash = false;
    const r2 = await keel.resume(r1.runId);
    expect(r2.status).toBe('completed');
    expect(r2.output).toBe(2);
  });
});
