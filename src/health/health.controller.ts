import { Controller, Get } from '@nestjs/common';

import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { SwitchboardCostService } from '../switchboard/switchboard-cost.service';
import { HeliusParserService } from '../webhooks/helius-parser.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly switchboardCost: SwitchboardCostService,
    private readonly parser: HeliusParserService,
  ) {}

  /**
   * GET /health — liveness + reconciliation cron status.
   *
   * Phase 5.4 enriched output for ops monitoring:
   *  - lastReconcileAt — null on cold start, ISO timestamp once cron has run
   *  - lastReconcileScanned / Touched — last pass's tournament scope + drift count
   *  - lastReconcileFreshnessBumped — rows whose only change was the freshness
   *    watermark (M-4: batched, not counted as drift)
   *  - lastReconcilePayoutsBackfilled — Completed rows whose payouts were rebuilt
   *  - lastReconcileError — last error message (cleared on success)
   *
   * Railway / uptime monitors only need to check `ok: true`. Detailed fields
   * are for SRE dashboards + the demo-day pre-flight check.
   */
  @Get()
  check() {
    return {
      ok: true,
      timestamp: new Date().toISOString(),
      reconciliation: this.reconciliation.getStatus(),
      switchboardCost: this.switchboardCost.getSnapshot(),
      eventVersion: { unknownCount: this.parser.getUnknownEventVersionCount() },
    };
  }
}
