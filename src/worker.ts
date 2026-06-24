import type { Keel } from './runtime.js';
import type { ConcurrentStore } from './store/types.js';

export interface WorkerOptions {
  /** Stable identity for this worker; defaults to a random-ish id. */
  workerId?: string;
  /** Max runs executed in parallel per tick. Defaults to 1. */
  concurrency?: number;
  /** Lease duration in ms; a crashed worker's runs become reclaimable after. */
  leaseMs?: number;
  /**
   * How often, in ms, to extend the lease while a run executes. A run that
   * outlives its lease would otherwise be reclaimed by another worker and run
   * twice. Defaults to `leaseMs / 3`.
   */
  renewMs?: number;
  /** Poll interval in ms for the background loop. */
  pollMs?: number;
  /** Override the clock (tests inject a controllable now). */
  now?: () => number;
}

let workerCounter = 0;

/**
 * Executes enqueued runs from a shared `ConcurrentStore`. Many workers can poll
 * the same store; lease-based claiming guarantees no run is executed by two
 * workers at once, and an expired lease (a crashed worker) is reclaimed by the
 * next poller. Picks up freshly enqueued runs, durable timers that are due, and
 * runs orphaned by a crashed worker.
 */
export class Worker {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private readonly workerId: string;
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private readonly renewMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;

  constructor(
    private readonly keel: Keel,
    private readonly store: ConcurrentStore,
    opts: WorkerOptions = {},
  ) {
    workerCounter += 1;
    this.workerId = opts.workerId ?? `worker_${workerCounter}`;
    this.concurrency = Math.max(1, opts.concurrency ?? 1);
    this.leaseMs = opts.leaseMs ?? 30_000;
    this.renewMs = Math.max(1, opts.renewMs ?? Math.floor(this.leaseMs / 3));
    this.pollMs = opts.pollMs ?? 100;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Begin polling on an interval. The timer does not keep the process alive. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollMs);
    this.timer.unref?.();
  }

  /** Stop polling. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Run one poll pass: claim and execute every run currently available to this
   * worker, up to `concurrency` at a time. Returns the number of runs this
   * worker actually executed (claims it lost to other workers do not count).
   */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const candidates = await this.findCandidates();
      let executed = 0;
      for (let i = 0; i < candidates.length; i += this.concurrency) {
        const batch = candidates.slice(i, i + this.concurrency);
        const results = await Promise.all(
          batch.map((runId) => this.claimAndRun(runId)),
        );
        executed += results.filter(Boolean).length;
      }
      return executed;
    } finally {
      this.ticking = false;
    }
  }

  private async findCandidates(): Promise<string[]> {
    const now = this.now();
    const ids = new Set<string>();
    for (const run of await this.store.listRuns()) {
      if (run.status === 'queued') {
        ids.add(run.id);
      } else if (
        run.status === 'running' &&
        run.leaseExpiresAt !== undefined &&
        run.leaseExpiresAt <= now
      ) {
        // A worker holding this run died; its lease has expired. Reclaim it.
        ids.add(run.id);
      }
    }
    for (const ready of await this.store.getReadySteps(now)) {
      ids.add(ready.runId);
    }
    return [...ids];
  }

  private async claimAndRun(runId: string): Promise<boolean> {
    const claimed = await this.store.claimRun(
      runId,
      this.workerId,
      this.leaseMs,
      this.now(),
    );
    if (!claimed) return false;
    // Keep the lease alive for the duration of the run. Re-claiming as the same
    // owner extends the expiry, so a run that takes longer than `leaseMs` is not
    // reclaimed and re-executed by another worker. The `renewing` guard stops a
    // heartbeat callback that was already queued before clearInterval from
    // re-extending the lease after we release it.
    let renewing = true;
    const heartbeat = setInterval(() => {
      if (!renewing) return;
      void this.store.claimRun(runId, this.workerId, this.leaseMs, this.now());
    }, this.renewMs);
    heartbeat.unref?.();
    try {
      // Another worker may have finished this run between our candidate scan and
      // the claim. Re-check under the lease and skip terminal runs.
      const run = await this.store.getRun(runId);
      if (
        !run ||
        run.status === 'completed' ||
        run.status === 'failed' ||
        run.status === 'cancelled'
      ) {
        return false;
      }
      await this.keel.resume(runId);
      return true;
    } catch {
      // resume records failure/divergence on the run; keep this worker alive.
      return false;
    } finally {
      renewing = false;
      clearInterval(heartbeat);
      await this.store.releaseClaim(runId, this.workerId);
    }
  }
}
