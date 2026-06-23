import { describe, it, expect } from 'vitest';
import { Keel, MemoryStore, defineWorkflow } from '../src/index.js';

const instant = async (): Promise<void> => {};

describe('step memoization', () => {
  it('runs a step once and replays its result on a second execution', async () => {
    let counter = 0;
    const wf = defineWorkflow('memo', async (ctx) => {
      return ctx.step('inc', () => {
        counter += 1;
        return counter;
      });
    });

    const store = new MemoryStore();
    const keel = new Keel({ store, sleepFn: instant });

    const r1 = await keel.run(wf, {});
    expect(r1.status).toBe('completed');
    expect(r1.output).toBe(1);
    expect(counter).toBe(1);

    const r2 = await keel.resume(r1.runId);
    expect(r2.output).toBe(1);
    expect(counter).toBe(1); // replayed, not re-executed
  });

  it('persists the step result in the store', async () => {
    const wf = defineWorkflow('persist', async (ctx) => {
      await ctx.step('a', () => 'first');
      await ctx.step('b', () => 'second');
      return 'done';
    });
    const store = new MemoryStore();
    const keel = new Keel({ store, sleepFn: instant });
    const r = await keel.run(wf, {});
    const steps = await store.listSteps(r.runId);
    expect(steps.map((s) => s.name).sort()).toEqual(['a', 'b']);
    expect(steps.every((s) => s.status === 'completed')).toBe(true);
  });
});

describe('durable sleep', () => {
  it('does not re-sleep once a sleep step has completed', async () => {
    let sleeps = 0;
    const wf = defineWorkflow('nap', async (ctx) => {
      await ctx.sleep('wait', 1000);
      return 'awake';
    });
    const store = new MemoryStore();
    const keel = new Keel({
      store,
      sleepFn: async () => {
        sleeps += 1;
      },
    });
    const r1 = await keel.run(wf, {});
    expect(r1.output).toBe('awake');
    expect(sleeps).toBe(1);
    await keel.resume(r1.runId);
    expect(sleeps).toBe(1); // already elapsed, not slept again
  });
});
