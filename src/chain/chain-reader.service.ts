import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { BorshAccountsCoder, Idl } from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';

import idlJson from '../idl/bracket_chain.json';

/**
 * Phase 5.4: minimal Solana chain reader for the reconciliation cron.
 *
 * Lightweight by design — uses raw `Connection.getMultipleAccountsInfo` plus
 * Anchor's `BorshAccountsCoder` for decoding. We don't need full Anchor
 * Program (no IDL methods, no Provider) since reconciliation is read-only
 * and never sends transactions.
 *
 * Env: RPC_URL (Solana RPC endpoint), PROGRAM_ID (program PDA).
 */
@Injectable()
export class ChainReaderService implements OnModuleInit {
  private readonly logger = new Logger(ChainReaderService.name);
  private connection!: Connection;
  private coder!: BorshAccountsCoder;
  private programId!: PublicKey;

  onModuleInit() {
    const rpcUrl = process.env.RPC_URL;
    const programIdStr = process.env.PROGRAM_ID;
    if (!rpcUrl) {
      throw new Error('RPC_URL env var is required for chain reads');
    }
    if (!programIdStr) {
      throw new Error('PROGRAM_ID env var is required');
    }

    this.connection = new Connection(rpcUrl, 'confirmed');
    this.coder = new BorshAccountsCoder(idlJson as Idl);
    this.programId = new PublicKey(programIdStr);

    this.logger.log(`ChainReader initialized — rpc=${maskUrl(rpcUrl)}, programId=${programIdStr}`);
  }

  /**
   * Fetch the cluster's current slot. Used by the reconciliation cron to
   * stamp the freshness watermark on rows it touches.
   */
  async getSlot(): Promise<number> {
    return this.connection.getSlot('confirmed');
  }

  /**
   * Batch-fetch Tournament accounts. Returns an array aligned with the
   * input PDAs — `null` entries indicate accounts that don't exist or
   * couldn't be decoded. One getMultipleAccountsInfo RPC for up to 100
   * pubkeys (Solana's per-call cap).
   */
  async fetchTournaments(
    pdas: PublicKey[],
  ): Promise<Array<DecodedTournament | null>> {
    if (pdas.length === 0) return [];

    // Solana's getMultipleAccountsInfo caps at 100 entries per request.
    // Chunk defensively even though the cron limits us to ~50 per pass.
    const CHUNK = 100;
    const out: Array<DecodedTournament | null> = [];
    for (let i = 0; i < pdas.length; i += CHUNK) {
      const slice = pdas.slice(i, i + CHUNK);
      const infos = await this.connection.getMultipleAccountsInfo(slice, 'confirmed');
      for (let j = 0; j < slice.length; j++) {
        const info = infos[j];
        if (!info?.data) {
          out.push(null);
          continue;
        }
        // Defensive: validate program ownership before decoding.
        if (!info.owner.equals(this.programId)) {
          this.logger.warn(
            `Account ${slice[j]?.toBase58()} not owned by program; skipping`,
          );
          out.push(null);
          continue;
        }
        try {
          const decoded = this.coder.decode<DecodedTournament>(
            'tournament',
            info.data as Buffer,
          );
          out.push(decoded);
        } catch (err) {
          this.logger.warn(
            `Failed to decode Tournament ${slice[j]?.toBase58()}: ${err instanceof Error ? err.message : String(err)}`,
          );
          out.push(null);
        }
      }
    }
    return out;
  }
}

/**
 * Subset of the on-chain Tournament account that the reconciliation cron
 * compares against the DB row. Anchor's BorshAccountsCoder decodes the full
 * struct; we only declare the fields we read.
 */
export interface DecodedTournament {
  organizer: PublicKey;
  name: string;
  tokenMint: PublicKey;
  vault: PublicKey;
  entryFee: { toString(): string };       // BN
  organizerDeposit: { toString(): string }; // BN
  organizerDepositRefunded: boolean;
  maxParticipants: number;
  bracketSize: number;
  participantCount: number;
  matchesInitialized: number;
  matchesReported: number;
  totalMatches: number;
  registrationDeadline: { toString(): string };
  createdAt: { toString(): string };
  startedAt: { toString(): string };
  completedAt: { toString(): string };
  status: { [variant: string]: object };
  payoutPreset: { [variant: string]: object };
  champion: PublicKey;
}

function maskUrl(url: string): string {
  // Strip API key from query string for logs
  return url.replace(/(\?|&)api-key=[^&]+/i, '$1api-key=***');
}
