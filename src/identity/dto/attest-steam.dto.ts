import { IsString, Length, Matches } from 'class-validator';

/**
 * Body for `POST /identity/steam/attest`.
 *
 * `wallet` is the player's Solana wallet (the attestation `nonce`, which the
 * on-chain `validate_attestation` requires to equal the joining signer).
 * `steamId64` is the 17-digit Steam ID 64 — in production it must come from a
 * verified Steam OpenID assertion, never raw client input (see controller).
 */
export class AttestSteamDto {
  @IsString()
  @Length(32, 44)
  wallet!: string;

  @IsString()
  @Matches(/^\d{17}$/, { message: 'steamId64 must be a 17-digit Steam ID 64' })
  steamId64!: string;
}
