import { assertJsonSafe } from './serialize.js';
import type {
  ConcurrentStore,
  ReadyStep,
  RunRecord,
  SignalRecord,
  StepRecord,
  Store,
} from './types.js';

const stepKey = (runId: string, name: string): string => `${runId}::${name}`;

// Deep copy so callers never share nested references with stored records. A
// workflow that mutates a value it got back from the store (or one it passed
// in) must not corrupt durable state, matching how the file/sqlite stores
// behave after a JSON round-trip.
const clone = <T>(v: T): T => structuredClone(v);

/**
 * In-memory store. The default for development and tests; not durable across
 * restarts. Implements `ConcurrentStore` so multiple `Worker`s in one process
 * can fan out over runs safely (claim/CAS bodies run synchronously, so they
 * are atomic with respect to other pending promises).
 */
export class MemoryStore implements ConcurrentStore {
  private runs = new Map<string, RunRecord>();
  private steps = new Map<string, StepRecord>();
  private signals = new Map<string, SignalRecord>();

  async createRun(run: RunRecord): Promise<void> {
    assertJsonSafe(run.input, `run ${run.id} input`);
    if (run.output !== undefined) assertJsonSafe(run.output, `run ${run.id} output`);
    this.runs.set(run.id, clone(run));
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    const run = this.runs.get(id);
    return run ? clone(run) : undefined;
  }

  async updateRun(id: string, patch: Partial<RunRecord>): Promise<void> {
    const existing = this.runs.get(id);
    if (!existing) throw new Error(`run ${id} not found`);
    if (patch.output !== undefined) assertJsonSafe(patch.output, `run ${id} output`);
    this.runs.set(id, clone({ ...existing, ...patch }));
  }

  async getStep(runId: string, name: string): Promise<StepRecord | undefined> {
    const step = this.steps.get(stepKey(runId, name));
    return step ? clone(step) : undefined;
  }

  async saveStep(step: StepRecord): Promise<void> {
    if (step.result !== undefined) {
      assertJsonSafe(step.result, `step ${step.name} result`);
    }
    this.steps.set(stepKey(step.runId, step.name), clone(step));
  }

  async listRuns(): Promise<RunRecord[]> {
    return [...this.runs.values()].map((r) => clone(r));
  }

  async listSteps(runId: string): Promise<StepRecord[]> {
    return [...this.steps.values()]
      .filter((s) => s.runId === runId)
      .map((s) => clone(s));
  }

  async getReadySteps(beforeMs: number): Promise<ReadyStep[]> {
    return [...this.steps.values()]
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
    this.signals.set(stepKey(signal.runId, signal.name), clone(signal));
  }

  async getSignal(
    runId: string,
    name: string,
  ): Promise<SignalRecord | undefined> {
    const s = this.signals.get(stepKey(runId, name));
    return s ? clone(s) : undefined;
  }

  // The bodies below run to completion without awaiting, so a check-then-set is
  // atomic relative to other in-flight promises in the same process.

  async claimRun(
    runId: string,
    workerId: string,
    leaseMs: number,
    now: number,
  ): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run) return false;
    const held =
      run.leaseExpiresAt !== undefined &&
      run.leaseExpiresAt > now &&
      run.leaseOwner !== workerId;
    if (held) return false;
    this.runs.set(runId, {
      ...run,
      leaseOwner: workerId,
      leaseExpiresAt: now + leaseMs,
      version: (run.version ?? 0) + 1,
    });
    return true;
  }

  async releaseClaim(runId: string, workerId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.leaseOwner !== workerId) return;
    this.runs.set(runId, {
      ...run,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      version: (run.version ?? 0) + 1,
    });
  }

  async updateRunCAS(
    id: string,
    patch: Partial<RunRecord>,
    expectedVersion: number,
  ): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run || (run.version ?? 0) !== expectedVersion) return false;
    this.runs.set(id, {
      ...run,
      ...patch,
      version: expectedVersion + 1,
    });
    return true;
  }
}
