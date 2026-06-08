import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { IdentityModule } from '../identity/identity.module';
import { OracleController } from './oracle.controller';
import { OpenDotaService } from './opendota.service';

@Module({
  imports: [IdentityModule],
  controllers: [OracleController],
  providers: [OpenDotaService, PrismaService],
})
export class OracleModule {}
