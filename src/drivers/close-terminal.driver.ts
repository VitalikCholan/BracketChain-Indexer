import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  BracketChainClient,
  closeTournament,
  getAllMatches,
  getTournament,
  listParticipants,
} from '@bracketchain/sdk';

import { TournamentStatus } from '../generated/prisma';
import { KeychainService, type KeyRole } from '../keys/keychain.service';
import { PrismaService } from '../prisma.service';
import { PermissionlessDriver } from './permissionless-driver';

/** Terminal tournaments become eligible for rent reclaim after this age. */
const CLOSE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (gate G7)

/**
 * D-4 — close-terminal cron. Reclaims account rent for terminal tournaments
 * older than 7 days via the permissionless `close_tournament` (signed by the
 * `cleanup-payer` role), so the original organizer recovers ~95% of their
 * deposited rent (gate G7).
 *
 * Selection comes from the read-cache (`status` terminal + `completedAt` past
 * the 7-day cutoff); the child PDAs to close are read authoritatively from
 * chain via the SDK (`listParticipants` + `getAllMatches`), then handed to
 * `closeTournament({ closeRoot: true })` which chunks the children and closes
 * the vault + Tournament PDA last. Idempotent: a fully-closed tournament no
 * longer fetches on-chain, so `getTournament` throws and the entry is skipped.
 */
@Injectable()
export class CloseTerminalDriver extends PermissionlessDriver {
  protected readonly driverName = 'close-terminal';
  protected readonly role: KeyRole = 'cleanup-payer';

  /** Max tournaments closed per tick — bounds RPC + tx load on one pass. */
  private static readonly MAX_PER_TICK = 5;

  /** Built once on first actionable tick (needs the async keychain signer). */
  private client?: BracketChainClient;

  constructor(
    keychain: KeychainService,
    private readonly prisma: PrismaService,
  ) {
    super(keychain);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async handle(): Promise<void> {
    await this.drive();
  }

  protected async tick(): Promise<void> {
    const cutoff = new Date(Date.now() - CLOSE_AFTER_MS);
    const due = await this.prisma.tournament.findMany({
      where: {
        status: {
          in: [TournamentStatus.Completed, TournamentStatus.Cancelled],
        },
        completedAt: { lte: cutoff },
      },
      select: { address: true },
      orderBy: { completedAt: 'asc' },
      take: CloseTerminalDriver.MAX_PER_TICK,
    });
    if (due.length === 0) return;

    const client = await this.getClient();
    this.logger.log(
      `close-terminal: ${due.length} terminal tournament(s) past the 7-day cutoff`,
    );

    let closed = 0;
    for (const t of due) {
      try {
        if (await this.closeOne(client, t.address)) closed++;
      } catch (err) {
        // Isolate per-tournament: an already-closed tournament (on-chain gone,
        // DB row lingers) throws on fetch — skip it, don't abort the tick.
        this.logger.warn(
          `close-terminal: skip ${t.address} — ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(`close-terminal: closed ${closed}/${due.length}`);
  }

  /** Close one terminal tournament's accounts. Returns false if nothing to do. */
  private async closeOne(
    client: BracketChainClient,
    address: string,
  ): Promise<boolean> {
    // `as never` bridges the SDK's own (pnpm-linked) branded address type, same
    // pattern as auto-claim.driver. Runtime values are plain base58 strings.
    const tournamentPda = address as never;

    // Throws if the Tournament PDA is already closed — caught by the caller and
    // logged as a skip (idempotency via on-chain state).
    await getTournament(client, tournamentPda);

    const [participants, matches] = await Promise.all([
      listParticipants(client, tournamentPda),
      getAllMatches(client, tournamentPda),
    ]);
    const childPdas = [
      ...participants.map((p) => p.address),
      ...matches.map((m) => m.address),
    ];

    const { childrenSubmitted, rootClosed, txSignatures } =
      await closeTournament(client, {
        tournamentPda,
        childPdas,
        closeRoot: true,
      });
    this.logger.log(
      `close-terminal: closed ${address} children=${childrenSubmitted} ` +
        `root=${rootClosed} txs=${txSignatures.length}`,
    );
    return true;
  }

  /** Build (and cache) the signing SDK client for the `cleanup-payer` role. */
  private async getClient(): Promise<BracketChainClient> {
    if (this.client) return this.client;
    const rpcUrl = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
    const wsUrl = process.env.RPC_WS_URL ?? rpcUrl.replace(/^http/, 'ws');
    const programId = process.env.PROGRAM_ID;
    if (!programId) throw new Error('PROGRAM_ID env var is required');
    const signer = await this.signer();
    this.client = new BracketChainClient({
      rpc: rpcUrl,
      rpcSubscriptions: wsUrl,
      signer: signer,
      programAddress: programId as never,
      commitment: 'confirmed',
    });
    return this.client;
  }
}
