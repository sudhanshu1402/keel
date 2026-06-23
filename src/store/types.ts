export type RunStatus = 'running' | 'completed' | 'failed' | 'paused';

export type StepStatus = 'pending' | 'completed' | 'failed';

export interface RunRecord {
  id: string;
  workflowName: string;
  status: RunStatus;
  input: unknown;
  output?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface StepRecord {
  runId: string;
  name: string;
  status: StepStatus;
  attempts: number;
  result?: unknown;
  error?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  /** For sleep steps: the timestamp at which the sleep should end. */
  wakeAt?: number;
  startedAt: number;
  finishedAt?: number;
}

/**
 * Persistence boundary for the runtime. Every method is async so that file,
 * Redis, or SQLite adapters can implement it without changing the engine.
 */
export interface Store {
  createRun(run: RunRecord): Promise<void>;
  getRun(id: string): Promise<RunRecord | undefined>;
  updateRun(id: string, patch: Partial<RunRecord>): Promise<void>;
  getStep(runId: string, name: string): Promise<StepRecord | undefined>;
  saveStep(step: StepRecord): Promise<void>;
  listRuns(): Promise<RunRecord[]>;
  listSteps(runId: string): Promise<StepRecord[]>;
}
