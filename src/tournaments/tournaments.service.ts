import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type {
  Match,
  Participant,
  Payout,
  Tournament,
  TournamentStatus,
} from '../generated/prisma';

@Injectable()
export class TournamentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: { status?: TournamentStatus; limit?: number }): Promise<Tournament[]> {
    const { status, limit = 20 } = params;
    return this.prisma.tournament.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Phase 5.3: single-tournament read for SWR detail-page path.
   * Throws NotFoundException if address is unknown — frontend SWR layer
   * catches and falls back to chain.
   */
  async getOne(address: string): Promise<Tournament> {
    const row = await this.prisma.tournament.findUnique({ where: { address } });
    if (!row) {
      throw new NotFoundException(`Tournament ${address} not found`);
    }
    return row;
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
