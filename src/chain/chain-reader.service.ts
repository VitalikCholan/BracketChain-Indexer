import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  BorshAccountsCoder,
  BorshCoder,
  EventParser,
  Idl,
} from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';

import idlJson from '../idl/bracket_chain.json';
import { PayoutKind } from '../generated/prisma';

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
  /// Event decoder for the M-2 payout-replay path (reconstructs Payout rows
  /// from a dropped TournamentCompleted webhook by re-parsing the on-chain tx).
  private eventParser!: EventParser;
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
    this.eventParser = new EventParser(
      this.programId,
      new BorshCoder(idlJson as Idl),
    );

    this.logger.log(
      `ChainReader initialized — rpc=${maskUrl(rpcUrl)}, programId=${programIdStr}`,
    );
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
      const infos = await this.connection.getMultipleAccountsInfo(
        slice,
        'confirmed',
      );
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
          // Account name MUST match the IDL exactly (case-sensitive).
          // BorshAccountsCoder does a strict `idl.accounts.find(a => a.name === name)`;
          // mismatch throws "Account not found: <name>", which earlier looked
          // like a closed-account / chain-state issue but was actually a TS-side
          // map miss that broke every chain read since the cron shipped.
          const decoded = this.coder.decode<DecodedTournament>(
            'Tournament',
            info.data,
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

  /**
   * M-2: reconstruct a completed tournament's Payout rows from chain when the
   * `TournamentCompleted` webhook was dropped (reconciliation backfills the
   * status, but the Payout table is left empty and the UI shows "Pending"
   * forever). The per-placement breakdown lives ONLY in the event — no account
   * retains it — so we replay the completion transaction and re-parse its logs.
   *
   * `knownSig` is the cached `completedTxSig` when the completion webhook
   * arrived but yielded 0 payouts; when the webhook was fully dropped it is
   * null and we scan the PDA's recent signatures for the completion tx.
   *
   * Returns null when no completion event can be found, or when the event
   * predates `placement_payouts` (pre-upgrade events carried no breakdown —
   * unrecoverable from logs alone). Derivation mirrors
   * HeliusParserService.handleTournamentCompleted; kept in sync deliberately.
   */
  async fetchCompletionPayouts(
    pda: PublicKey,
    knownSig: string | null,
  ): Promise<{ txSignature: string; payouts: ReconstructedPayout[] } | null> {
    const pdaStr = pda.toBase58();
    const signatures = knownSig
      ? [knownSig]
      : (await this.connection.getSignaturesForAddress(pda, { limit: 25 }))
          .filter((s) => !s.err)
          .map((s) => s.signature);

    for (const sig of signatures) {
      const tx = await this.connection.getTransaction(sig, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      const logs = tx?.meta?.logMessages;
      if (!logs || logs.length === 0) continue;

      for (const evt of this.eventParser.parseLogs(logs)) {
        if (evt.name !== 'TournamentCompleted') continue;
        const d = evt.data as Record<string, unknown>;
        if (eventPubkey(d.tournament) !== pdaStr) continue;

        const fee = eventBigInt(d.fee_amount);
        const payouts: ReconstructedPayout[] = [];
        for (const p of parsePlacementPayouts(d.placement_payouts)) {
          payouts.push({
            recipient: p.recipient,
            amount: p.amount,
            kind: PayoutKind.Prize,
            placement: p.place,
          });
        }
        const treasury =
          d.treasury_recipient != null
            ? eventPubkey(d.treasury_recipient)
            : null;
        if (treasury && fee > 0n) {
          payouts.push({
            recipient: treasury,
            amount: fee,
            kind: PayoutKind.Fee,
            placement: null,
          });
        }
        return payouts.length > 0 ? { txSignature: sig, payouts } : null;
      }
    }
    return null;
  }
}

/** A Payout row reconstructed from a replayed TournamentCompleted event (M-2). */
export interface ReconstructedPayout {
  recipient: string;
  amount: bigint;
  kind: PayoutKind;
  placement: number | null;
}

// ── event-decode helpers (mirror helius-parser.service.ts coercers) ──────────

function eventPubkey(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof PublicKey) return value.toBase58();
  if (
    value &&
    typeof (value as { toString?: () => string }).toString === 'function'
  ) {
    return (value as { toString: () => string }).toString();
  }
  throw new Error('cannot coerce value to pubkey string');
}

function eventBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' || typeof value === 'string')
    return BigInt(value);
  if (
    value &&
    typeof (value as { toString?: () => string }).toString === 'function'
  ) {
    return BigInt((value as { toString: () => string }).toString());
  }
  return 0n;
}

function parsePlacementPayouts(
  raw: unknown,
): Array<{ place: number; recipient: string; amount: bigint }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ place: number; recipient: string; amount: bigint }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    try {
      const place =
        typeof e.place === 'number'
          ? e.place
          : Number((e.place as { toString(): string }).toString());
      out.push({
        place,
        recipient: eventPubkey(e.recipient),
        amount: eventBigInt(e.amount),
      });
    } catch {
      // Skip malformed rows — best-effort.
    }
  }
  return out;
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
  entryFee: { toString(): string }; // BN
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
  settlementMode: { [variant: string]: object };
  game: { [variant: string]: object };
  champion: PublicKey;
  /// VRF (Stage B). `vrfRandomnessAccount` is `Pubkey::default()` (all-1s
  /// base58) when no Switchboard randomness is bound; `seedRevealed` flips once
  /// `reveal_seed` lands. Read by the B-16 vrf-reveal cron.
  vrfRandomnessAccount: PublicKey;
  vrfCommitSlot: { toString(): string }; // BN (u64)
  seedRevealed: boolean;
}

function maskUrl(url: string): string {
  // Strip API key from query string for logs
  return url.replace(/(\?|&)api-key=[^&]+/i, '$1api-key=***');
}
