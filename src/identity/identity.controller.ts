import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IdentityService } from './identity.service';
import { NonceStore } from './nonce.store';
import { SteamOpenIdService } from './steam-openid.service';
import { verifyWalletSignature } from './wallet-signature';

/** First configured frontend origin — fallback target for callback redirects. */
function frontendFallback(): string {
  return (process.env.FRONTEND_ORIGIN ?? 'http://localhost:3001')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)[0];
}

/**
 * Constrain a caller-supplied `returnTo` to a configured frontend origin so the
 * callback can't be abused as an open redirector. Relative paths and URLs whose
 * origin is in `FRONTEND_ORIGIN` pass through; anything else falls back to the
 * frontend root.
 */
function safeReturnTo(candidate: string | undefined): string {
  const fallback = frontendFallback();
  if (!candidate) return fallback;
  try {
    const url = new URL(candidate, fallback);
    const allowed = (process.env.FRONTEND_ORIGIN ?? fallback)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowed.some((o) => url.origin === new URL(o).origin)) {
      return url.toString();
    }
  } catch {
    /* fall through */
  }
  return fallback;
}

/** Append `?steam=<status>` (+ extras) to a return URL. */
function withStatus(
  returnTo: string,
  status: string,
  extra?: Record<string, string>,
): string {
  const url = new URL(returnTo, frontendFallback());
  url.searchParams.set('steam', status);
  for (const [k, v] of Object.entries(extra ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

@Controller('identity')
export class IdentityController {
  constructor(
    private readonly identity: IdentityService,
    private readonly steam: SteamOpenIdService,
    private readonly nonces: NonceStore,
  ) {}

  /**
   * `GET /identity/steam/login` — entry point for the indexer-owned Steam link
   * flow (A11-5, Option B). The browser arrives here after the wallet signs
   * `bracketchain:bind-steam:<wallet>:<nonce>`; we re-verify that signature
   * (the wallet is embedded, so swapping the `wallet` param breaks it — A-11
   * security gate), stash the pending bind under the nonce, and 302 to Steam.
   *
   * Declared before `:wallet/:game` — Nest resolves routes top-to-bottom and a
   * param route would otherwise swallow `steam/login`.
   */
  @Get('steam/login')
  async steamLogin(
    @Query('wallet') wallet: string,
    @Query('nonce') nonce: string,
    @Query('sig') sig: string,
    @Query('returnTo') returnTo: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!wallet || !nonce || !sig) {
      res.status(400).json({ error: 'wallet, nonce and sig are required' });
      return;
    }
    const message = `bracketchain:bind-steam:${wallet}:${nonce}`;
    const ok = await verifyWalletSignature(wallet, message, sig);
    if (!ok) {
      res.status(403).json({ error: 'wallet signature verification failed' });
      return;
    }
    this.nonces.put(nonce, { wallet, returnTo: safeReturnTo(returnTo) });
    res.redirect(this.steam.buildLoginUrl(nonce));
  }

  /**
   * `GET /identity/steam/callback` — Steam returns here. Re-verify the
   * assertion server-side, single-use-consume the nonce (replay → unknown),
   * issue the SAS attestation, then 302 back to the originating page with
   * `?steam=<status>`. Every failure path redirects with a status the UI maps
   * to a toast; nothing is trusted from the client `openid.*` params.
   */
  @Get('steam/callback')
  async steamCallback(
    @Query() query: Record<string, string>,
    @Res() res: Response,
  ): Promise<void> {
    const entry = this.nonces.consume(query.n);
    if (!entry) {
      // Unknown/expired/replayed nonce — we have no trusted returnTo, so land
      // on the frontend root with an explanatory status.
      res.redirect(withStatus(frontendFallback(), 'expired'));
      return;
    }

    const steamId64 = await this.steam.verifyCallback(query);
    if (!steamId64) {
      res.redirect(withStatus(entry.returnTo, 'invalid'));
      return;
    }

    try {
      await this.identity.issueSteamAttestation(entry.wallet, steamId64);
    } catch {
      res.redirect(
        withStatus(entry.returnTo, 'attest_failed', { steamId: steamId64 }),
      );
      return;
    }
    res.redirect(withStatus(entry.returnTo, 'linked', { steamId: steamId64 }));
  }

  /**
   * `GET /identity/:wallet/:game` — read-only attestation lookup (A11-1). No
   * wallet signature: this is public on-chain data. Used by the join flow to
   * prefetch the attestation PDA and by the UI to show linked/not-linked.
   */
  @Get(':wallet/:game')
  async getGameIdentity(
    @Param('wallet') wallet: string,
    @Param('game') game: string,
  ) {
    return this.identity.getGameIdentity(wallet, game);
  }
}
