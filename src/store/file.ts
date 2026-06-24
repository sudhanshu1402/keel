import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { assertJsonSafe } from './serialize.js';
import type {
  ReadyStep,
  RunRecord,
  SignalRecord,
  StepRecord,
  Store,
} from './types.js';

interface FileDb {
  runs: Record<string, RunRecord>;
  steps: Record<string, StepRecord>;
  signals: Record<string, SignalRecord>;
}

const stepKey = (runId: string, name: string): string => `${runId}::${name}`;

/**
 * Zero-dependency JSON file store. Durable across process restarts, which is
 * what makes crash recovery demonstrable without any external service. Writes
 * are atomic (temp file fsync'd, then renamed) so a crash mid-write cannot
 * corrupt the db.
 *
 * Single-process: the whole db is held in memory and rewritten on every
 * mutation, so two processes pointed at the same file will clobber each other.
 * Use a single long-lived process, or SqliteStore for multi-process / worker
 * setups.
 */
export class FileStore implements Store {
  private db: FileDb;

  constructor(private path: string) {
    const dir = dirname(path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = this.load();
  }

  private load(): FileDb {
    if (!existsSync(this.path)) return { runs: {}, steps: {}, signals: {} };
    const raw = readFileSync(this.path, 'utf8');
    try {
      const parsed = JSON.parse(raw) as Partial<FileDb>;
      return {
        runs: parsed.runs ?? {},
        steps: parsed.steps ?? {},
        signals: parsed.signals ?? {},
      };
    } catch (err) {
      // A corrupt file is NEVER silently discarded: that would wipe every
      // in-flight run. Preserve the bad file for inspection and refuse to start
      // on top of it so the operator notices.
      const quarantine = `${this.path}.corrupt-${Date.now()}`;
      renameSync(this.path, quarantine);
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `keel store at ${this.path} is corrupt (${detail}). The unreadable file ` +
          `was moved to ${quarantine}; inspect or remove it before restarting.`,
      );
    }
  }

  private flush(): void {
    const tmp = `${this.path}.tmp`;
    const data = JSON.stringify(this.db, null, 2);
    // Write + fsync the temp file before renaming, so a crash leaves either the
    // old file intact or a fully-flushed new one, never a torn write.
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
    // fsync the directory so the rename itself is durable. Best-effort: some
    // platforms (notably Windows) cannot open a directory for fsync.
    try {
      const dir = dirname(this.path) || '.';
      const dfd = openSync(dir, 'r');
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      // Directory fsync unsupported on this platform; the file fsync above
      // already covers the data itself.
    }
  }

  async createRun(run: RunRecord): Promise<void> {
    assertJsonSafe(run.input, `run ${run.id} input`);
    if (run.output !== undefined) assertJsonSafe(run.output, `run ${run.id} output`);
    this.db.runs[run.id] = { ...run };
    this.flush();
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    const run = this.db.runs[id];
    return run ? { ...run } : undefined;
  }

  async updateRun(id: string, patch: Partial<RunRecord>): Promise<void> {
    const existing = this.db.runs[id];
    if (!existing) throw new Error(`run ${id} not found`);
    if (patch.output !== undefined) assertJsonSafe(patch.output, `run ${id} output`);
    this.db.runs[id] = { ...existing, ...patch };
    this.flush();
  }

  async getStep(runId: string, name: string): Promise<StepRecord | undefined> {
    const step = this.db.steps[stepKey(runId, name)];
    return step ? { ...step } : undefined;
  }

  async saveStep(step: StepRecord): Promise<void> {
    if (step.result !== undefined) {
      assertJsonSafe(step.result, `step ${step.name} result`);
    }
    this.db.steps[stepKey(step.runId, step.name)] = { ...step };
    this.flush();
  }

  async listRuns(): Promise<RunRecord[]> {
    return Object.values(this.db.runs).map((r) => ({ ...r }));
  }

  async listSteps(runId: string): Promise<StepRecord[]> {
    return Object.values(this.db.steps)
      .filter((s) => s.runId === runId)
      .map((s) => ({ ...s }));
  }

  async getReadySteps(beforeMs: number): Promise<ReadyStep[]> {
    return Object.values(this.db.steps)
      .filter(
        (s) =>
          s.status === 'pending' &&
          s.wakeAt !== undefined &&
          s.wakeAt <= beforeMs,
      )
      .map((s) => ({ runId: s.runId, name: s.name, wakeAt: s.wakeAt! }));
  }

  async saveSignal(signal: SignalRecord): Promise<void> {
    assertJsonSafe(signal.value, `signal ${signal.name} value`);
    this.db.signals[stepKey(signal.runId, signal.name)] = { ...signal };
    this.flush();
  }

  async getSignal(
    runId: string,
    name: string,
  ): Promise<SignalRecord | undefined> {
    const s = this.db.signals[stepKey(runId, name)];
    return s ? { ...s } : undefined;
  }
}
