import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type {
  Match,
  Participant,
  Payout,
  Tournament,
  TournamentStatus,
} from '../generated/prisma';

export type TournamentWithCount = Tournament & { participantCount: number };

@Injectable()
export class TournamentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lookup whether (organizer, name) is already taken. Uses `findFirst`
   * rather than `findUnique` because the schema has no composite unique
   * on (organizer, name) — the constraint is enforced on-chain by PDA
   * derivation (`[b"tournament", organizer, name]`), so the DB cannot
   * contain duplicates barring an indexer bug. `@@index([organizer])`
   * keeps this query cheap.
   */
  async checkName(
    organizer: string,
    name: string,
  ): Promise<{ taken: boolean; address?: string }> {
    const row = await this.prisma.tournament.findFirst({
      where: { organizer, name },
      select: { address: true },
    });
    return row ? { taken: true, address: row.address } : { taken: false };
  }

  async list(params: {
    status?: TournamentStatus;
    limit?: number;
  }): Promise<TournamentWithCount[]> {
    const { status, limit = 20 } = params;
    const rows = await this.prisma.tournament.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { _count: { select: { participants: true } } },
    });
    return rows.map(({ _count, ...rest }) => ({
      ...rest,
      participantCount: _count.participants,
    }));
  }

  /**
   * Phase 5.3: single-tournament read for SWR detail-page path.
   * Throws NotFoundException if address is unknown — frontend SWR layer
   * catches and falls back to chain.
   */
  async getOne(address: string): Promise<TournamentWithCount> {
    const row = await this.prisma.tournament.findUnique({
      where: { address },
      include: { _count: { select: { participants: true } } },
    });
    if (!row) {
      throw new NotFoundException(`Tournament ${address} not found`);
    }
    const { _count, ...rest } = row;
    return { ...rest, participantCount: _count.participants };
  }

  async getPayouts(address: string): Promise<Payout[]> {
    await this.assertTournamentExists(address);
    return this.prisma.payout.findMany({
      where: { tournamentAddress: address },
      orderBy: [{ kind: 'asc' }, { placement: 'asc' }],
    });
  }

  async getParticipants(address: string): Promise<Participant[]> {
    await this.assertTournamentExists(address);
    return this.prisma.participant.findMany({
      where: { tournamentAddress: address },
      orderBy: { seedIndex: 'asc' },
    });
  }

  async getMatches(address: string): Promise<Match[]> {
    await this.assertTournamentExists(address);
    return this.prisma.match.findMany({
      where: { tournamentAddress: address },
      orderBy: [{ round: 'asc' }, { matchIndex: 'asc' }],
    });
  }

  private async assertTournamentExists(address: string): Promise<void> {
    const tournament = await this.prisma.tournament.findUnique({
      where: { address },
      select: { address: true },
    });
    if (!tournament) {
      throw new NotFoundException(`Tournament ${address} not found`);
    }
  }
}
