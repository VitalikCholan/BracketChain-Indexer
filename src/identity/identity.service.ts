import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { KeychainService } from '../keys/keychain.service';
import { PrismaService } from '../prisma.service';

// Devnet SAS artifacts from the §2 bootstrap (overridable via env).
const SAS_CREDENTIAL =
  process.env.SAS_CREDENTIAL ?? 'A6aCesF4nLNRGBRfUS5dCw9e1f1peGmNhZU4t139Qwjc';
const SAS_SCHEMA_DOTA2 =
  process.env.SAS_SCHEMA_DOTA2 ??
  '4TT2a5ycymMRwZJoGTPfaggb7CtGrDtCXKheF7zeV27m';
const RPC_HTTP = process.env.RPC_URL ?? 'https://api.devnet.solana.com';

/** `SupportedGame::Dota2` discriminant — must match the on-chain enum. */
const GAME_DOTA2 = 1;

/**
 * Games that have a SAS schema in Phase 1. Keyed by the slug the frontend puts
 * in the `:game` path param (and tolerant of the raw enum discriminant). Only
 * Dota 2 ships a schema today; `manual` (0) carries no identity at all.
 */
const SUPPORTED_GAME_SCHEMAS: Record<string, string> = {
  dota2: SAS_SCHEMA_DOTA2,
  '1': SAS_SCHEMA_DOTA2,
};

// SAS schema `data` is borsh `game(u8) + steam_id_64(u64) + identity_bytes(Vec)`.
// The 32-byte identity fingerprint starts after game(1) + steam(8) + vec_len(4).
const IDENTITY_BYTES_OFFSET = 13;

export interface IssuedAttestation {
  attestation: string;
  signature: string;
  alreadyExisted: boolean;
}

export interface GameIdentity {
  /** Derived SAS attestation PDA for (credential, schema, wallet). */
  attestationPda: string;
  /** Whether the attestation account exists on-chain. */
  exists: boolean;
  /** Hex of the 32-byte identity fingerprint (= SHA-256(steamId64 LE)). */
  identityHash?: string;
  /** Unix-seconds expiry; `0` = never expires (matches on-chain convention). */
  expiry?: number;
}

