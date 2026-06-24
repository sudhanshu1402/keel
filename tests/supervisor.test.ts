import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Keel,
  FileStore,
  MemoryStore,
  Supervisor,
  defineWorkflow,
} from '../src/index.js';

describe('durable timers and the supervisor', () => {
  it('suspends at a durable sleep and the supervisor wakes it when due', async () => {
    let clock = 1000;
    const now = (): number => clock;
    const store = new MemoryStore();
    const keel = new Keel({ store, now, durableTimers: true });

    let beforeRuns = 0;
    let afterRuns = 0;
    const wf = defineWorkflow('delayed', async (ctx) => {
      await ctx.step('before', () => {
        beforeRuns += 1;
        return 'b';
      });
      await ctx.sleep('nap', 5000);
      return ctx.step('after', () => {
        afterRuns += 1;
        return 'a';
      });
    });

    const r1 = await keel.run(wf, {});
    expect(r1.status).toBe('paused');
    expect(beforeRuns).toBe(1);

    const sup = new Supervisor(keel, store, { now });

    // Timer not due yet: nothing is woken.
    expect(await sup.tick()).toBe(0);
    expect((await store.getRun(r1.runId))?.status).toBe('paused');

    // Advance past the wake time: the supervisor resumes the run to completion.
    clock = 7000;
    expect(await sup.tick()).toBe(1);
    const run = await store.getRun(r1.runId);
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe('a');
    expect(beforeRuns).toBe(1); // memoized, not re-run
    expect(afterRuns).toBe(1);
  });

  it('a durable sleep survives a process exit (fresh engine + same file)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-sup-'));
    const file = join(dir, 'db.json');
    let clock = 1000;
    const now = (): number => clock;

    let charges = 0;
    const makeWf = () =>
      defineWorkflow('charge-then-wait', async (ctx) => {
        await ctx.step('charge', () => {
          charges += 1;
          return 100;
        });
        await ctx.sleep('cooldown', 10_000);
        return ctx.step('ship', () => 'shipped');
      });

    try {
      // Process 1: charges, then suspends on the durable sleep.
      const store1 = new FileStore(file);
      const keel1 = new Keel({ store: store1, now, durableTimers: true });
      const r1 = await keel1.run(makeWf(), {});
      expect(r1.status).toBe('paused');
      expect(charges).toBe(1);

      // Process 2: brand-new engine + store reading the same file, clock past
      // the wake time. A supervisor picks the suspended run back up.
      clock = 20_000;
      const store2 = new FileStore(file);
      const keel2 = new Keel({ store: store2, now, durableTimers: true });
      keel2.register(makeWf());
      const sup = new Supervisor(keel2, store2, { now });

      expect(await sup.tick()).toBe(1);
      const run = await store2.getRun(r1.runId);
      expect(run?.status).toBe('completed');
      expect(run?.output).toBe('shipped');
      expect(charges).toBe(1); // the charge was not repeated across the restart
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
