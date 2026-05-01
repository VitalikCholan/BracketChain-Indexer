import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { TournamentsController } from './tournaments.controller';
import { TournamentsService } from './tournaments.service';

@Module({
  controllers: [TournamentsController],
  providers: [TournamentsService, PrismaService],
})
export class TournamentsModule {}
