/**
 * keel micro-benchmarks. Not a competitive claim, just honest local numbers so
 * the docs can cite something real. Run on your own machine:
 *
 *   npx tsx bench/throughput.ts
 *
 * Measures four things on this hardware:
 *   1. step throughput      - steps committed per second (MemoryStore, FileStore)
 *   2. run throughput       - independent runs completed per second
 *   3. replay ceiling       - in-memory resume cost with no I/O (an upper bound,
 *                             NOT a real crash-recovery number)
 *   4. crash-restart recovery - resume against a freshly reopened durable store,
 *                             i.e. the real "process died, restart, finish" path
 */
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { Keel, MemoryStore, FileStore, defineWorkflow } from '../src/index.js';
import type { Store } from '../src/index.js';

const instant = async (): Promise<void> => {};

function sqliteAvailable(): boolean {
  try {
    createRequire(import.meta.url)('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

function hrMs(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

async function stepThroughput(label: string, store: Store, steps: number): Promise<void> {
  const keel = new Keel({ store, sleepFn: instant });
  const wf = defineWorkflow<{ n: number }, number>('bench-steps', async (ctx, input) => {
    let acc = 0;
    for (let i = 0; i < input.n; i++) {
      acc = await ctx.step(`s${i}`, () => acc + 1);
    }
    return acc;
  });
  const t0 = hrMs();
  const r = await keel.run(wf, { n: steps });
  const dt = hrMs() - t0;
  if (r.output !== steps) throw new Error('bench sanity failed');
  console.log(
    `  ${label.padEnd(22)} ${fmt(steps)} steps in ${dt.toFixed(1)}ms  ->  ${fmt(steps / (dt / 1000))} steps/sec`,
  );
}

async function runThroughput(label: string, store: MemoryStore, runs: number, stepsPer: number): Promise<void> {
  const keel = new Keel({ store, sleepFn: instant });
  const wf = defineWorkflow<unknown, number>('bench-run', async (ctx) => {
    for (let i = 0; i < stepsPer; i++) await ctx.step(`s${i}`, () => i);
    return stepsPer;
  });
  const t0 = hrMs();
  for (let i = 0; i < runs; i++) await keel.run(wf, {});
  const dt = hrMs() - t0;
  console.log(
    `  ${label.padEnd(22)} ${fmt(runs)} runs x ${stepsPer} steps in ${dt.toFixed(0)}ms  ->  ${fmt(runs / (dt / 1000))} runs/sec`,
  );
}

function recoverWorkflow(steps: number, crashRef: { crash: boolean }) {
  return defineWorkflow<unknown, number>('bench-recover', async (ctx) => {
    let acc = 0;
    for (let i = 0; i < steps; i++) acc = await ctx.step(`s${i}`, () => acc + 1);
    if (crashRef.crash) throw new Error('crash before finish');
    return acc;
  });
}

/**
 * Pure in-memory replay cost: same store instance, no reopen, no disk read.
 * This is an upper bound on how fast resume can fast-forward a history, not a
 * real recovery time -- nothing was actually recovered from durable storage.
 */
async function replayCeiling(steps: number): Promise<void> {
  const ref = { crash: true };
  const wf = recoverWorkflow(steps, ref);
  const keel = new Keel({ store: new MemoryStore(), sleepFn: instant });
  const r1 = await keel.run(wf, {});
  if (r1.status !== 'failed') throw new Error('expected failure');
  ref.crash = false;
  const t0 = hrMs();
  const r2 = await keel.resume(r1.runId);
  const dt = hrMs() - t0;
  if (r2.status !== 'completed') throw new Error('expected completion');
  console.log(
    `  ${`MemoryStore ${fmt(steps)} steps`.padEnd(28)} replayed in ${dt.toFixed(1)}ms  ->  ${fmt(steps / (dt / 1000))} steps/sec`,
  );
}

/**
 * Real crash-restart recovery: the first engine writes N committed steps to a
 * durable store and dies; a SECOND engine opens a FRESH store handle on the
 * same backing file/db and resumes. This reads the history back from storage,
 * which is what actually happens after a process restart.
 */
async function recoveryTime(
  label: string,
  open: () => Store,
  steps: number,
): Promise<void> {
  const ref = { crash: true };
  const wf = recoverWorkflow(steps, ref);

  const store1 = open();
  const keel1 = new Keel({ store: store1, sleepFn: instant });
  const r1 = await keel1.run(wf, {});
  if (r1.status !== 'failed') throw new Error('expected failure');
  maybeClose(store1);

  ref.crash = false;
  const store2 = open();
  const keel2 = new Keel({ store: store2, sleepFn: instant });
  keel2.register(wf);
  const t0 = hrMs();
  const r2 = await keel2.resume(r1.runId);
  const dt = hrMs() - t0;
  if (r2.status !== 'completed') throw new Error(`expected completion, got ${r2.status}`);
  maybeClose(store2);
  console.log(
    `  ${`${label} ${fmt(steps)} steps`.padEnd(28)} recovered in ${dt.toFixed(1)}ms  ->  ${fmt(steps / (dt / 1000))} steps/sec`,
  );
}

function maybeClose(store: Store): void {
  const c = (store as { close?: () => void }).close;
  if (typeof c === 'function') c.call(store);
}

async function main(): Promise<void> {
  const file = 'keel-data/bench.json';
  rmSync(file, { force: true });

  console.log('\nkeel benchmarks (single process, Node ' + process.version + ')\n');

  console.log('step throughput:');
  await stepThroughput('MemoryStore', new MemoryStore(), 50_000);
  await stepThroughput('FileStore (rewrite/step)', new FileStore(file), 5_000);
  if (sqliteAvailable()) {
    const { SqliteStore } = await import('../src/store/sqlite.js');
    const dbFile = 'keel-data/bench.sqlite';
    rmSync(dbFile, { force: true });
    const store = new SqliteStore(dbFile);
    await stepThroughput('SqliteStore (WAL)', store, 20_000);
    store.close();
    rmSync(dbFile, { force: true });
  } else {
    console.log('  SqliteStore           (skipped; run with --experimental-sqlite)');
  }

  console.log('\nrun throughput:');
  await runThroughput('MemoryStore', new MemoryStore(), 10_000, 5);

  console.log('\nreplay ceiling (in-memory, no I/O -- upper bound, not recovery):');
  await replayCeiling(10_000);
  await replayCeiling(50_000);

  console.log('\ncrash-restart recovery (reopen durable store, read history back):');
  const recoverFile = 'keel-data/bench-recover.json';
  rmSync(recoverFile, { force: true });
  await recoveryTime('FileStore', () => new FileStore(recoverFile), 2_000);
  rmSync(recoverFile, { force: true });
  if (sqliteAvailable()) {
    const { SqliteStore } = await import('../src/store/sqlite.js');
    const recoverDb = 'keel-data/bench-recover.sqlite';
    rmSync(recoverDb, { force: true });
    await recoveryTime('SqliteStore', () => new SqliteStore(recoverDb), 20_000);
    rmSync(recoverDb, { force: true });
  }

  rmSync(file, { force: true });
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
