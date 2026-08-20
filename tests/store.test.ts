import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, FileStore } from '../src/index.js';

describe('MemoryStore', () => {
  it('round-trips runs and steps', async () => {
    const s = new MemoryStore();
    await s.createRun({
      id: 'r1',
      workflowName: 'w',
      status: 'running',
      input: {},
      createdAt: 1,
      updatedAt: 1,
    });
    await s.saveStep({
      runId: 'r1',
      name: 'a',
      status: 'completed',
      attempts: 1,
      result: 42,
      startedAt: 1,
    });
    expect((await s.getStep('r1', 'a'))?.result).toBe(42);
    expect((await s.listSteps('r1')).length).toBe(1);
    await s.updateRun('r1', { status: 'completed' });
    expect((await s.getRun('r1'))?.status).toBe('completed');
  });

  // updateRun left version untouched, so a CAS holding a version read before
  // that update still succeeded and overwrote it.
  it('bumps version on updateRun so a stale CAS loses', async () => {
    const s = new MemoryStore();
    await s.createRun({
      id: 'r1',
      workflowName: 'w',
      status: 'queued',
      input: {},
      version: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    const stale = (await s.getRun('r1'))?.version ?? 0;
    await s.updateRun('r1', { status: 'running' });
    expect((await s.getRun('r1'))?.version).toBe(stale + 1);
    expect(await s.updateRunCAS('r1', { status: 'cancelled' }, stale)).toBe(false);
    expect((await s.getRun('r1'))?.status).toBe('running');
  });

  it('isolates stored records from later mutation', async () => {
    const s = new MemoryStore();
    const run = {
      id: 'r2',
      workflowName: 'w',
      status: 'running' as const,
      input: { n: 1 },
      createdAt: 1,
      updatedAt: 1,
    };
    await s.createRun(run);
    run.status = 'failed';
    expect((await s.getRun('r2'))?.status).toBe('running');
  });
});

describe('FileStore', () => {
  it('persists across a simulated restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-'));
    const file = join(dir, 'db.json');
    try {
      const s1 = new FileStore(file);
      await s1.createRun({
        id: 'r1',
        workflowName: 'w',
        status: 'running',
        input: { x: 1 },
        createdAt: 1,
        updatedAt: 1,
      });
      await s1.saveStep({
        runId: 'r1',
        name: 'a',
        status: 'completed',
        attempts: 1,
        result: 'kept',
        startedAt: 1,
      });

      // A fresh instance reading the same file simulates a process restart.
      const s2 = new FileStore(file);
      expect((await s2.getRun('r1'))?.status).toBe('running');
      expect((await s2.getStep('r1', 'a'))?.result).toBe('kept');
      expect((await s2.listSteps('r1')).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
