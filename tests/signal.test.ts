import { describe, it, expect } from 'vitest';
import { Keel, MemoryStore, defineWorkflow } from '../src/index.js';

const instant = async (): Promise<void> => {};

describe('human-in-the-loop signals', () => {
  it('pauses at waitForSignal and resumes when the signal arrives', async () => {
    let amountRuns = 0;
    const wf = defineWorkflow('approval', async (ctx) => {
      const amount = await ctx.step('amount', () => {
        amountRuns += 1;
        return 500;
      });
      const decision = await ctx.waitForSignal<string>('approve');
      return `${decision}:${amount}`;
    });

    const store = new MemoryStore();
    const keel = new Keel({ store, sleepFn: instant });

    const r1 = await keel.run(wf, {});
    expect(r1.status).toBe('paused');
    expect(amountRuns).toBe(1);

    const r2 = await keel.sendSignal(r1.runId, 'approve', 'yes');
    expect(r2?.status).toBe('completed');
    expect(r2?.output).toBe('yes:500');
    // The step before the signal was not re-executed on resume.
    expect(amountRuns).toBe(1);
  });

  it('memoizes the delivered signal value on a later replay', async () => {
    const wf = defineWorkflow('approval2', async (ctx) => {
      const decision = await ctx.waitForSignal<string>('approve');
      return decision;
    });
    const store = new MemoryStore();
    const keel = new Keel({ store, sleepFn: instant });

    const r1 = await keel.run(wf, {});
    expect(r1.status).toBe('paused');

    await keel.sendSignal(r1.runId, 'approve', 'green');
    keel.register(wf);
    const again = await keel.resume(r1.runId);
    expect(again.status).toBe('completed');
    expect(again.output).toBe('green');
  });

  it('stores a signal sent to a run that is not waiting and returns undefined', async () => {
    const store = new MemoryStore();
    const keel = new Keel({ store, sleepFn: instant });
    const wf = defineWorkflow('done-already', async (ctx) => {
      return ctx.step('x', () => 1);
    });
    const r1 = await keel.run(wf, {});
    expect(r1.status).toBe('completed');

    const res = await keel.sendSignal(r1.runId, 'late', 'value');
    expect(res).toBeUndefined();
    expect((await store.getSignal(r1.runId, 'late'))?.value).toBe('value');
  });
});
