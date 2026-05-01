import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { HeliusParserService } from './helius-parser.service';
import { WebhooksController } from './webhooks.controller';

@Module({
  controllers: [WebhooksController],
  providers: [HeliusParserService, PrismaService],
})
export class WebhooksModule {}
