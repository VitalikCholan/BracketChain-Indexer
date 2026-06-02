import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BracketChainClient, proposeResultOracle } from '@bracketchain/sdk';

import { MatchStatus, ProposalSource } from '../generated/prisma';
import { KeychainService, type KeyRole } from '../keys/keychain.service';
import { PrismaService } from '../prisma.service';
import { PermissionlessDriver } from './permissionless-driver';

/**
 * C-9 — oracle-relayer cron (V1.2 Oracle settlement).
 *
 * Scans for Active matches with a Switchboard feed bound (`switchboardFeed`
 * non-null, `proposalSource = None`) and pushes `propose_result_oracle` for
 * each, opening the dispute window with `source = Oracle`. Permissionless —
 * trust bottoms out in the feed account contents; the program enforces
 * freshness (`max_stale_slots`, `min_oracle_samples` from `ProtocolConfig`),
 * so the cron does not pre-check and simply retries next tick on rejection.
 *
 * Shares the `claim-payer` signing role (per `KEY_ROLES`: "claim_result +
 * propose_result_oracle (V1 / V1.2)").
 */
@Injectable()
export class OracleRelayerDriver extends PermissionlessDriver {
  protected readonly driverName = 'oracle-relayer';
  protected readonly role: KeyRole = 'claim-payer';

  private static readonly MAX_PER_TICK = 25;

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
      // L-1: skip a match we already pushed propose_result_oracle for last tick
      // if it's still showing Active/None in the cache (the proposal hasn't
      // re-indexed yet) — avoids a second redundant tx into the same window.
      const key = `${m.tournamentAddress}:${m.bracket}:${m.round}:${m.matchIndex}`;
      if (this.recentlyActed(key)) continue;
      try {
        await this.proposeOne(client, m);
        this.markActed(key);
        proposed++;
      } catch (err) {
        // Per-match isolation: a stale row (already proposed but not re-indexed),
        // a feed not yet fresh, or a transient RPC error must not abort the rest
        // of the tick. The next tick re-evaluates from fresh cache state.
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
    // `as never` bridges the linked-kit module boundary, same pattern as the
    // other drivers. Runtime values are plain base58 strings.
    const { txSignature } = await proposeResultOracle(client, {
      tournamentPda: m.tournamentAddress as never,
      bracket: m.bracket,
      round: m.round,
      matchIndex: m.matchIndex,
      switchboardFeed: m.switchboardFeed as never,
    });
    this.logger.log(
      `oracle-relayer: proposed ${m.tournamentAddress} b${m.bracket}r${m.round}m${m.matchIndex} tx=${txSignature}`,
    );
  }

  /** Build (and cache) the signing SDK client for the `claim-payer` role. */
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
      signer: signer as never,
      programAddress: programId as never,
      commitment: 'confirmed',
    });
    return this.client;
  }
}
