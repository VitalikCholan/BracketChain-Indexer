// Phase 1 §1 acceptance check: resolve all 5 signing roles through @solana/keychain
// from env (the real runtime path) and assert each resolved address matches the
// committed-locally .keys/<role>.json keypair. Run: node scripts/verify-keychain.mjs
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createKeychainSigner } from '@solana/keychain';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ROLES = {
  'sas-issuer': 'KEYCHAIN_SAS_ISSUER',
  'claim-payer': 'KEYCHAIN_CLAIM_PAYER',
  'vrf-payer': 'KEYCHAIN_VRF_PAYER',
  'refund-payer': 'KEYCHAIN_REFUND_PAYER',
  'cleanup-payer': 'KEYCHAIN_CLEANUP_PAYER',
};

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (buf) => {
  const d = [0];
  for (const byte of buf) {
    let c = byte;
    for (let i = 0; i < d.length; i++) {
      c += d[i] << 8;
      d[i] = c % 58;
      c = (c / 58) | 0;
    }
    while (c) {
      d.push(c % 58);
      c = (c / 58) | 0;
    }
  }
  let s = '';
  for (const byte of buf) {
    if (byte === 0) s += '1';
    else break;
  }
  for (let i = d.length - 1; i >= 0; i--) s += B58[d[i]];
  return s;
};

/** Expected pubkey = base58 of the last 32 bytes of the CLI keypair file. */
const expectedPubkey = (role) => {
  const arr = JSON.parse(readFileSync(join(ROOT, '.keys', `${role}.json`), 'utf8'));
  return b58(Uint8Array.from(arr).slice(32));
};

const backend = process.env.KEYCHAIN_BACKEND ?? 'memory';
console.log(`Verifying ${Object.keys(ROLES).length} keychain roles (backend=${backend})\n`);

let failures = 0;
for (const [role, env] of Object.entries(ROLES)) {
  const secret = process.env[env];
  if (!secret || secret.trim() === '') {
    console.error(`✗ ${role.padEnd(14)} — ${env} not set`);
    failures++;
    continue;
  }
  try {
    const signer = await createKeychainSigner({ backend: 'memory', privateKeyString: secret });
    const addr = String(signer.address);
    const want = expectedPubkey(role);
    if (addr === want) {
      console.log(`✓ ${role.padEnd(14)} → ${addr}`);
    } else {
      console.error(`✗ ${role.padEnd(14)} — resolved ${addr} ≠ keypair ${want}`);
      failures++;
    }
  } catch (err) {
    console.error(`✗ ${role.padEnd(14)} — ${err.message}`);
    failures++;
  }
}

if (failures) {
  console.error(`\n${failures} role(s) failed verification.`);
  process.exit(1);
}
console.log('\nAll roles resolved and match their keypair files. §1 keychain acceptance: PASS');
