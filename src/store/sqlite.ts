import { createRequire } from 'node:module';
import { assertJsonSafe } from './serialize.js';
import type {
  ConcurrentStore,
  ReadyStep,
  RunRecord,
  SignalRecord,
  StepRecord,
} from './types.js';

const require = createRequire(import.meta.url);

// Minimal structural types for the node:sqlite surface we use, so this file
// type-checks on Node versions whose @types do not yet ship node:sqlite.
interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

function openDatabase(path: string): SqliteDatabase {
  let mod: { DatabaseSync: new (p: string) => SqliteDatabase };
  try {
    mod = require('node:sqlite') as typeof mod;
  } catch {
    throw new Error(
      'SqliteStore requires the built-in node:sqlite module. Run on Node 22.5+ ' +
        'with the --experimental-sqlite flag, or Node 24+. The core engine and ' +
        'MemoryStore/FileStore have no such requirement.',
    );
  }
  return new mod.DatabaseSync(path);
}

const toJson = (v: unknown): string | null =>
  v === undefined ? null : JSON.stringify(v);
const fromJson = (v: unknown): unknown =>
  v === null || v === undefined ? undefined : JSON.parse(v as string);

interface RunRow {
  id: string;
  workflowName: string;
  status: string;
  input: string | null;
  output: string | null;
  error: string | null;
  version: number;
  workflowVersion: number | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface StepRow {
  runId: string;
  name: string;
  status: string;
  attempts: number;
  result: string | null;
  error: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  wakeAt: number | null;
  idx: number | null;
  startedAt: number;
  finishedAt: number | null;
}

/**
 * SQLite-backed store using the built-in `node:sqlite` module (zero npm
 * dependencies). Durable across restarts like FileStore, but scales past a
 * single JSON file and supports concurrent workers via row-level lease claims
 * and compare-and-set updates. Opened in WAL mode with a busy timeout so
 * multiple processes can share one database file.
 *
 * Requires Node 22.5+ with `--experimental-sqlite`, or Node 24+. Exposed via
 * the optional `@sudhanshu1402/keel/sqlite` entry point so the core never
 * imports node:sqlite.
 */
export class SqliteStore implements ConcurrentStore {
  private readonly db: SqliteDatabase;

