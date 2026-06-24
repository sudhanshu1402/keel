export type RunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'cancelled';

export type StepStatus = 'pending' | 'completed' | 'failed';

export interface RunRecord {
  id: string;
  workflowName: string;
  status: RunStatus;
  input: unknown;
  output?: unknown;
  error?: string;
  /** Optimistic-concurrency counter, bumped on every concurrent-store write. */
  version?: number;
  /** The workflow definition's `version` at the time the run was created. */
  workflowVersion?: number;
  /** Worker id currently holding the execution lease, if any. */
  leaseOwner?: string;
  /** Timestamp after which the lease is considered expired and reclaimable. */
  leaseExpiresAt?: number;
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
  /**
   * Position of this step in the run's deterministic call order, assigned the
   * first time the step is reached. Used to detect replay divergence: if a
   * resumed handler reaches a different step name at this index, the workflow
   * code changed underneath a live run.
   */
  index?: number;
  startedAt: number;
  finishedAt?: number;
}

/**
 * A value delivered to a run from the outside (human-in-the-loop, a webhook,
 * another workflow). A run blocked in `waitForSignal(name)` resumes when a
 * matching signal is stored.
 */
export interface SignalRecord {
  runId: string;
  name: string;
  value: unknown;
  createdAt: number;
}

/** A sleep step that is due to wake, returned by the supervisor poll. */
export interface ReadyStep {
  runId: string;
  name: string;
  wakeAt: number;
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
  /**
   * Pending sleep steps whose wakeAt is at or before `beforeMs`, across all
   * runs. The supervisor polls this to wake durable timers.
   */
  getReadySteps(beforeMs: number): Promise<ReadyStep[]>;
  /** Store a signal for a run, to be consumed by `waitForSignal`. */
  saveSignal(signal: SignalRecord): Promise<void>;
  /** Fetch a stored signal by run and name, if one has arrived. */
  getSignal(runId: string, name: string): Promise<SignalRecord | undefined>;
}

/**
 * A store that supports safe execution by multiple competing workers. Adds
 * lease-based claiming (so two workers never run the same run at once) and
 * compare-and-set updates (so a stale worker cannot clobber newer state).
 * Backs `Worker`. `MemoryStore` implements it for single-process fan-out;
 * `SqliteStore` implements it for cross-process workers sharing one database.
 */
export interface ConcurrentStore extends Store {
  /**
   * Atomically take the execution lease on a run. Succeeds when the run has no
   * live lease (or the caller already holds it), setting an expiry at
   * `now + leaseMs`. Returns true if the lease is now held by `workerId`.
   */
  claimRun(
    runId: string,
    workerId: string,
    leaseMs: number,
    now: number,
  ): Promise<boolean>;
  /** Release a lease the worker holds, making the run claimable again. */
  releaseClaim(runId: string, workerId: string): Promise<void>;
  /**
   * Apply a patch only if the run's version still matches `expectedVersion`,
   * bumping the version on success. Returns false on a version mismatch.
   */
  updateRunCAS(
    id: string,
    patch: Partial<RunRecord>,
    expectedVersion: number,
  ): Promise<boolean>;
}

/** Narrowing helper: does this store implement the concurrent execution API? */
export function isConcurrentStore(store: Store): store is ConcurrentStore {
  return (
    typeof (store as Partial<ConcurrentStore>).claimRun === 'function' &&
    typeof (store as Partial<ConcurrentStore>).releaseClaim === 'function'
  );
}
