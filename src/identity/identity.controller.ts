import { Body, Controller, ForbiddenException, Post } from '@nestjs/common';
import { AttestSteamDto } from './dto/attest-steam.dto';
import { IdentityService } from './identity.service';

@Controller('identity')
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  /**
   * `POST /identity/steam/attest` — issue a wallet↔Steam SAS attestation for
   * Dota 2 (consumed by `join_tournament`).
   *
   * ⚠️ **Security gate.** This mints an on-chain identity binding, so it must
   * only run after the caller's Steam ownership is proven via **Steam OpenID**
   * (the A-11 frontend flow; the assertion must be verified server-side, not
   * trusted from the client `steamId64`). Until that verification is wired in
   * here, the endpoint is **disabled** unless `IDENTITY_ATTEST_ENABLED=true`,
   * to prevent identity spoofing (anyone binding any Steam ID to any wallet).
   */
  @Post('steam/attest')
  async attestSteam(@Body() dto: AttestSteamDto) {
    if (process.env.IDENTITY_ATTEST_ENABLED !== 'true') {
      throw new ForbiddenException(
        'identity attestation disabled — set IDENTITY_ATTEST_ENABLED=true only after Steam OpenID verification is wired server-side',
      );
    }
    return this.identity.issueSteamAttestation(dto.wallet, dto.steamId64);
  }
}
