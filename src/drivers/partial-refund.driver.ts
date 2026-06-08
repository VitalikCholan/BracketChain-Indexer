import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  BracketChainClient,
  getTournament,
  partialRefundChunk,
} from '@bracketchain/sdk';

import { TournamentStatus } from '../generated/prisma';
import { KeychainService, type KeyRole } from '../keys/keychain.service';
import { PrismaService } from '../prisma.service';
import { PermissionlessDriver } from './permissionless-driver';

@Injectable()
export class PartialRefundDriver extends PermissionlessDriver {
  protected readonly driverName = 'partial-refund';
  protected readonly role: KeyRole = 'refund-payer';

  private static readonly MAX_PER_TICK = 5;
  private client?: BracketChainClient;

  constructor(
    keychain: KeychainService,
    private readonly prisma: PrismaService,
  ) {
    super(keychain);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async handle(): Promise<void> {
    await this.drive();
  }

  protected async tick(): Promise<void> {
    const due = await this.prisma.tournament.findMany({
      where: { status: TournamentStatus.PartialCancelled },
      select: { address: true },
      orderBy: { completedAt: 'asc' },
      take: PartialRefundDriver.MAX_PER_TICK,
    });
    if (due.length === 0) return;

    const client = await this.getClient();
    this.logger.log(
      `partial-refund: ${due.length} partially-cancelled tournament(s)`,
    );

    let processed = 0;
    for (const t of due) {
      try {
        if (await this.refundOne(client, t.address)) processed++;
      } catch (err) {
        this.logger.warn(
          `partial-refund: skip ${t.address} — ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(`partial-refund: processed ${processed}/${due.length}`);
  }

  /** Drive refunds for one tournament. Returns false when nothing was submitted. */
  private async refundOne(
    client: BracketChainClient,
    address: string,
  ): Promise<boolean> {
    const tournamentPda = address as never;
    // Throws if the tournament PDA is already closed (post rent-reclaim).
    await getTournament(client, tournamentPda);

    const { refundsSubmitted, txSignatures } = await partialRefundChunk(
      client,
      {
        tournamentPda,
      },
    );
    if (refundsSubmitted === 0 && txSignatures.length === 0) return false;
    this.logger.log(
      `partial-refund: ${address} refunds=${refundsSubmitted} txs=${txSignatures.length}`,
    );
    return true;
  }

  /** Build (and cache) the signing SDK client for the `refund-payer` role. */
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
