import { Injectable, Logger } from '@nestjs/common';
import { type Address, type Instruction } from '@solana/kit';
import { Connection, PublicKey } from '@solana/web3.js';
import { AnchorUtils, PullFeed } from '@switchboard-xyz/on-demand';

import { lutsToKitAddressesByLut, toKitInstruction } from './web3-kit';

export interface FeedUpdateKitIxs {
  ixs: Instruction[];
  lookupTables: Record<Address, Address[]>;
}

@Injectable()
export class SwitchboardFeedService {
  private readonly logger = new Logger(SwitchboardFeedService.name);
  private connection?: Connection;
  private program?: Awaited<
    ReturnType<typeof AnchorUtils.loadProgramFromConnection>
  >;

  private async getProgram(): Promise<
    Awaited<ReturnType<typeof AnchorUtils.loadProgramFromConnection>>
  > {
    if (this.program) return this.program;
    const rpcUrl = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
    this.connection ??= new Connection(rpcUrl, 'confirmed');
    this.program = await AnchorUtils.loadProgramFromConnection(this.connection);
    this.logger.log(
      `Switchboard On-Demand program loaded (${this.program.programId.toBase58()})`,
    );
    return this.program;
  }

  async buildFeedUpdateKitIxs(
    feedAddress: string,
    payer: string,
    numSignatures: number,
  ): Promise<FeedUpdateKitIxs> {
    const program = await this.getProgram();
    const feed = new PullFeed(program, new PublicKey(feedAddress));

    const [updateIxs, , numSuccess, luts, errors] = await feed.fetchUpdateIx({
      numSignatures,
      payer: new PublicKey(payer),
    });

    if (!updateIxs || updateIxs.length === 0 || numSuccess < numSignatures) {
      const detail =
        errors?.filter(Boolean).join('; ') ||
        `${numSuccess}/${numSignatures} oracle responses`;
      throw new Error(`feed update unavailable: ${detail}`);
    }

    return {
      ixs: updateIxs.map(toKitInstruction),
      lookupTables: lutsToKitAddressesByLut(luts ?? []),
    };
  }
}