  constructor(path = 'keel.db') {
    this.db = openDatabase(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    // FULL fsyncs the WAL on every commit: a process crash or power loss never
    // loses an acknowledged durable write. Slower than NORMAL but correct;
    // durability is the whole point of the store.
    this.db.exec('PRAGMA synchronous = FULL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflowName TEXT NOT NULL,
        status TEXT NOT NULL,
        input TEXT,
        output TEXT,
        error TEXT,
        version INTEGER NOT NULL DEFAULT 0,
        workflowVersion INTEGER,
        leaseOwner TEXT,
        leaseExpiresAt INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS steps (
        runId TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        result TEXT,
        error TEXT,
        tokensIn INTEGER,
        tokensOut INTEGER,
        costUsd REAL,
        wakeAt INTEGER,
        idx INTEGER,
        startedAt INTEGER NOT NULL,
        finishedAt INTEGER,
        PRIMARY KEY (runId, name)
      );
      CREATE TABLE IF NOT EXISTS signals (
        runId TEXT NOT NULL,
        name TEXT NOT NULL,
        value TEXT,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY (runId, name)
      );
      CREATE INDEX IF NOT EXISTS idx_steps_wake ON steps (status, wakeAt);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status);
    `);
    this.migrate();
  }

  /** Add columns introduced after the initial schema to pre-existing files. */
  private migrate(): void {
    const cols = this.db
      .prepare('PRAGMA table_info(runs)')
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'workflowVersion')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN workflowVersion INTEGER');
    }
  }

  /**
   * Close the underlying database handle. Checkpoints the WAL back into the
   * main file first so the `-wal`/`-shm` sidecars do not hold un-merged data
   * after a clean shutdown.
   */
  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // Checkpoint is best-effort; closing still flushes the WAL.
    }
    this.db.close();
  }

  private rowToRun(r: RunRow): RunRecord {
    const run: RunRecord = {
      id: r.id,
      workflowName: r.workflowName,
      status: r.status as RunRecord['status'],
      input: fromJson(r.input),
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
    if (r.output !== null) run.output = fromJson(r.output);
    if (r.error !== null) run.error = r.error;
    if (r.workflowVersion !== null) run.workflowVersion = r.workflowVersion;
    if (r.leaseOwner !== null) run.leaseOwner = r.leaseOwner;
    if (r.leaseExpiresAt !== null) run.leaseExpiresAt = r.leaseExpiresAt;
    return run;
  }

  private rowToStep(r: StepRow): StepRecord {
    const step: StepRecord = {
      runId: r.runId,
      name: r.name,
      status: r.status as StepRecord['status'],
      attempts: r.attempts,
      startedAt: r.startedAt,
    };
    if (r.result !== null) step.result = fromJson(r.result);
    if (r.error !== null) step.error = r.error;
    if (r.tokensIn !== null) step.tokensIn = r.tokensIn;
    if (r.tokensOut !== null) step.tokensOut = r.tokensOut;
    if (r.costUsd !== null) step.costUsd = r.costUsd;
    if (r.wakeAt !== null) step.wakeAt = r.wakeAt;
    if (r.idx !== null) step.index = r.idx;
    if (r.finishedAt !== null) step.finishedAt = r.finishedAt;
    return step;
  }

  async createRun(run: RunRecord): Promise<void> {
    assertJsonSafe(run.input, `run ${run.id} input`);
    if (run.output !== undefined) assertJsonSafe(run.output, `run ${run.id} output`);
    this.db
      .prepare(
        `INSERT INTO runs (id, workflowName, status, input, output, error, version, workflowVersion, leaseOwner, leaseExpiresAt, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.workflowName,
        run.status,
        toJson(run.input),
        toJson(run.output),
        run.error ?? null,
        run.version ?? 0,
        run.workflowVersion ?? null,
        run.leaseOwner ?? null,
        run.leaseExpiresAt ?? null,
        run.createdAt,
        run.updatedAt,
      );
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      | RunRow
      | undefined;
    return row ? this.rowToRun(row) : undefined;
  }

  async updateRun(id: string, patch: Partial<RunRecord>): Promise<void> {
    const existing = await this.getRun(id);
    if (!existing) throw new Error(`run ${id} not found`);
    if (patch.output !== undefined) assertJsonSafe(patch.output, `run ${id} output`);
    const next = { ...existing, ...patch };
    this.writeRun(next);
  }

  private writeRun(run: RunRecord): void {
    this.db
      .prepare(
        `UPDATE runs SET workflowName=?, status=?, input=?, output=?, error=?, version=?, workflowVersion=?, leaseOwner=?, leaseExpiresAt=?, createdAt=?, updatedAt=? WHERE id=?`,
      )
      .run(
        run.workflowName,
        run.status,
        toJson(run.input),
        toJson(run.output),
        run.error ?? null,
        run.version ?? 0,
        run.workflowVersion ?? null,
        run.leaseOwner ?? null,
        run.leaseExpiresAt ?? null,
        run.createdAt,
        run.updatedAt,
        run.id,
      );
  }

  async getStep(runId: string, name: string): Promise<StepRecord | undefined> {
    const row = this.db
      .prepare('SELECT * FROM steps WHERE runId = ? AND name = ?')
      .get(runId, name) as StepRow | undefined;
    return row ? this.rowToStep(row) : undefined;
  }

  async saveStep(step: StepRecord): Promise<void> {
    if (step.result !== undefined) {
      assertJsonSafe(step.result, `step ${step.name} result`);
    }
    this.db
      .prepare(
        `INSERT INTO steps (runId, name, status, attempts, result, error, tokensIn, tokensOut, costUsd, wakeAt, idx, startedAt, finishedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(runId, name) DO UPDATE SET
           status=excluded.status, attempts=excluded.attempts, result=excluded.result,
           error=excluded.error, tokensIn=excluded.tokensIn, tokensOut=excluded.tokensOut,
           costUsd=excluded.costUsd, wakeAt=excluded.wakeAt, idx=excluded.idx,
           startedAt=excluded.startedAt, finishedAt=excluded.finishedAt`,
      )
      .run(
        step.runId,
        step.name,
        step.status,
        step.attempts,
        toJson(step.result),
        step.error ?? null,
        step.tokensIn ?? null,
        step.tokensOut ?? null,
        step.costUsd ?? null,
        step.wakeAt ?? null,
        step.index ?? null,
        step.startedAt,
        step.finishedAt ?? null,
      );
  }

  async listRuns(): Promise<RunRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM runs ORDER BY createdAt')
      .all() as RunRow[];
    return rows.map((r) => this.rowToRun(r));
  }

