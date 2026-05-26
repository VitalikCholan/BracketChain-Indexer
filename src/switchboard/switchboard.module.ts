import { Global, Module } from '@nestjs/common';
import { SwitchboardCostService } from './switchboard-cost.service';
import { SwitchboardVrfService } from './switchboard-vrf.service';

/**
 * Global so the VRF-reveal cron (Stage B) and the V1.2 oracle-relayer / feed
 * creation can inject {@link SwitchboardCostService} to record spend +
 * {@link SwitchboardVrfService} to build reveal instructions, and the health
 * controller can read the cost snapshot.
 */
@Global()
@Module({
  providers: [SwitchboardCostService, SwitchboardVrfService],
  exports: [SwitchboardCostService, SwitchboardVrfService],
})
export class SwitchboardModule {}
