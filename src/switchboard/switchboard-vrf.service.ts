import { Injectable, Logger } from '@nestjs/common';
import {
  AccountRole,
  address,
  type Instruction,
} from '@solana/kit';
import {
  Connection,
  PublicKey,
  type TransactionInstruction,
} from '@solana/web3.js';
import { AnchorUtils, Randomness } from '@switchboard-xyz/on-demand';

/**
 * Builds the Switchboard On-Demand `reveal` instruction for a bound randomness
 * account and adapts it into a `@solana/kit` `Instruction` so the B-16 cron can
 * bundle it (as a `preInstruction`) ahead of the program's `reveal_seed` in a
 * SINGLE transaction — On-Demand only exposes the revealed value in the slot it
 * is revealed (the "same-slot gotcha").
 *
 * The Switchboard SDK is built on web3.js + its own bundled Anchor; this service
 * is the boundary that keeps that legacy stack contained and hands the rest of
 * the indexer a clean kit instruction.
 */
@Injectable()
export class SwitchboardVrfService {
  private readonly logger = new Logger(SwitchboardVrfService.name);
  private connection?: Connection;
  /** Lazily-loaded Switchboard On-Demand program (Anchor). Loose-typed to avoid
   *  the bundled anchor-31 vs the indexer's anchor-0.32 type friction. */
  private program?: Awaited<
    ReturnType<typeof AnchorUtils.loadProgramFromConnection>
  >;

  /** Resolve (and cache) the web3.js connection + Switchboard program. */
  private async getProgram(): Promise<
    Awaited<ReturnType<typeof AnchorUtils.loadProgramFromConnection>>
  > {
    if (this.program) return this.program;
    const rpcUrl = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
    this.connection ??= new Connection(rpcUrl, 'confirmed');
    // Program id is resolved from the cluster (devnet/mainnet) by the SDK; no
    // wallet needed since we only build instructions, never sign here.
    this.program = await AnchorUtils.loadProgramFromConnection(this.connection);
    this.logger.log(
      `Switchboard On-Demand program loaded (${this.program.programId.toBase58()})`,
    );
    return this.program;
  }

  /**
   * Build the Switchboard reveal instruction for `randomnessAccount`, fetching
   * the oracle-signed value via the gateway, and return it as a kit instruction.
   *
   * Throws if the randomness is not yet revealable (oracle hasn't produced the
   * value) — the caller isolates that per-tournament and retries next tick.
   */
  async buildRevealKitInstruction(
    randomnessAccount: string,
    payer: string,
  ): Promise<Instruction> {
    const program = await this.getProgram();
    const randomness = new Randomness(program, new PublicKey(randomnessAccount));
    const web3Ix = await randomness.revealIx(new PublicKey(payer));
    return toKitInstruction(web3Ix);
  }
}

/** Map a web3.js account flag pair to the kit `AccountRole` enum. */
function web3RoleToKit(isSigner: boolean, isWritable: boolean): AccountRole {
  if (isSigner && isWritable) return AccountRole.WRITABLE_SIGNER;
  if (isSigner) return AccountRole.READONLY_SIGNER;
  if (isWritable) return AccountRole.WRITABLE;
  return AccountRole.READONLY;
}

/** Convert a web3.js `TransactionInstruction` to a `@solana/kit` `Instruction`. */
function toKitInstruction(ix: TransactionInstruction): Instruction {
  return {
    programAddress: address(ix.programId.toBase58()),
    accounts: ix.keys.map((k) => ({
      address: address(k.pubkey.toBase58()),
      role: web3RoleToKit(k.isSigner, k.isWritable),
    })),
    data: new Uint8Array(ix.data),
  };
}
