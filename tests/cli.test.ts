import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keel, FileStore, defineWorkflow, runCli } from '../src/index.js';
import type { CliIO } from '../src/index.js';

function capture(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err };
}

const instant = async (): Promise<void> => {};

async function seed(file: string): Promise<{ done: string; paused: string }> {
  const store = new FileStore(file);
  const keel = new Keel({ store, sleepFn: instant });
  const done = await keel.run(
    defineWorkflow('done-wf', async (ctx) => ctx.step('s', () => 1)),
    {},
  );
  const paused = await keel.run(
    defineWorkflow<unknown, string>('wait-wf', async (ctx) =>
      ctx.waitForSignal<string>('go'),
    ),
    {},
  );
  return { done: done.runId, paused: paused.runId };
}

describe('runCli', () => {
  it('lists and inspects runs from a store file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-cli-'));
    const file = join(dir, 'keel.json');
    try {
      const { done } = await seed(file);

      const runs = capture();
      expect(await runCli(['runs', '--store', file], runs.io)).toBe(0);
      expect(runs.out.join('\n')).toContain(done);
      expect(runs.out.join('\n')).toContain('completed');

      const inspect = capture();
      expect(await runCli(['inspect', done, '--store', file], inspect.io)).toBe(0);
      expect(inspect.out.join('\n')).toContain('[completed] s');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requeues a paused run via resume', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-cli-'));
    const file = join(dir, 'keel.json');
    try {
      const { paused } = await seed(file);

      const r = capture();
      expect(await runCli(['resume', paused, '--store', file], r.io)).toBe(0);
      expect(r.out.join('\n')).toContain('requeued');
      expect((await new FileStore(file).getRun(paused))?.status).toBe('queued');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores a signal and requeues a paused run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-cli-'));
    const file = join(dir, 'keel.json');
    try {
      const { paused } = await seed(file);

      const r = capture();
      expect(
        await runCli(['signal', paused, 'go', '"ship"', '--store', file], r.io),
      ).toBe(0);
      const store = new FileStore(file);
      expect((await store.getSignal(paused, 'go'))?.value).toBe('ship');
      expect((await store.getRun(paused))?.status).toBe('queued');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancels a paused run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-cli-'));
    const file = join(dir, 'keel.json');
    try {
      const { paused, done } = await seed(file);

      const r = capture();
      expect(await runCli(['cancel', paused, '--store', file], r.io)).toBe(0);
      expect(r.out.join('\n')).toContain('cancelled');
      expect((await new FileStore(file).getRun(paused))?.status).toBe('cancelled');

      // A finished run cannot be cancelled.
      const r2 = capture();
      expect(await runCli(['cancel', done, '--store', file], r2.io)).toBe(1);
      expect(r2.err.join('\n')).toContain('already');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a clear error for an unknown run and unknown command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-cli-'));
    const file = join(dir, 'keel.json');
    try {
      await seed(file);

      const miss = capture();
      expect(await runCli(['inspect', 'nope', '--store', file], miss.io)).toBe(1);
      expect(miss.err.join('\n')).toContain('not found');

      const bad = capture();
      expect(await runCli(['frobnicate'], bad.io)).toBe(1);
      expect(bad.err.join('\n')).toContain('unknown command');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints usage for help and returns 0', async () => {
    const h = capture();
    expect(await runCli(['help'], h.io)).toBe(0);
    expect(h.out.join('\n')).toContain('durable execution control plane');
  });
});
