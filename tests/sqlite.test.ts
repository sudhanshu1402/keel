import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keel, defineWorkflow, runCli } from '../src/index.js';
import { SqliteStore } from '../src/store/sqlite.js';

// node:sqlite needs Node 22.5+ with --experimental-sqlite, or Node 24+. When it
// is not loadable this whole suite is skipped so the core stays Node 20+ green.
const require = createRequire(import.meta.url);
let sqliteAvailable = true;
try {
  require('node:sqlite');
} catch {
  sqliteAvailable = false;
}

const instant = async (): Promise<void> => {};

describe.skipIf(!sqliteAvailable)('SqliteStore', () => {
  it('round-trips runs, steps, and signals', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-sqlite-'));
    const store = new SqliteStore(join(dir, 'db.sqlite'));
    try {
      await store.createRun({
        id: 'r1',
        workflowName: 'w',
        status: 'running',
        input: { x: 1 },
        version: 0,
        createdAt: 1,
        updatedAt: 1,
      });
      await store.saveStep({
        runId: 'r1',
        name: 'b',
        index: 1,
        status: 'completed',
        attempts: 1,
        result: { ok: true },
        startedAt: 1,
      });
      await store.saveStep({
        runId: 'r1',
        name: 'a',
        index: 0,
        status: 'completed',
        attempts: 2,
        result: 42,
        startedAt: 1,
      });

      expect((await store.getRun('r1'))?.input).toEqual({ x: 1 });
      expect((await store.getStep('r1', 'a'))?.result).toBe(42);
      expect((await store.getStep('r1', 'b'))?.result).toEqual({ ok: true });
      // listSteps is ordered by recorded index.
      expect((await store.listSteps('r1')).map((s) => s.name)).toEqual(['a', 'b']);

      await store.saveSignal({
        runId: 'r1',
        name: 'go',
        value: 'now',
        createdAt: 2,
      });
      expect((await store.getSignal('r1', 'go'))?.value).toBe('now');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists across a simulated process restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-sqlite-'));
    const file = join(dir, 'db.sqlite');
    try {
      const s1 = new SqliteStore(file);
      await s1.createRun({
        id: 'r1',
        workflowName: 'w',
        status: 'paused',
        input: {},
        version: 0,
        createdAt: 1,
        updatedAt: 1,
      });
      await s1.saveStep({
        runId: 'r1',
        name: 'nap',
        index: 0,
        status: 'pending',
        attempts: 0,
        wakeAt: 5000,
        startedAt: 1,
      });
      s1.close();

      const s2 = new SqliteStore(file);
      expect((await s2.getRun('r1'))?.status).toBe('paused');
      expect((await s2.getReadySteps(6000)).map((r) => r.name)).toEqual(['nap']);
      expect((await s2.getReadySteps(4000)).length).toBe(0);
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces lease claims and compare-and-set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-sqlite-'));
    const store = new SqliteStore(join(dir, 'db.sqlite'));
    try {
      await store.createRun({
        id: 'r1',
        workflowName: 'w',
        status: 'queued',
        input: {},
        version: 0,
        createdAt: 0,
        updatedAt: 0,
      });
      expect(await store.claimRun('r1', 'w1', 1000, 1000)).toBe(true);
      expect(await store.claimRun('r1', 'w2', 1000, 1500)).toBe(false);
      expect(await store.claimRun('r1', 'w2', 1000, 2001)).toBe(true);

      const v = (await store.getRun('r1'))?.version ?? 0;
      expect(await store.updateRunCAS('r1', { status: 'completed' }, v)).toBe(true);
      expect(await store.updateRunCAS('r1', { status: 'failed' }, v)).toBe(false);
      expect((await store.getRun('r1'))?.status).toBe('completed');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // updateRun writes only the columns in its patch. It used to round-trip the
  // whole row (getRun, spread, write every column back), which left a window for
  // a claimRun from ANOTHER PROCESS to be reverted between the read and the
  // write. That interleaving cannot be staged from one process - node:sqlite is
  // synchronous, so nothing runs between the read and the write here - so this
  // test pins the column-scoping behaviour, not the cross-process race.
  it('updateRun patches only its own columns and leaves the lease intact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-sqlite-'));
    const store = new SqliteStore(join(dir, 'db.sqlite'));
    try {
      await store.createRun({
        id: 'r1',
        workflowName: 'w',
        status: 'queued',
        input: {},
        version: 0,
        createdAt: 0,
        updatedAt: 0,
      });

      expect(await store.claimRun('r1', 'w1', 1000, 1000)).toBe(true);
      // A patch that knows nothing about the lease must not undo it.
      await store.updateRun('r1', { status: 'running', updatedAt: 1100 });

      const after = await store.getRun('r1');
      expect(after?.status).toBe('running');
      expect(after?.leaseOwner).toBe('w1');
      expect(after?.leaseExpiresAt).toBe(2000);
      // createRun 0, claimRun 1, this updateRun 2: every write moves it.
      expect(after?.version).toBe(2);
      // The lease still holds, so nobody else can claim the run.
      expect(await store.claimRun('r1', 'w2', 1000, 1200)).toBe(false);

      await expect(store.updateRun('missing', { status: 'failed' })).rejects.toThrow(
        /not found/,
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drives crash recovery through the engine', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-sqlite-'));
    const file = join(dir, 'db.sqlite');
    let charges = 0;
    let crash = true;
    const makeWf = () =>
      defineWorkflow('charge', async (ctx) => {
        const c = await ctx.step('charge', () => {
          charges += 1;
          return 100;
        });
        if (crash) throw new Error('boom');
        return ctx.step('ship', () => ({ shipped: true, amount: c }));
      });
    try {
      const store1 = new SqliteStore(file);
      const keel1 = new Keel({ store: store1, sleepFn: instant });
      const r1 = await keel1.run(makeWf(), {});
      expect(r1.status).toBe('failed');
      expect(charges).toBe(1);
      store1.close();

      crash = false;
      const store2 = new SqliteStore(file);
      const keel2 = new Keel({ store: store2, sleepFn: instant });
      keel2.register(makeWf());
      const r2 = await keel2.resume(r1.runId);
      expect(r2.status).toBe('completed');
      expect(charges).toBe(1);
      expect(r2.output).toEqual({ shipped: true, amount: 100 });
      store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // runCli used to open a SqliteStore and never close it, so every in-process
  // call leaked a handle and left the WAL un-checkpointed. sqlite removes the
  // -wal sidecar when the last connection closes, so its absence is the proof.
  it('runCli closes the sqlite store it opened', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-cli-sqlite-'));
    const file = join(dir, 'db.sqlite');
    try {
      const seed = new SqliteStore(file);
      await seed.createRun({
        id: 'r1',
        workflowName: 'w',
        status: 'paused',
        input: {},
        version: 0,
        createdAt: 1,
        updatedAt: 1,
      });
      seed.close();

      const out: string[] = [];
      const code = await runCli(['resume', 'r1', '--db', file], {
        out: (s) => out.push(s),
        err: (s) => out.push(s),
      });
      expect(code).toBe(0);
      expect(existsSync(`${file}-wal`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
