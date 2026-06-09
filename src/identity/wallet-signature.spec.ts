import { verifyWalletSignature } from './wallet-signature';

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Minimal base58 encoder for building test fixtures (no ESM deps under jest). */
function base58Encode(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let str = '';
  for (let k = 0; k < bytes.length && bytes[k] === 0; k++) str += '1';
  for (let q = digits.length - 1; q >= 0; q--)
    str += BASE58_ALPHABET[digits[q]];
  return str;
}

/** Generate an Ed25519 keypair + base58 wallet/signature over a message. */
async function signWith(
  message: string,
): Promise<{ wallet: string; signature: string }> {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ]);
  const pub = new Uint8Array(
    await crypto.subtle.exportKey('raw', kp.publicKey),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'Ed25519' },
      kp.privateKey,
      new TextEncoder().encode(message),
    ),
  );
  return { wallet: base58Encode(pub), signature: base58Encode(sig) };
}

describe('verifyWalletSignature', () => {
  const message = 'bracketchain:bind-steam:SomeWallet:nonce-123';

  it('accepts a genuine signature over the message', async () => {
    const { wallet, signature } = await signWith(message);
    await expect(
      verifyWalletSignature(wallet, message, signature),
    ).resolves.toBe(true);
  });

  it('rejects a signature from a different wallet', async () => {
    const { signature } = await signWith(message);
    const { wallet: otherWallet } = await signWith(message);
    await expect(
      verifyWalletSignature(otherWallet, message, signature),
    ).resolves.toBe(false);
  });

  it('rejects when the verified message differs from the signed one', async () => {
    const { wallet, signature } = await signWith(message);
    await expect(
      verifyWalletSignature(
        wallet,
        'bracketchain:bind-steam:tampered',
        signature,
      ),
    ).resolves.toBe(false);
  });

  it('rejects malformed base58 signature without throwing', async () => {
    const { wallet } = await signWith(message);
    await expect(
      verifyWalletSignature(wallet, message, 'not-valid-base58-0OIl'),
    ).resolves.toBe(false);
  });

  it('rejects a malformed wallet address without throwing', async () => {
    const { signature } = await signWith(message);
    await expect(
      verifyWalletSignature('0OIl-bad', message, signature),
    ).resolves.toBe(false);
  });
});
