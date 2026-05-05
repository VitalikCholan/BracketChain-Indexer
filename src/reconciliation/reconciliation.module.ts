import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { PrismaService } from '../prisma.service';
import { ChainReaderService } from '../chain/chain-reader.service';
import { ReconciliationService } from './reconciliation.service';

/**
 * Phase 5.4: reconciliation cron module. Wires the @Cron decorator's
 * scheduler + ChainReader + Prisma. Exports ReconciliationService so
 * the health endpoint can read its status snapshot.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [PrismaService, ChainReaderService, ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
