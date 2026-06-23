import type { RunRecord, StepRecord, Store } from './types.js';

const stepKey = (runId: string, name: string): string => `${runId}::${name}`;

/** In-memory store. The default for development and tests; not durable. */
export class MemoryStore implements Store {
  private runs = new Map<string, RunRecord>();
  private steps = new Map<string, StepRecord>();

  async createRun(run: RunRecord): Promise<void> {
    this.runs.set(run.id, { ...run });
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    const run = this.runs.get(id);
    return run ? { ...run } : undefined;
  }

  async updateRun(id: string, patch: Partial<RunRecord>): Promise<void> {
    const existing = this.runs.get(id);
    if (!existing) throw new Error(`run ${id} not found`);
    this.runs.set(id, { ...existing, ...patch });
  }

  async getStep(runId: string, name: string): Promise<StepRecord | undefined> {
    const step = this.steps.get(stepKey(runId, name));
    return step ? { ...step } : undefined;
  }

  async saveStep(step: StepRecord): Promise<void> {
    this.steps.set(stepKey(step.runId, step.name), { ...step });
  }

  async listRuns(): Promise<RunRecord[]> {
    return [...this.runs.values()].map((r) => ({ ...r }));
  }

  async listSteps(runId: string): Promise<StepRecord[]> {
    return [...this.steps.values()]
      .filter((s) => s.runId === runId)
      .map((s) => ({ ...s }));
  }
}
