import { Injectable } from '@nestjs/common';

/**
 * R9 mitigation scaffold — tracks Switchboard On-Demand spend so feed/randomness
 * cost can't grow silently. Phase 1 §3 P3-4 lands the counters + `/health`
 * surface; the actual `record*` calls get wired in when the VRF-reveal cron
 * (Stage B) and the oracle-relayer / feed creation (V1.2) submit transactions.
 *
 * Counts are process-local (reset on restart) — enough for an ops sanity gauge,
 * not accounting. Promote to a persisted counter if it ever drives billing.
 */
@Injectable()
export class SwitchboardCostService {
  private randomnessRequests = 0;
  private feedsCreated = 0;
  private feedUpdates = 0;
  /** Rolling sum of lamports spent on Switchboard txs (fees + rent). */
  private totalCostLamports = 0;
  private lastEventAt: string | null = null;

  recordRandomnessRequest(costLamports = 0): void {
    this.randomnessRequests += 1;
    this.add(costLamports);
  }

  recordFeedCreated(costLamports = 0): void {
    this.feedsCreated += 1;
    this.add(costLamports);
  }

  recordFeedUpdate(costLamports = 0): void {
    this.feedUpdates += 1;
    this.add(costLamports);
  }

  private add(costLamports: number): void {
    this.totalCostLamports += Math.max(0, costLamports);
    this.lastEventAt = new Date().toISOString();
  }

  /** Snapshot for `/health`. */
  getSnapshot() {
    return {
      randomnessRequests: this.randomnessRequests,
      feedsCreated: this.feedsCreated,
      feedUpdates: this.feedUpdates,
      totalCostLamports: this.totalCostLamports,
      totalCostSol: this.totalCostLamports / 1_000_000_000,
      lastEventAt: this.lastEventAt,
    };
  }
}
