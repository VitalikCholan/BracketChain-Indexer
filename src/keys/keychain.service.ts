import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
// Type-only imports are erased at compile time — no CommonJS `require()` of the
// ESM-only @solana/keychain package. The runtime factory is loaded via dynamic
// import() inside getSigner(), which works from both CJS and ESM output.
import type { SolanaSigner, KeychainSignerConfig } from '@solana/keychain';

/**
 * Named signing roles for BracketChain's permissionless Phase 1 crons.
 * Each role is a distinct funded keypair so a single key compromise has a
 * bounded blast radius and per-role funding/monitoring stays legible.
 */
export const KEY_ROLES = [
  'sas-issuer', // issues SAS attestations (V1.1)
  'claim-payer', // claim_result + propose_result_oracle (V1 / V1.2)
  'vrf-payer', // reveal_seed (V1 player-reported)
  'refund-payer', // partial_refund_chunk (V1 partial-cancel)
  'cleanup-payer', // close_tournament chunks (V1 program-improvements)
] as const;

export type KeyRole = (typeof KEY_ROLES)[number];

/** Role → env var holding its base58 secret (Memory backend / devnet). */
const ROLE_ENV: Record<KeyRole, string> = {
  'sas-issuer': 'KEYCHAIN_SAS_ISSUER',
  'claim-payer': 'KEYCHAIN_CLAIM_PAYER',
  'vrf-payer': 'KEYCHAIN_VRF_PAYER',
  'refund-payer': 'KEYCHAIN_REFUND_PAYER',
  'cleanup-payer': 'KEYCHAIN_CLEANUP_PAYER',
};

/**
 * Role-based signer registry layered over `@solana/keychain`.
 *
 * The library gives us a backend-swappable {@link SolanaSigner} (Kit-compatible:
 * implements `TransactionPartialSigner` + `MessagePartialSigner`). This service
 * adds the named-role map the library does not ship, and caches one resolved
 * signer per role. Crons depend on this and call `getSigner('claim-payer')` —
 * they never touch raw key material.
 *
 * Backend is chosen by `KEYCHAIN_BACKEND` (default `memory`). Swapping to
 * `aws-kms` / `turnkey` / `privy` for mainnet is a config change here, not a
 * cron rewrite — that swap is the library's whole value proposition.
 */
@Injectable()
export class KeychainService implements OnModuleInit {
  private readonly logger = new Logger(KeychainService.name);
  private readonly cache = new Map<KeyRole, SolanaSigner>();

  /** Build the backend-tagged config for a role. Extend per backend here. */
  private buildConfig(role: KeyRole): KeychainSignerConfig {
    const backend = process.env.KEYCHAIN_BACKEND ?? 'memory';
    switch (backend) {
      case 'memory': {
        const secret = process.env[ROLE_ENV[role]];
        if (!secret || secret.trim() === '') {
          throw new Error(
            `Missing ${ROLE_ENV[role]} for role "${role}" (KEYCHAIN_BACKEND=memory)`,
          );
        }
        return { backend: 'memory', privateKeyString: secret };
      }
      default:
        // aws-kms / turnkey / privy / vault etc. are supported by the library
        // but not yet wired here — add the per-role config when productionising.
        throw new Error(
          `KEYCHAIN_BACKEND="${backend}" is not wired for role "${role}" yet. ` +
            `Only "memory" is supported on devnet — add the backend config in KeychainService.buildConfig().`,
        );
    }
  }

  /** Resolve (and cache) the signer for a role. */
  async getSigner(role: KeyRole): Promise<SolanaSigner> {
    const cached = this.cache.get(role);
    if (cached) return cached;

    const { createKeychainSigner } = await import('@solana/keychain');
    const signer = await createKeychainSigner(this.buildConfig(role));
    this.cache.set(role, signer);
    return signer;
  }

  /** Resolve every role; returns role → address. Throws on the first failure. */
  async verifyAll(): Promise<Record<KeyRole, string>> {
    const out = {} as Record<KeyRole, string>;
    for (const role of KEY_ROLES) {
      const signer = await this.getSigner(role);
      out[role] = signer.address;
    }
    return out;
  }

  /**
   * Best-effort boot verification. Logs each resolved role → address on success.
   * Non-fatal on failure (warns) so the indexer's read/webhook paths still boot
   * in key-less environments (CI, fresh clones); the hard acceptance check is
   * `scripts/verify-keychain.mjs`.
   */
  async onModuleInit(): Promise<void> {
    try {
      const resolved = await this.verifyAll();
      for (const role of KEY_ROLES) {
        this.logger.log(`role "${role}" → ${resolved[role]}`);
      }
      this.logger.log(
        `keychain ready: ${KEY_ROLES.length} roles resolved (backend=${process.env.KEYCHAIN_BACKEND ?? 'memory'})`,
      );
    } catch (err) {
      this.logger.warn(
        `keychain not fully resolved at boot: ${(err as Error).message}. ` +
          `Signing crons will fail until this is fixed; read/webhook paths are unaffected.`,
      );
    }
  }
}
