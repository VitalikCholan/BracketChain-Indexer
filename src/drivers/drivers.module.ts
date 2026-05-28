import { Module } from '@nestjs/common';

import { ChainReaderService } from '../chain/chain-reader.service';
import { PrismaService } from '../prisma.service';
import { AutoClaimDriver } from './auto-claim.driver';
import { OracleRelayerDriver } from './oracle-relayer.driver';
import { VrfRevealDriver } from './vrf-reveal.driver';

/**
 * Permissionless Phase 1 crons. `KeychainService` + the Switchboard services are
 * global; the scheduler is initialized once via `ScheduleModule.forRoot()` in
 * `ReconciliationModule`, so the explorer discovers every `@Cron` provider
 * declared here app-wide. `ChainReaderService` is provided locally (stateless —
 * env-driven Connection + coder) for drivers that read authoritative on-chain
 * state the read-cache can't supply (e.g. VRF, which emits no event).
 *
 * Each driver is default-off (see {@link PermissionlessDriver.enabled}): it
 * signs only when `PERMISSIONLESS_DRIVERS_ENABLED=true` AND its own
 * `PERMISSIONLESS_<DRIVER>_ENABLED=true`.
 */
@Module({
  providers: [
    PrismaService,
    ChainReaderService,
    AutoClaimDriver,
    OracleRelayerDriver,
    VrfRevealDriver,
  ],
})
export class DriversModule {}
