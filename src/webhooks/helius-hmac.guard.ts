import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
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

    // Helius sends the raw Authentication Header value as a Bearer token.
    // Compare with timing-safe equality to prevent timing attacks.
    const providedBuf = Buffer.from(provided);
    const secretBuf = Buffer.from(secret);

    if (
      providedBuf.length !== secretBuf.length ||
      !timingSafeEqual(providedBuf, secretBuf)
    ) {
      throw new UnauthorizedException('invalid signature');
    }

    return true;
  }
}
