import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { HeliusParserService } from './helius-parser.service';
import { HeliusHmacGuard } from './helius-hmac.guard';
import type { HeliusWebhookBody } from './dto/helius-payload.dto';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly parser: HeliusParserService) {}

  @Post('helius')
  @UseGuards(HeliusHmacGuard)
  @HttpCode(200)
  async helius(
    @Body() body: HeliusWebhookBody | { transactions?: HeliusWebhookBody },
  ) {
    // Helius may wrap the array under different keys depending on webhook config.
    const txs = Array.isArray(body) ? body : (body?.transactions ?? []);
    if (!Array.isArray(txs) || txs.length === 0) {
      return { ok: true, processed: 0, events: 0 };
    }
    const result = await this.parser.processBatch(txs);
    return { ok: true, ...result };
  }
}