  async listSteps(runId: string): Promise<StepRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM steps WHERE runId = ? ORDER BY idx')
      .all(runId) as StepRow[];
    return rows.map((r) => this.rowToStep(r));
  }

  async getReadySteps(beforeMs: number): Promise<ReadyStep[]> {
    const rows = this.db
      .prepare(
        `SELECT runId, name, wakeAt FROM steps WHERE status = 'pending' AND wakeAt IS NOT NULL AND wakeAt <= ?`,
      )
      .all(beforeMs) as Array<{ runId: string; name: string; wakeAt: number }>;
    return rows.map((r) => ({ runId: r.runId, name: r.name, wakeAt: r.wakeAt }));
  }

  async saveSignal(signal: SignalRecord): Promise<void> {
    assertJsonSafe(signal.value, `signal ${signal.name} value`);
    this.db
      .prepare(
        `INSERT INTO signals (runId, name, value, createdAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(runId, name) DO UPDATE SET value=excluded.value, createdAt=excluded.createdAt`,
      )
      .run(signal.runId, signal.name, toJson(signal.value), signal.createdAt);
  }

  async getSignal(
    runId: string,
    name: string,
  ): Promise<SignalRecord | undefined> {
    const row = this.db
      .prepare('SELECT * FROM signals WHERE runId = ? AND name = ?')
      .get(runId, name) as
      | { runId: string; name: string; value: string | null; createdAt: number }
      | undefined;
    if (!row) return undefined;
    return {
      runId: row.runId,
      name: row.name,
      value: fromJson(row.value),
      createdAt: row.createdAt,
    };
  }

  async claimRun(
    runId: string,
    workerId: string,
    leaseMs: number,
    now: number,
  ): Promise<boolean> {
    const res = this.db
      .prepare(
        `UPDATE runs SET leaseOwner = ?, leaseExpiresAt = ?, version = version + 1, updatedAt = ?
         WHERE id = ? AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ? OR leaseOwner = ?)`,
      )
      .run(workerId, now + leaseMs, now, runId, now, workerId);
    return res.changes > 0;
  }

  async releaseClaim(runId: string, workerId: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE runs SET leaseOwner = NULL, leaseExpiresAt = NULL, version = version + 1 WHERE id = ? AND leaseOwner = ?`,
      )
      .run(runId, workerId);
  }

  async updateRunCAS(
    id: string,
    patch: Partial<RunRecord>,
    expectedVersion: number,
  ): Promise<boolean> {
    const existing = await this.getRun(id);
    if (!existing) return false;
    if (patch.output !== undefined) assertJsonSafe(patch.output, `run ${id} output`);
    const next: RunRecord = {
      ...existing,
      ...patch,
      version: expectedVersion + 1,
    };
    const res = this.db
      .prepare(
        `UPDATE runs SET workflowName=?, status=?, input=?, output=?, error=?, version=?, workflowVersion=?, leaseOwner=?, leaseExpiresAt=?, updatedAt=? WHERE id=? AND version=?`,
      )
      .run(
        next.workflowName,
        next.status,
        toJson(next.input),
        toJson(next.output),
        next.error ?? null,
        next.version ?? 0,
        next.workflowVersion ?? null,
        next.leaseOwner ?? null,
        next.leaseExpiresAt ?? null,
        next.updatedAt,
        id,
        expectedVersion,
      );
    return res.changes > 0;
  }
}
