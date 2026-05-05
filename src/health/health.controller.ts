import { Controller, Get } from '@nestjs/common';

import { ReconciliationService } from '../reconciliation/reconciliation.service';

@Controller('health')
export class HealthController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  /**
   * GET /health — liveness + reconciliation cron status.
   *
   * Phase 5.4 enriched output for ops monitoring:
   *  - lastReconcileAt — null on cold start, ISO timestamp once cron has run
   *  - lastReconcileScanned / Touched — last pass's tournament scope + diff count
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
    };
  }
}
