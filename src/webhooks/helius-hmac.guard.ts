import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import type { Request } from 'express';

type RawRequest = Request & { rawBody?: Buffer };

@Injectable()
export class HeliusHmacGuard implements CanActivate {
  private readonly logger = new Logger(HeliusHmacGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const secret = process.env.HELIUS_WEBHOOK_SECRET;
    if (!secret) {
      this.logger.error(
        'HELIUS_WEBHOOK_SECRET is not set — rejecting webhook request',
      );
      throw new UnauthorizedException('webhook secret not configured');
    }

    const req = context.switchToHttp().getRequest<RawRequest>();
    const header =
      req.header('x-helius-signature') ?? req.header('authorization');

    if (!header) {
      throw new UnauthorizedException('missing signature header');
    }

    if (!req.rawBody) {
      this.logger.error(
        'req.rawBody is empty — NestFactory must be created with { rawBody: true }',
      );
      throw new UnauthorizedException(
        'cannot verify signature without raw body',
      );
    }

    const provided = header.replace(/^Bearer\s+/i, '').trim();
    const expected = createHmac('sha256', secret)
      .update(req.rawBody)
      .digest('hex');

    let providedBuf: Buffer;
    let expectedBuf: Buffer;
    try {
      providedBuf = Buffer.from(provided, 'hex');
      expectedBuf = Buffer.from(expected, 'hex');
    } catch {
      throw new UnauthorizedException('invalid signature encoding');
    }

    if (
      providedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(providedBuf, expectedBuf)
    ) {
      throw new UnauthorizedException('invalid signature');
    }

    return true;
  }
}
