import { Global, Module } from '@nestjs/common';
import { SwitchboardCostService } from './switchboard-cost.service';

/**
 * Global so the VRF-reveal cron (Stage B) and the V1.2 oracle-relayer / feed
 * creation can inject {@link SwitchboardCostService} to record spend, and the
 * health controller can read its snapshot.
 */
@Global()
@Module({
  providers: [SwitchboardCostService],
  exports: [SwitchboardCostService],
})
export class SwitchboardModule {}
