import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PrismaService } from './prisma.service';
import { HealthController } from './health/health.controller';
import { TournamentsModule } from './tournaments/tournaments.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { KeychainModule } from './keys/keychain.module';
import { SwitchboardModule } from './switchboard/switchboard.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    KeychainModule,
    SwitchboardModule,
    TournamentsModule,
    WebhooksModule,
    ReconciliationModule,
  ],
  controllers: [HealthController],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class AppModule {}
