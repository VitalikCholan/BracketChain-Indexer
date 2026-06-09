import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BracketChainClient, proposeResultOracle } from '@bracketchain/sdk';

import { MatchStatus, ProposalSource } from '../generated/prisma';
import { KeychainService, type KeyRole } from '../keys/keychain.service';
import { PrismaService } from '../prisma.service';
import { SwitchboardFeedService } from '../switchboard/switchboard-feed.service';
import { PermissionlessDriver } from './permissionless-driver';

@Injectable()
export class OracleRelayerDriver extends PermissionlessDriver {
  protected readonly driverName = 'oracle-relayer';
  protected readonly role: KeyRole = 'claim-payer';

  private static readonly MAX_PER_TICK = 25;

  private static readonly BUNDLED_TX_COMPUTE_UNITS = 400_000;

  private client?: BracketChainClient;

  constructor(
    keychain: KeychainService,
    private readonly prisma: PrismaService,
    private readonly feeds: SwitchboardFeedService,
  ) {
    super(keychain);
  }

  private numSignatures(): number {
    const n = Number(process.env.ORACLE_NUM_SIGNATURES ?? '1');
    return Number.isInteger(n) && n > 0 ? n : 1;
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async handle(): Promise<void> {
    await this.drive();
  }

  protected async tick(): Promise<void> {
    const due = await this.prisma.match.findMany({
      where: {
        status: MatchStatus.Active,
        proposalSource: ProposalSource.None,
        switchboardFeed: { not: null },
      },
      select: {
        tournamentAddress: true,
        bracket: true,
        round: true,
        matchIndex: true,
        switchboardFeed: true,
      },
      orderBy: { committedAt: 'asc' },
      take: OracleRelayerDriver.MAX_PER_TICK,
    });
    if (due.length === 0) return;

    const client = await this.getClient();
    this.logger.log(`oracle-relayer: ${due.length} match(es) with bound feed`);

    let proposed = 0;
    for (const m of due) {
      const key = `${m.tournamentAddress}:${m.bracket}:${m.round}:${m.matchIndex}`;
      if (this.recentlyActed(key)) continue;
      try {
        await this.proposeOne(client, m);
        this.markActed(key);
        proposed++;
      } catch (err) {
        this.logger.warn(
          `oracle-relayer: skip ${m.tournamentAddress} b${m.bracket}r${m.round}m${m.matchIndex} — ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(`oracle-relayer: proposed ${proposed}/${due.length}`);
  }

  private async proposeOne(
    client: BracketChainClient,
    m: {
      tournamentAddress: string;
      bracket: number;
      round: number;
      matchIndex: number;
      switchboardFeed: string | null;
    },
  ): Promise<void> {
    const update = await this.feeds.buildFeedUpdateKitIxs(
      m.switchboardFeed!,
      String(client.signer!.address),
      this.numSignatures(),
    );

    const { txSignature } = await proposeResultOracle(client, {
      tournamentPda: m.tournamentAddress as never,
      bracket: m.bracket,
      round: m.round,
      matchIndex: m.matchIndex,
      switchboardFeed: m.switchboardFeed as never,
      preInstructions: update.ixs,
      lookupTables: update.lookupTables,
      computeUnits: OracleRelayerDriver.BUNDLED_TX_COMPUTE_UNITS,
    });
    this.logger.log(
      `oracle-relayer: proposed ${m.tournamentAddress} b${m.bracket}r${m.round}m${m.matchIndex} tx=${txSignature}`,
    );
  }

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
