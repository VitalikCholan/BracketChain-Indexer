import { Module } from '@nestjs/common';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';

/**
 * Steam → SAS identity issuance (V1.1 A-9). `IdentityService` injects the
 * global `KeychainService` (`sas-issuer` role) to sign attestations.
 */
@Module({
  controllers: [IdentityController],
  providers: [IdentityService],
})
export class IdentityModule {}
