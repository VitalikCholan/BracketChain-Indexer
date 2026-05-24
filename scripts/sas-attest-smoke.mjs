// A-9 smoke: issue a Steam attestation for a throwaway wallet (devnet) exactly
// as IdentityService does, then parse it back using the SAME byte offsets the
// on-chain validate_attestation() uses — proving the program will accept what
// the indexer issues. Run: node scripts/sas-attest-smoke.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
} from '@solana/kit';
import { deriveAttestationPda, getCreateAttestationInstruction } from 'sas-lib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const CREDENTIAL = 'A6aCesF4nLNRGBRfUS5dCw9e1f1peGmNhZU4t139Qwjc';
const SCHEMA = '4TT2a5ycymMRwZJoGTPfaggb7CtGrDtCXKheF7zeV27m';
const SAS_PROGRAM = '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG';
const GAME_DOTA2 = 1;
const STEAM_ID = '76561198000000000';

const rpc = createSolanaRpc(RPC);
const rpcSubscriptions = createSolanaRpcSubscriptions(RPC.replace(/^http/, 'ws'));
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

const issuer = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(readFileSync(join(ROOT, '.keys', 'sas-issuer.json'), 'utf8'))),
);
const player = await generateKeyPairSigner(); // throwaway wallet = attestation nonce
console.log(`issuer:  ${issuer.address}`);
console.log(`player:  ${player.address}\n`);

// Build data exactly like IdentityService: game(u8) + steam(u64 LE) + Vec<u8>(32)
const steamLe = Buffer.alloc(8);
steamLe.writeBigUInt64LE(BigInt(STEAM_ID));
const identityBytes = createHash('sha256').update(steamLe).digest();
const lenPrefix = Buffer.alloc(4);
lenPrefix.writeUInt32LE(identityBytes.length);
const data = new Uint8Array(Buffer.concat([Buffer.from([GAME_DOTA2]), steamLe, lenPrefix, identityBytes]));

const [attestation] = await deriveAttestationPda({
  credential: CREDENTIAL,
  schema: SCHEMA,
  nonce: player.address,
});
console.log(`attestation: ${attestation}`);

const ix = getCreateAttestationInstruction({
  payer: issuer,
  authority: issuer,
  credential: CREDENTIAL,
  schema: SCHEMA,
  attestation,
  nonce: player.address,
  data,
  expiry: 0n,
});

const { value: bh } = await rpc.getLatestBlockhash().send();
const msg = pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayerSigner(issuer, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
  (m) => appendTransactionMessageInstructions([ix], m),
);
const signed = await signTransactionMessageWithSigners(msg);
await sendAndConfirm(signed, { commitment: 'confirmed' });
console.log('✓ attestation issued\n');

// ── Parse back using the program's validate_attestation offsets ──
const acc = await rpc.getAccountInfo(attestation, { encoding: 'base64' }).send();
const raw = Buffer.from(acc.value.data[0], 'base64');
const b58 = (b) => {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let d = [0];
  for (const x of b) { let c = x; for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } }
  let s = ''; for (const x of b) { if (x === 0) s += '1'; else break; }
  for (let i = d.length - 1; i >= 0; i--) s += A[d[i]]; return s;
};
const nonce = b58(raw.subarray(1, 33));
const cred = b58(raw.subarray(33, 65));
const schema = b58(raw.subarray(65, 97));
const dataLen = raw.readUInt32LE(97);
const payload = raw.subarray(101, 101 + dataLen);
const ibLen = payload.readUInt32LE(9);
const ib = payload.subarray(13, 13 + ibLen);

const checks = [
  ['owner == SAS program', acc.value.owner === SAS_PROGRAM],
  ['nonce == player', nonce === player.address],
  ['credential matches', cred === CREDENTIAL],
  ['schema matches', schema === SCHEMA],
  ['identity_bytes len == 32', ibLen === 32],
  ['identity_bytes == sha256(steam)', Buffer.compare(ib, identityBytes) === 0],
];
let ok = true;
for (const [label, pass] of checks) { console.log(`${pass ? '✓' : '✗'} ${label}`); if (!pass) ok = false; }
console.log(ok ? '\nA-9 layout smoke: PASS (program validate_attestation will accept this)' : '\nFAIL');
process.exit(ok ? 0 : 1);
