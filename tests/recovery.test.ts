import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keel, MemoryStore, FileStore, defineWorkflow } from '../src/index.js';

const instant = async (): Promise<void> => {};

describe('crash recovery', () => {
  it('does not re-run completed steps after a crash mid-workflow', async () => {
    let step1Runs = 0;
    let step2Runs = 0;
    let crash = true;

    const wf = defineWorkflow('recover', async (ctx) => {
      const a = await ctx.step('one', () => {
        step1Runs += 1;
        return 10;
      });
      if (crash) throw new Error('simulated crash after step one');
      const b = await ctx.step('two', () => {
        step2Runs += 1;
        return a + 5;
      });
      return b;
    });

    const store = new MemoryStore();
    const keel = new Keel({ store, sleepFn: instant });

    const r1 = await keel.run(wf, {});
    expect(r1.status).toBe('failed');
    expect(step1Runs).toBe(1);

    crash = false; // the bug that caused the crash is fixed; resume
    const r2 = await keel.resume(r1.runId);
    expect(r2.status).toBe('completed');
    expect(r2.output).toBe(15);
    expect(step1Runs).toBe(1); // step one replayed from the store
    expect(step2Runs).toBe(1);
  });

  it('recovers across a process restart using FileStore', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-recover-'));
    const file = join(dir, 'db.json');
    let charges = 0;
    let crash = true;

    const makeWorkflow = (shouldCrash: () => boolean) =>
      defineWorkflow('charge-and-ship', async (ctx) => {
        const charge = await ctx.step('charge', () => {
          charges += 1;
          return { ok: true, amount: 100 };
        });
        if (shouldCrash()) throw new Error('crash before shipping');
        const shipment = await ctx.step('ship', () => ({
          shipped: true,
          amount: charge.amount,
        }));
        return shipment;
      });

    try {
      // First process: charges, then crashes before shipping.
      const store1 = new FileStore(file);
      const keel1 = new Keel({ store: store1, sleepFn: instant });
      const wf1 = makeWorkflow(() => crash);
      const r1 = await keel1.run(wf1, {});
      expect(r1.status).toBe('failed');
      expect(charges).toBe(1);

      // Second process: fresh store + engine reading the same file.
      crash = false;
      const store2 = new FileStore(file);
      const keel2 = new Keel({ store: store2, sleepFn: instant });
      const wf2 = makeWorkflow(() => crash);
      keel2.register(wf2);
      const r2 = await keel2.resume(r1.runId);
      expect(r2.status).toBe('completed');
      expect(charges).toBe(1); // the charge was NOT repeated after restart
      expect(r2.output).toEqual({ shipped: true, amount: 100 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
