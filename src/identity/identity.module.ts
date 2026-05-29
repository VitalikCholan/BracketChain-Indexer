import { Module } from '@nestjs/common';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { NonceStore } from './nonce.store';
import { SteamOpenIdService } from './steam-openid.service';

/**
 * Steam → SAS identity issuance (V1.1 A-9 / A-11). Under Option B the indexer
 * owns the full OpenID round-trip: `SteamOpenIdService` builds + verifies the
 * assertion, `NonceStore` backs the single-use replay defence, and
 * `IdentityService` (injecting the global `KeychainService` `sas-issuer` role)
 * signs attestations. There is no public attest endpoint anymore — issuance is
 * only reachable through the verified `/steam/callback` path.
 */
@Module({
  controllers: [IdentityController],
  providers: [IdentityService, SteamOpenIdService, NonceStore],
})
export class IdentityModule {}
