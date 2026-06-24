import { describe, it, expect } from 'vitest';
import {
  Keel,
  MemoryStore,
  defineWorkflow,
  CancelledError,
  TimeoutError,
  WorkflowVersionError,
} from '../src/index.js';

const instant = async (): Promise<void> => {};
const realDelay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe('cancellation', () => {
  it('cancels a paused run and refuses to resume it', async () => {
    const store = new MemoryStore();
    const keel = new Keel({ store });
    let afterSignal = 0;
    const wf = defineWorkflow<unknown, number>('cancellable', async (ctx) => {
      await ctx.waitForSignal('go');
      afterSignal += 1;
      return afterSignal;
    });
    const r = await keel.run(wf, {});
    expect(r.status).toBe('paused');

    expect(await keel.cancel(r.runId)).toBe(true);
    expect((await store.getRun(r.runId))?.status).toBe('cancelled');

    // Delivering the signal must not revive a cancelled run.
    await keel.sendSignal(r.runId, 'go', 1);
    expect((await store.getRun(r.runId))?.status).toBe('cancelled');

    // An explicit resume returns the terminal state without running the body.
    const resumed = await keel.resume(r.runId);
    expect(resumed.status).toBe('cancelled');
    expect(afterSignal).toBe(0);
  });

  it('returns false when cancelling an already-completed run', async () => {
    const keel = new Keel({ sleepFn: instant });
    const wf = defineWorkflow('quick', async (ctx) => ctx.step('s', () => 1));
    const r = await keel.run(wf, {});
    expect(r.status).toBe('completed');
    expect(await keel.cancel(r.runId)).toBe(false);
  });

  it('stops an in-flight run at the next step boundary', async () => {
    const store = new MemoryStore();
    const keel = new Keel({ store, sleepFn: instant });
    let secondStep = 0;
    const wf = defineWorkflow('coop', async (ctx) => {
      await ctx.step('first', async () => {
        // Cancel arrives while the first step is running.
        await keel.cancel(ctx.runId);
        return 1;
      });
      await ctx.step('second', () => {
        secondStep += 1;
        return 2;
      });
      return secondStep;
    });
    const r = await keel.run(wf, {});
    expect(r.status).toBe('cancelled');
    expect(secondStep).toBe(0);
  });
});

describe('step timeout', () => {
  it('fails a step that exceeds its timeout', async () => {
    const keel = new Keel({ sleepFn: instant });
    const wf = defineWorkflow('slow', async (ctx) =>
      ctx.step(
        'hang',
        async () => {
          await realDelay(50);
          return 'late';
        },
        { timeoutMs: 5, retry: { maxAttempts: 1 } },
      ),
    );
    const r = await keel.run(wf, {});
    expect(r.status).toBe('failed');
    expect(r.error).toContain('timed out');
  });

  it('lets a fast step finish within its timeout', async () => {
    const keel = new Keel({ sleepFn: instant });
    const wf = defineWorkflow<unknown, string>('fast', async (ctx) =>
      ctx.step('quick', async () => 'ok', { timeoutMs: 100 }),
    );
    const r = await keel.run(wf, {});
    expect(r.status).toBe('completed');
    expect(r.output).toBe('ok');
  });

  it('exposes TimeoutError as a named error type', () => {
    const e = new TimeoutError('s', 10);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('TimeoutError');
  });
});

describe('workflow versioning', () => {
  it('pegs the version on the run and replays it at the same version', async () => {
    const store = new MemoryStore();
    const keel = new Keel({ store, sleepFn: instant });
    const wf = defineWorkflow<unknown, string>(
      'versioned',
      async (ctx) => {
        await ctx.waitForSignal('go');
        return ctx.step('done', () => 'v2-result');
      },
      { version: 2 },
    );
    const r = await keel.run(wf, {});
    expect(r.status).toBe('paused');
    expect((await store.getRun(r.runId))?.workflowVersion).toBe(2);

    const resumed = await keel.sendSignal(r.runId, 'go', 1);
    expect(resumed?.status).toBe('completed');
    expect(resumed?.output).toBe('v2-result');
  });

  it('refuses to resume a run whose workflow version changed', async () => {
    const store = new MemoryStore();
    const wf2 = defineWorkflow<unknown, string>(
      'evolving',
      async (ctx) => {
        await ctx.waitForSignal('go');
        return 'old';
      },
      { version: 2 },
    );
    const keel1 = new Keel({ store, sleepFn: instant });
    const r = await keel1.run(wf2, {});
    expect(r.status).toBe('paused');

    // A new process registers v3 of the same workflow.
    const wf3 = defineWorkflow<unknown, string>(
      'evolving',
      async (ctx) => {
        await ctx.waitForSignal('go');
        return 'new';
      },
      { version: 3 },
    );
    const keel2 = new Keel({ store, sleepFn: instant });
    keel2.register(wf3);
    await expect(keel2.resume(r.runId)).rejects.toBeInstanceOf(
      WorkflowVersionError,
    );
  });
});
