import { describe, it, expect } from 'vitest';
import {
  Keel,
  MemoryStore,
  defineWorkflow,
  DivergenceError,
} from '../src/index.js';

const instant = async (): Promise<void> => {};

describe('failed-step replay semantics', () => {
  // A run that failed because a step exhausted its retries is NOT auto-reclaimed
  // by workers (they skip terminal runs); only a deliberate keel.resume() re-runs
  // it. On that explicit retry the failed step re-runs, prior completed steps do
  // not, and the idempotency key is identical across the original attempt and the
  // retry so a downstream API can collapse a duplicate side effect.
  it('re-runs the failed step on resume but keeps completed steps memoized, with a stable idempotency key', async () => {
    const store = new MemoryStore();
    const keel = new Keel({ store, sleepFn: instant });
    let preRuns = 0;
    let chargeRuns = 0;
    const keys: string[] = [];
    let shouldFail = true;

    const wf = defineWorkflow<unknown, string>('retryable', async (ctx) => {
      await ctx.step('pre', () => {
        preRuns += 1;
        return 'ready';
      });
      await ctx.step(
        'charge',
        (h) => {
          chargeRuns += 1;
          keys.push(h.idempotencyKey);
          if (shouldFail) throw new Error('gateway down');
          return 'charged';
        },
        { retry: { maxAttempts: 1 } },
      );
      return 'shipped';
    });

    const r1 = await keel.run(wf, {});
    expect(r1.status).toBe('failed');
    expect(preRuns).toBe(1);
    expect(chargeRuns).toBe(1);

    // Operator fixes the gateway and explicitly retries.
    shouldFail = false;
    const r2 = await keel.resume(r1.runId);
    expect(r2.status).toBe('completed');
    expect(r2.output).toBe('shipped');

    expect(preRuns).toBe(1); // completed step replayed, not re-run
    expect(chargeRuns).toBe(2); // failed step re-ran on the explicit resume
    // Same key both times: a downstream idempotent API collapses the duplicate.
    expect(keys[0]).toBe(`${r1.runId}:charge`);
    expect(keys[1]).toBe(keys[0]);
  });
});

describe('at-least-once crash-before-persist window', () => {
  // The honest core guarantee: if the process dies after a step's side effect
  // runs but before its result is persisted, the step re-runs on resume. The
  // duplicate is collapsed by the stable idempotency key, not prevented.
  it('re-runs a step whose persist was interrupted, with the same idempotency key', async () => {
    class CrashOnPersistOnce extends MemoryStore {
      crashName: string | null = 'charge';
      override async saveStep(step: Parameters<MemoryStore['saveStep']>[0]) {
        if (step.status === 'completed' && step.name === this.crashName) {
          this.crashName = null; // crash exactly once, then heal
          throw new Error('power lost before fsync');
        }
        return super.saveStep(step);
      }
    }
    const store = new CrashOnPersistOnce();
    const keel = new Keel({ store, sleepFn: instant });
    let charges = 0;
    const keys: string[] = [];

    const wf = defineWorkflow<unknown, string>('charge-once', async (ctx) =>
      ctx.step(
        'charge',
        (h) => {
          charges += 1;
          keys.push(h.idempotencyKey);
          return 'ok';
        },
        { retry: { maxAttempts: 1 } },
      ),
    );

    const r1 = await keel.run(wf, {});
    // The side effect ran, but persisting it failed: the run is not completed.
    expect(r1.status).toBe('failed');
    expect(charges).toBe(1);

    const r2 = await keel.resume(r1.runId);
    expect(r2.status).toBe('completed');
    // At-least-once: the side effect ran a second time across the crash window.
    expect(charges).toBe(2);
    // Both attempts carried the same idempotency key, so a downstream dedupe works.
    expect(keys[0]).toBe(`${r1.runId}:charge`);
    expect(keys[1]).toBe(keys[0]);
  });
});

describe('divergence guard after several completed steps', () => {
  it('throws at the diverging position, not only at index 0', async () => {
    const store = new MemoryStore();
    const v1 = defineWorkflow('pipeline', async (ctx) => {
      await ctx.step('a', () => 1);
      await ctx.step('b', () => 2);
      await ctx.step('c', () => 3);
      await ctx.waitForSignal('go');
      return 'done';
    });
    const keel1 = new Keel({ store, sleepFn: instant });
    const r = await keel1.run(v1, {});
    expect(r.status).toBe('paused'); // a, b, c all completed at indices 0,1,2

    // A new process renames the third step. Indices 0 and 1 still match; the
    // divergence must be caught at position 2, not masked by the earlier matches.
    const v1diverged = defineWorkflow('pipeline', async (ctx) => {
      await ctx.step('a', () => 1);
      await ctx.step('b', () => 2);
      await ctx.step('c2', () => 3);
      await ctx.waitForSignal('go');
      return 'done';
    });
    const keel2 = new Keel({ store, sleepFn: instant });
    keel2.register(v1diverged);

    let caught: DivergenceError | undefined;
    try {
      await keel2.resume(r.runId);
    } catch (e) {
      if (e instanceof DivergenceError) caught = e;
    }
    expect(caught).toBeInstanceOf(DivergenceError);
    expect(caught?.index).toBe(2);
    expect(caught?.expected).toBe('c');
    expect(caught?.actual).toBe('c2');
  });
});
