import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { RunRecord, StepRecord, Store } from './types.js';

interface FileDb {
  runs: Record<string, RunRecord>;
  steps: Record<string, StepRecord>;
}

const stepKey = (runId: string, name: string): string => `${runId}::${name}`;

/**
 * Zero-dependency JSON file store. Durable across process restarts, which is
 * what makes crash recovery demonstrable without any external service. Writes
 * are atomic (temp file then rename) so a crash mid-write cannot corrupt the db.
 */
export class FileStore implements Store {
  private db: FileDb;

  constructor(private path: string) {
    const dir = dirname(path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = this.load();
  }

  private load(): FileDb {
    if (!existsSync(this.path)) return { runs: {}, steps: {} };
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<FileDb>;
      return { runs: parsed.runs ?? {}, steps: parsed.steps ?? {} };
    } catch {
      return { runs: {}, steps: {} };
    }
  }

  private flush(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.db, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }

  async createRun(run: RunRecord): Promise<void> {
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
    this.db.runs[id] = { ...existing, ...patch };
    this.flush();
  }

  async getStep(runId: string, name: string): Promise<StepRecord | undefined> {
    const step = this.db.steps[stepKey(runId, name)];
    return step ? { ...step } : undefined;
  }

  async saveStep(step: StepRecord): Promise<void> {
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
}
