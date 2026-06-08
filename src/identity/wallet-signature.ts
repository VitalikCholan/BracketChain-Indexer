/**
 * Ed25519 wallet-signature verification for the Steam-link flow (A11-2).
 *
 * The `/identity/steam/login` endpoint requires the caller to prove control of
 * the wallet they want to bind, by signing `bracketchain:bind-steam:<wallet>:
 * <nonce>` with that wallet. Embedding the wallet in the signed message means
 * swapping the `wallet` query param invalidates the signature — closing the
 * "bind Steam to a wallet you don't own" grief vector (A-11 security gate).
 *
 * Self-contained on purpose: a tiny base58 decoder + WebCrypto Ed25519 (both
 * available in plain Node, no ESM-only @solana/kit import). Verification is
 * total — any malformed input resolves to `false`, never throws.
 */

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < BASE58_ALPHABET.length; i++) m[BASE58_ALPHABET[i]] = i;
  return m;
})();

/** Decode a base58 (Bitcoin alphabet) string to bytes; null on bad input. */
function base58Decode(s: string): Uint8Array | null {
  if (s.length === 0) return new Uint8Array(0);
  const bytes: number[] = [0];
  for (const ch of s) {
    const val = BASE58_MAP[ch];
    if (val === undefined) return null;
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Leading '1' chars encode leading zero bytes.
  for (let k = 0; k < s.length && s[k] === '1'; k++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

/**
 * Verify that `signatureBase58` is `wallet`'s Ed25519 signature over `message`.
 *
 * @param wallet           base58 Solana address (32-byte Ed25519 public key)
 * @param message          the exact UTF-8 string that was signed
 * @param signatureBase58  base58-encoded 64-byte signature
 */
export async function verifyWalletSignature(
  wallet: string,
  message: string,
  signatureBase58: string,
): Promise<boolean> {
  const pub = base58Decode(wallet);
  const sig = base58Decode(signatureBase58);
  if (!pub || !sig || pub.length !== 32 || sig.length !== 64) return false;

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      // Cast only papers over lib.dom's SharedArrayBuffer-inclusive BufferSource.
      pub as unknown as BufferSource,
      { name: 'Ed25519' },
      /* extractable */ false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      sig as unknown as BufferSource,
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}
