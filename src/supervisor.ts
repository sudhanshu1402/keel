import type { Keel } from './runtime.js';
import { isConcurrentStore, type Store } from './store/types.js';

export interface SupervisorOptions {
  /** Poll interval in milliseconds for the background loop. */
  pollMs?: number;
  /** Override the clock (tests inject a controllable now). */
  now?: () => number;
  /** Stable identity used when leasing runs on a concurrent store. */
  workerId?: string;
  /** Lease duration in ms when claiming on a concurrent store. */
  leaseMs?: number;
  /**
   * How often, in ms, to extend the lease while a resume runs. A resume that
   * outlives its lease would otherwise be reclaimed by another resumer and run
   * twice. Defaults to `leaseMs / 3`.
   */
  renewMs?: number;
}

let supervisorCounter = 0;

/**
 * Wakes durable timers. When a run is configured with `durableTimers`, a
 * `ctx.sleep` suspends the run and records a wake time; the supervisor polls
 * the store for sleeps that are due and resumes their runs. This is what lets
 * a sleeping workflow survive a process exit: a fresh process with the
 * workflow registered and a supervisor running will pick the run back up.
 *
 * On a `ConcurrentStore` the supervisor claims a lease before resuming, so it
 * is safe to run alongside `Worker`s (or other supervisors) over the same
 * store: no run is woken by two resumers at once. On a plain `Store` (no
 * leasing) run exactly one supervisor against the store.
 */
export class Supervisor {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private readonly inFlight = new Set<string>();
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly renewMs: number;

  constructor(
    private readonly keel: Keel,
    private readonly store: Store,
    opts: SupervisorOptions = {},
  ) {
    this.pollMs = opts.pollMs ?? 100;
    this.now = opts.now ?? (() => Date.now());
    supervisorCounter += 1;
    this.workerId = opts.workerId ?? `supervisor_${supervisorCounter}`;
    this.leaseMs = opts.leaseMs ?? 30_000;
    this.renewMs = Math.max(1, opts.renewMs ?? Math.floor(this.leaseMs / 3));
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
   * Run one poll pass: resume every run whose durable timer is now due.
   * Returns the number of runs resumed. Safe to call directly in tests.
   */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const store = this.store;
      const due = await store.getReadySteps(this.now());
      const runIds = [...new Set(due.map((d) => d.runId))];
      let resumed = 0;
      for (const runId of runIds) {
        if (this.inFlight.has(runId)) continue;
        this.inFlight.add(runId);
        try {
          if (isConcurrentStore(store)) {
            const claimed = await store.claimRun(
              runId,
              this.workerId,
              this.leaseMs,
              this.now(),
            );
            // A Worker or another resumer holds this run; let them wake it.
            if (!claimed) continue;
            // Keep the lease alive for the duration of the resume. Re-claiming
            // as the same owner extends the expiry, so a resume that takes
            // longer than `leaseMs` is not reclaimed and re-run by another
            // resumer. Mirrors Worker.claimAndRun. The `renewing` guard stops a
            // heartbeat callback that was already queued before clearInterval
            // from re-extending the lease after we release it.
            let renewing = true;
            const heartbeat = setInterval(() => {
              if (!renewing) return;
              void store.claimRun(
                runId,
                this.workerId,
                this.leaseMs,
                this.now(),
              );
            }, this.renewMs);
            heartbeat.unref?.();
            try {
              await this.keel.resume(runId);
              resumed += 1;
            } finally {
              renewing = false;
              clearInterval(heartbeat);
              await store.releaseClaim(runId, this.workerId);
            }
          } else {
            await this.keel.resume(runId);
            resumed += 1;
          }
        } catch {
          // A failed or diverged resume is already recorded on the run record;
          // keep waking the other due runs rather than aborting the whole pass.
        } finally {
          this.inFlight.delete(runId);
        }
      }
      return resumed;
    } finally {
      this.ticking = false;
    }
  }
}
