import { Module } from '@nestjs/common';

import { ChainReaderService } from '../chain/chain-reader.service';
import { PrismaService } from '../prisma.service';
import { AutoClaimDriver } from './auto-claim.driver';
import { CloseTerminalDriver } from './close-terminal.driver';
import { OracleRelayerDriver } from './oracle-relayer.driver';
import { PartialRefundDriver } from './partial-refund.driver';
import { VrfRevealDriver } from './vrf-reveal.driver';

@Module({
  providers: [
    PrismaService,
    ChainReaderService,
    AutoClaimDriver,
    CloseTerminalDriver,
    OracleRelayerDriver,
    PartialRefundDriver,
    VrfRevealDriver,
  ],
})
export class DriversModule {}
