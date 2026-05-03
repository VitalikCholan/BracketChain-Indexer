import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { BorshCoder, EventParser, Idl } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

import { PrismaService } from '../prisma.service';
import {
  PayoutKind,
  PayoutPreset,
  TournamentStatus,
} from '../generated/prisma';
import type {
  HeliusTokenTransfer,
  HeliusTransaction,
  HeliusWebhookBody,
} from './dto/helius-payload.dto';

import idlJson from '../idl/bracket_chain.json';

interface ParsedEvent {
  name: string;
  data: Record<string, unknown>;
}

const PAYOUT_PRESET_BY_INDEX: Record<number, PayoutPreset> = {
  0: PayoutPreset.WinnerTakesAll,
  1: PayoutPreset.Standard,
  2: PayoutPreset.Deep,
};

@Injectable()
export class HeliusParserService implements OnModuleInit {
  private readonly logger = new Logger(HeliusParserService.name);
  private parser!: EventParser;
  private programId!: PublicKey;
  /// Optional mint filter for tokenTransfers — set via TOKEN_MINT_FILTER env
  /// (legacy: USDC_MINT). Skip transfers in other mints when narrowing the
  /// indexer to a single token. Leave unset for multi-token indexing.
  private tokenMintFilter: string | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    const programIdStr = process.env.PROGRAM_ID;
    if (!programIdStr) {
      throw new Error('PROGRAM_ID env var is required');
    }
    this.programId = new PublicKey(programIdStr);
    const coder = new BorshCoder(idlJson as Idl);
    this.parser = new EventParser(this.programId, coder);
    // Back-compat: fall back to legacy USDC_MINT env if TOKEN_MINT_FILTER unset.
    this.tokenMintFilter = process.env.TOKEN_MINT_FILTER ?? process.env.USDC_MINT ?? null;
    this.logger.log(`Initialized parser for program ${this.programId.toBase58()}`);
  }

  async processBatch(body: HeliusWebhookBody): Promise<{ processed: number; events: number }> {
    let eventCount = 0;
    for (const tx of body) {
      try {
        eventCount += await this.processTransaction(tx);
      } catch (err) {
        this.logger.error(
          `Failed to process tx ${tx.signature ?? 'unknown'}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { processed: body.length, events: eventCount };
  }

  private async processTransaction(tx: HeliusTransaction): Promise<number> {
    if (tx.transactionError || tx.meta?.err) {
      return 0;
    }
    const signature = extractSignature(tx);
    if (!signature) {
      this.logger.warn('Skipping tx without signature');
      return 0;
    }

    const logs = extractLogs(tx);
    if (!logs || logs.length === 0) {
      return 0;
    }

    const events = Array.from(this.parser.parseLogs(logs)) as ParsedEvent[];
    if (events.length === 0) return 0;

    let handled = 0;
    for (const evt of events) {
      switch (evt.name) {
        case 'TournamentCreated':
          await this.handleTournamentCreated(evt.data, tx, signature);
          handled++;
          break;
        case 'TournamentCompleted':
          await this.handleTournamentCompleted(evt.data, tx, signature);
          handled++;
          break;
        case 'RefundIssued':
          await this.handleRefundIssued(evt.data, signature);
          handled++;
          break;
        default:
          // Other events (ParticipantRegistered, MatchReported, TournamentStarted,
          // TournamentCancelled) are not indexed in lean MVP — see plan.
          break;
      }
    }
    return handled;
  }

  // ── handlers ──────────────────────────────────────────────────────────────

  private async handleTournamentCreated(
    data: Record<string, unknown>,
    tx: HeliusTransaction,
    signature: string,
  ): Promise<void> {
    const address = pubkeyToString(data.tournament);
    const organizer = pubkeyToString(data.organizer);
    // Event field is `token_mint` (snake_case in IDL). Always was — earlier
    // indexer code read `data.usdc_mint` which was a latent bug because the
    // Rust event struct named it `token_mint` from day one (multi-token-ready).
    const tokenMint = pubkeyToString(data.token_mint);
    const entryFee = toBigInt(data.entry_fee);
    // Phase 2.5: organizer's optional top-up to the prize pool. Defaults to 0
    // for back-compat with re-played pre-2.5 events (where the field is absent).
    const organizerDeposit = data.organizer_deposit !== undefined
      ? toBigInt(data.organizer_deposit)
      : 0n;
    const maxParticipants = toNumber(data.max_participants);
    const presetIndex = toNumber(data.payout_preset);
    const payoutPreset = PAYOUT_PRESET_BY_INDEX[presetIndex];
    const registrationDeadlineSec = toNumber(data.registration_deadline);

    if (!payoutPreset) {
      throw new Error(`Unknown payoutPreset index ${presetIndex} in tx ${signature}`);
    }

    // Name isn't in the event — read it later if needed. For now, store empty
    // string. Frontend that needs it can fetch the on-chain account.
    // (Trade-off: saves us a CPI / RPC call here.)
    const name = '';

    // Block timestamp from Helius — fall back to now if absent.
    const txTimestamp = tx.timestamp ?? tx.blockTime;
    const createdAt = txTimestamp ? new Date(txTimestamp * 1000) : new Date();

    await this.prisma.tournament.upsert({
      where: { address },
      create: {
        address,
        organizer,
        name,
        tokenMint,
        entryFee,
        organizerDeposit,
        maxParticipants,
        payoutPreset,
        registrationDeadline: new Date(registrationDeadlineSec * 1000),
        status: TournamentStatus.Registration,
        createdAt,
        createdTxSig: signature,
      },
      update: {
        // Idempotent re-delivery: only refresh fields the source-of-truth event sets.
        organizer,
        tokenMint,
        entryFee,
        organizerDeposit,
        maxParticipants,
        payoutPreset,
        registrationDeadline: new Date(registrationDeadlineSec * 1000),
        createdTxSig: signature,
      },
    });
    this.logger.log(
      `tournamentCreated ${address} (preset=${payoutPreset}, deposit=${organizerDeposit})`,
    );
  }

  private async handleTournamentCompleted(
    data: Record<string, unknown>,
    tx: HeliusTransaction,
    signature: string,
  ): Promise<void> {
    const address = pubkeyToString(data.tournament);
    const champion = pubkeyToString(data.champion);
    const grossPool = toBigInt(data.gross_pool);
    const feeAmount = toBigInt(data.fee_amount);
    const netPool = toBigInt(data.net_pool);
    const completedAtSec = toNumber(data.completed_at);

    // Use a transaction so Tournament update + Payout inserts are atomic.
    await this.prisma.$transaction(async (txn) => {
      await txn.tournament.update({
        where: { address },
        data: {
          status: TournamentStatus.Completed,
          champion,
          grossPool,
          feeAmount,
          netPool,
          completedAt: new Date(completedAtSec * 1000),
          completedTxSig: signature,
        },
      });

      const payouts = derivePayoutsFromTransfers(tx, address, feeAmount, this.tokenMintFilter);
      if (payouts.length === 0) return;

      // createMany with skipDuplicates handles webhook redelivery via the
      // (txSignature, recipient, kind) unique index.
      await txn.payout.createMany({
        data: payouts.map((p) => ({
          tournamentAddress: address,
          recipient: p.recipient,
          amount: p.amount,
          kind: p.kind,
          placement: p.placement ?? null,
          txSignature: signature,
        })),
        skipDuplicates: true,
      });
    });
    this.logger.log(`tournamentCompleted ${address} → champion ${champion}`);
  }

  private async handleRefundIssued(
    data: Record<string, unknown>,
    signature: string,
  ): Promise<void> {
    const tournamentAddress = pubkeyToString(data.tournament);
    const recipient = pubkeyToString(data.wallet);
    const amount = toBigInt(data.amount);

    // Refund event references a tournament that may not yet be in our DB if
    // we somehow missed its TournamentCreated. Skip silently — the row will
    // get re-emitted on subsequent flow / V1 reconciliation.
    const tournament = await this.prisma.tournament.findUnique({
      where: { address: tournamentAddress },
      select: { address: true, organizer: true, organizerDeposit: true },
    });
    if (!tournament) {
      this.logger.warn(`refundIssued for unknown tournament ${tournamentAddress}, skipping`);
      return;
    }

    // Phase 2.5: cancel emits one RefundIssued per refunded participant +
    // (optionally) one for the organizer's deposit. Distinguish by
    // recipient == tournament.organizer && tournament.organizerDeposit > 0,
    // because organizer_deposit_refunded flag isn't on this event payload.
    const isOrganizerRefund =
      recipient === tournament.organizer && tournament.organizerDeposit > 0n;
    const kind = isOrganizerRefund ? PayoutKind.OrganizerRefund : PayoutKind.Refund;

    await this.prisma.payout.upsert({
      where: {
        txSignature_recipient_kind: {
          txSignature: signature,
          recipient,
          kind,
        },
      },
      create: {
        tournamentAddress,
        recipient,
        amount,
        kind,
        txSignature: signature,
      },
      update: { amount },
    });
    this.logger.log(
      `refundIssued ${tournamentAddress} → ${recipient} (${amount}, kind=${kind})`,
    );
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function extractLogs(tx: HeliusTransaction): string[] | undefined {
  return tx.meta?.logMessages ?? tx.logs ?? tx.logMessages;
}

function extractSignature(tx: HeliusTransaction): string | undefined {
  return tx.signature ?? tx.transaction?.signatures?.[0];
}

function pubkeyToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof PublicKey) return value.toBase58();
  // Anchor's BorshCoder may return PublicKey as object with `_bn` etc — fall back to string()
  if (value && typeof (value as { toString?: () => string }).toString === 'function') {
    return (value as { toString: () => string }).toString();
  }
  throw new Error(`Cannot coerce value to pubkey string: ${JSON.stringify(value)}`);
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') return BigInt(value);
  if (value instanceof BN) return BigInt(value.toString());
  if (value && typeof (value as { toString?: () => string }).toString === 'function') {
    return BigInt((value as { toString: () => string }).toString());
  }
  throw new Error(`Cannot coerce value to bigint: ${JSON.stringify(value)}`);
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  if (value instanceof BN) return value.toNumber();
  throw new Error(`Cannot coerce value to number: ${JSON.stringify(value)}`);
}

interface DerivedPayout {
  recipient: string;
  amount: bigint;
  kind: PayoutKind;
  placement: number | null;
}

/**
 * Walk the tx's tokenTransfers and turn vault-out transfers into Payout rows.
 * Heuristic for fee: the transfer whose amount equals `feeAmount` is the
 * protocol fee; remaining transfers are prizes ordered as they appear (which
 * matches the on-chain CPI order: 1st, 2nd, 3rd, …).
 *
 * If tokenTransfers is missing (Helius "raw" webhook) we return [] — Tournament
 * row still gets the aggregate gross/fee/net from the event itself.
 */
function derivePayoutsFromTransfers(
  tx: HeliusTransaction,
  tournamentAddress: string,
  feeAmount: bigint,
  tokenMintFilter: string | null,
): DerivedPayout[] {
  const transfers = tx.tokenTransfers;
  if (!transfers || transfers.length === 0) return [];

  // Vault is owned by the Tournament PDA (token::authority = tournament).
  const fromVault = transfers.filter((t) => {
    if (t.fromUserAccount !== tournamentAddress) return false;
    if (tokenMintFilter && t.mint && t.mint !== tokenMintFilter) return false;
    return true;
  });
  if (fromVault.length === 0) return [];

  let feeAssigned = false;
  let placementCounter = 1;
  const out: DerivedPayout[] = [];

  for (const t of fromVault) {
    const amount = transferAmountToBigInt(t);
    if (amount === null) continue;
    const recipient = t.toUserAccount;
    if (!recipient) continue;

    if (!feeAssigned && amount === feeAmount) {
      out.push({ recipient, amount, kind: PayoutKind.Fee, placement: null });
      feeAssigned = true;
    } else {
      out.push({ recipient, amount, kind: PayoutKind.Prize, placement: placementCounter++ });
    }
  }
  return out;
}

function transferAmountToBigInt(t: HeliusTokenTransfer): bigint | null {
  // Prefer raw — exact, no float rounding.
  const raw = t.rawTokenAmount?.tokenAmount;
  if (raw) {
    try {
      return BigInt(raw);
    } catch {
      /* fall through */
    }
  }
  if (typeof t.tokenAmount === 'number' && t.rawTokenAmount?.decimals !== undefined) {
    const decimals = t.rawTokenAmount.decimals;
    return BigInt(Math.round(t.tokenAmount * 10 ** decimals));
  }
  return null;
}