@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(
    private readonly keychain: KeychainService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Issue (or return the existing) SAS attestation binding `wallet` ↔ Steam
   * identity for Dota 2, signed by the `sas-issuer` keychain role.
   *
   * The attestation `data` is the exact borsh layout the on-chain
   * `validate_attestation` parses: `game(u8) + steam_id_64(u64) +
   * identity_bytes(Vec<u8>, 32)`. `identity_bytes` is a 32-byte SHA-256
   * fingerprint of the Steam ID 64 — the program stores it verbatim as
   * `participant.identity_hash` (no on-chain hashing), so the fingerprint is
   * derived here.
   *
   * `expiry` is set to 0 ("never expires"); the program treats 0 specially.
   * Idempotent: the SAS attestation PDA is unique per (credential, schema,
   * wallet), so a repeat call returns the existing account.
   */
  async issueSteamAttestation(
    wallet: string,
    steamId64: string,
  ): Promise<IssuedAttestation> {
    const { deriveAttestationPda, getCreateAttestationInstruction } =
      await import('sas-lib');
    const kit = await import('@solana/kit');

    // 1. Build the schema `data` payload (borsh, little-endian).
    const steamLe = Buffer.alloc(8);
    steamLe.writeBigUInt64LE(BigInt(steamId64));
    const identityBytes = createHash('sha256').update(steamLe).digest(); // 32 bytes

    const identityHashHex = identityBytes.toString('hex');
    await this.prisma.steamIdentity.upsert({
      where: { identityHash: identityHashHex },
      create: { identityHash: identityHashHex, steamId64, wallet },
      update: { steamId64, wallet, linkedAt: new Date() },
    });

    const lenPrefix = Buffer.alloc(4);
    lenPrefix.writeUInt32LE(identityBytes.length); // 32
    const data = new Uint8Array(
      Buffer.concat([
        Buffer.from([GAME_DOTA2]),
        steamLe,
        lenPrefix,
        identityBytes,
      ]),
    );

    const credential = SAS_CREDENTIAL as never;
    const schema = SAS_SCHEMA_DOTA2 as never;
    const nonce = wallet as never;
    const [attestation] = await deriveAttestationPda({
      credential,
      schema,
      nonce,
    });

    const rpc = kit.createSolanaRpc(RPC_HTTP);

    const existing = await rpc
      .getAccountInfo(attestation, { encoding: 'base64' })
      .send();
    if (existing.value !== null) {
      this.logger.log(
        `attestation already exists for ${wallet}: ${attestation}`,
      );
      return {
        attestation: String(attestation),
        signature: '',
        alreadyExisted: true,
      };
    }

    const issuer = await this.keychain.getSigner('sas-issuer');
    const ix = getCreateAttestationInstruction({
      payer: issuer,
      authority: issuer,
      credential,
      schema,
      attestation,
      nonce,
      data,
      expiry: 0n,
    });

    const rpcSubscriptions = kit.createSolanaRpcSubscriptions(
      RPC_HTTP.replace(/^http/, 'ws'),
    );
    const sendAndConfirm = kit.sendAndConfirmTransactionFactory({
      rpc,
      rpcSubscriptions,
    });
    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
    const message = kit.pipe(
      kit.createTransactionMessage({ version: 0 }),
      (m) => kit.setTransactionMessageFeePayerSigner(issuer as never, m),
      (m) =>
        kit.setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) => kit.appendTransactionMessageInstructions([ix], m),
    );
    const signed = await kit.signTransactionMessageWithSigners(message);
    // Cast narrows the kit blockhash-lifetime typing friction; runtime shape is
    // exactly what sendAndConfirm expects (a fully-signed blockhash-lifetime tx).
    await sendAndConfirm(signed as Parameters<typeof sendAndConfirm>[0], {
      commitment: 'confirmed',
    });
    const signature = kit.getSignatureFromTransaction(signed);

    this.logger.log(
      `issued attestation ${attestation} for ${wallet} (sig ${signature})`,
    );
    return {
      attestation: String(attestation),
      signature,
      alreadyExisted: false,
    };
  }

  async resolveSteamId(identityHashHex: string): Promise<string | null> {
    const row = await this.prisma.steamIdentity.findUnique({
      where: { identityHash: identityHashHex.toLowerCase() },
    });
    return row?.steamId64 ?? null;
  }

  /**
   * Read-only lookup of a wallet's game-identity attestation (A11-1), used by
   * the frontend join flow to prefetch the attestation account before passing
   * it to `joinTournament`, and to render "linked / not linked".
   *
   * Derives the same SAS PDA as issuance, reads it on-chain (no DB), and — when
   * present — surfaces the verbatim 32-byte `identity_bytes` fingerprint and the
   * expiry. On-chain is the single source of truth, so there is no cache.
   */
  async getGameIdentity(wallet: string, game: string): Promise<GameIdentity> {
    const schema = SUPPORTED_GAME_SCHEMAS[game.toLowerCase()];
    if (!schema) {
      throw new BadRequestException(
        `unsupported game "${game}" — only Dota 2 has a SAS schema in Phase 1`,
      );
    }
    if (wallet.length < 32 || wallet.length > 44) {
      throw new BadRequestException('invalid wallet address');
    }

    const { deriveAttestationPda, fetchMaybeAttestation } =
      await import('sas-lib');
    const kit = await import('@solana/kit');

    const [attestation] = await deriveAttestationPda({
      credential: SAS_CREDENTIAL as never,
      schema: schema as never,
      nonce: wallet as never,
    });

    const rpc = kit.createSolanaRpc(RPC_HTTP);
    const acct = await fetchMaybeAttestation(rpc, attestation);
    if (!acct.exists) {
      return { attestationPda: String(attestation), exists: false };
    }

    const payload = acct.data.data;
    const identity = payload.slice(
      IDENTITY_BYTES_OFFSET,
      IDENTITY_BYTES_OFFSET + 32,
    );
    return {
      attestationPda: String(attestation),
      exists: true,
      identityHash: Buffer.from(identity).toString('hex'),
      expiry: Number(acct.data.expiry),
    };
  }
}
