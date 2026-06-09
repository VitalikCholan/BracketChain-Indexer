import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PublicKey } from '@solana/web3.js';
import { BracketChainClient, revealSeed } from '@bracketchain/sdk';

import { ChainReaderService } from '../chain/chain-reader.service';
import { TournamentStatus } from '../generated/prisma';
import { KeychainService, type KeyRole } from '../keys/keychain.service';
import { PrismaService } from '../prisma.service';
import { SwitchboardCostService } from '../switchboard/switchboard-cost.service';
import { SwitchboardVrfService } from '../switchboard/switchboard-vrf.service';
import { PermissionlessDriver } from './permissionless-driver';

/** `Pubkey::default()` — the unbound sentinel for `vrf_randomness_account`. */
const DEFAULT_PUBKEY = '11111111111111111111111111111111';

/**
 * B-16 — vrf-reveal cron. Reveals the committed Switchboard randomness for
 * tournaments that bound one (`request_seed`) but haven't revealed yet, so
 * `start_tournament` can proceed with a verifiable seed.
 *
 * The program emits **no** VRF event, so the read-cache can't track this state;
 * the cron reads it authoritatively from chain. Candidate set is narrow: only
 * pre-start tournaments (reveal must precede `start_tournament`). For each, it
 * bundles Switchboard's own reveal instruction ahead of the program's
 * `reveal_seed` in ONE tx (On-Demand's same-slot reveal), signed by `vrf-payer`.
 */
@Injectable()
export class VrfRevealDriver extends PermissionlessDriver {
  protected readonly driverName = 'vrf-reveal';
  protected readonly role: KeyRole = 'vrf-payer';

  /** Max reveals per tick. */
  private static readonly MAX_PER_TICK = 25;
  /** Cheap maturity gate before attempting a reveal; the real readiness signal
   *  is Switchboard's `revealIx` (throws until the oracle posts the value). */
  private static readonly MIN_SLOTS_AFTER_COMMIT = 1;

  private client?: BracketChainClient;

  constructor(
    keychain: KeychainService,
    private readonly prisma: PrismaService,
    private readonly chain: ChainReaderService,
    private readonly switchboard: SwitchboardVrfService,
    private readonly cost: SwitchboardCostService,
  ) {
    super(keychain);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async handle(): Promise<void> {
    await this.drive();
  }

  protected async tick(): Promise<void> {
    // Only pre-start tournaments can need a reveal (start_tournament consumes
    // the revealed seed). Read candidates from the cache, then read the
    // authoritative VRF state from chain.
    const candidates = await this.prisma.tournament.findMany({
      where: {
        status: {
          in: [
            TournamentStatus.Registration,
            TournamentStatus.PendingBracketInit,
          ],
        },
      },
      select: { address: true },
      take: VrfRevealDriver.MAX_PER_TICK,
    });
    if (candidates.length === 0) return;

    const pdas = candidates.map((c) => new PublicKey(c.address));
    const [decoded, currentSlot] = await Promise.all([
      this.chain.fetchTournaments(pdas),
      this.chain.getSlot(),
    ]);

    const pending: Array<{ address: string; randomnessAccount: string }> = [];
    for (let i = 0; i < candidates.length; i++) {
      const t = decoded[i];
      if (!t) continue;
      const randomnessAccount = t.vrfRandomnessAccount.toBase58();
      if (randomnessAccount === DEFAULT_PUBKEY) continue; // no VRF bound
      if (t.seedRevealed) continue; // already revealed
      const commitSlot = Number(t.vrfCommitSlot.toString());
      if (currentSlot <= commitSlot + VrfRevealDriver.MIN_SLOTS_AFTER_COMMIT) {
        continue; // too early — oracle hasn't resolved yet
      }
      pending.push({ address: candidates[i].address, randomnessAccount });
    }
    if (pending.length === 0) return;

    const client = await this.getClient();
    const payer = String(client.signer!.address);
    this.logger.log(
      `vrf-reveal: ${pending.length} tournament(s) awaiting reveal`,
    );

    let revealed = 0;
    for (const p of pending) {
      try {
        await this.revealOne(client, payer, p);
        revealed++;
      } catch (err) {
        // Not-yet-revealable (oracle still resolving) or transient RPC — isolate
        // and retry next tick. Switchboard's revealIx throws until ready.
        this.logger.warn(
          `vrf-reveal: skip ${p.address} — ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(`vrf-reveal: revealed ${revealed}/${pending.length}`);
  }

  private async revealOne(
    client: BracketChainClient,
    payer: string,
    p: { address: string; randomnessAccount: string },
  ): Promise<void> {
    // Build Switchboard's reveal ix and bundle it ahead of `reveal_seed` in one
    // tx (same-slot reveal). `as never` bridges the linked-kit module boundary,
    // same pattern as the auto-claim driver.
    const revealIx = await this.switchboard.buildRevealKitInstruction(
      p.randomnessAccount,
      payer,
    );
    const { txSignature } = await revealSeed(client, {
      tournamentPda: p.address as never,
      randomnessAccount: p.randomnessAccount as never,
      preInstructions: [revealIx] as never,
    });
    this.cost.recordRandomnessRequest();
    this.logger.log(`vrf-reveal: revealed ${p.address} tx=${txSignature}`);
  }

  /** Build (and cache) the signing SDK client for the `vrf-payer` role. */
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
