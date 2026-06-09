// Phase 1 §2 P2-1: one-time devnet bootstrap of BracketChain's SAS identity layer.
// Creates the issuer Credential + the Dota2 game-identity Schema using the
// sas-issuer keypair (from .keys/, funded in §1). Idempotent: re-running skips
// accounts that already exist.
//
//   node scripts/sas-bootstrap.mjs
//
// Schema shape (locked, P2-2 — SAS has no fixed-size arrays, so identity_bytes
// is Vec<u8> not [u8;32]; Stage A reads the deserialized field, not raw 0..32):
//   layout     = [0, 3, 13]                       // u8, u64, Vec<u8>
//   fieldNames = ["game", "steam_id_64", "identity_bytes"]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createKeyPairSignerFromBytes,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
} from '@solana/kit';
import {
  deriveCredentialPda,
  deriveSchemaPda,
  getCreateCredentialInstruction,
  getCreateSchemaInstruction,
} from 'sas-lib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RPC_HTTP = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const RPC_WS = RPC_HTTP.replace(/^http/, 'ws');

const CREDENTIAL_NAME = 'bracketchain-issuer';
const SCHEMA_NAME = 'dota2.game_identity';
const SCHEMA_VERSION = 1;
const SCHEMA_DESCRIPTION = 'BracketChain wallet<->Steam identity for Dota 2';
// SAS layout type codes: 0=u8, 3=u64, 13=Vec<u8>
const LAYOUT = new Uint8Array([0, 3, 13]);
const FIELD_NAMES = ['game', 'steam_id_64', 'identity_bytes'];

const rpc = createSolanaRpc(RPC_HTTP);
const rpcSubscriptions = createSolanaRpcSubscriptions(RPC_WS);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

const exists = async (address) => {
  const { value } = await rpc.getAccountInfo(address, { encoding: 'base64' }).send();
  return value !== null;
};

const send = async (instructions, signer, label) => {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  await sendAndConfirm(signed, { commitment: 'confirmed' });
  const sig = getSignatureFromTransaction(signed);
  console.log(`  ${label} tx: ${sig}`);
};

async function main() {
  const secret = Uint8Array.from(
    JSON.parse(readFileSync(join(ROOT, '.keys', 'sas-issuer.json'), 'utf8')),
  );
  const issuer = await createKeyPairSignerFromBytes(secret);
  console.log(`sas-issuer: ${issuer.address}`);
  console.log(`rpc:        ${RPC_HTTP}\n`);

  // 1. Credential
  const [credential] = await deriveCredentialPda({
    authority: issuer.address,
    name: CREDENTIAL_NAME,
  });
  if (await exists(credential)) {
    console.log(`Credential exists, skipping: ${credential}`);
  } else {
    console.log(`Creating Credential "${CREDENTIAL_NAME}" -> ${credential}`);
    await send(
      [
        getCreateCredentialInstruction({
          payer: issuer,
          credential,
          authority: issuer,
          name: CREDENTIAL_NAME,
          signers: [issuer.address],
        }),
      ],
      issuer,
      'createCredential',
    );
  }

  // 2. Dota2 Schema
  const [schema] = await deriveSchemaPda({
    credential,
    name: SCHEMA_NAME,
    version: SCHEMA_VERSION,
  });
  if (await exists(schema)) {
    console.log(`Schema exists, skipping: ${schema}`);
  } else {
    console.log(`Creating Schema "${SCHEMA_NAME}" v${SCHEMA_VERSION} -> ${schema}`);
    await send(
      [
        getCreateSchemaInstruction({
          payer: issuer,
          authority: issuer,
          credential,
          schema,
          name: SCHEMA_NAME,
          description: SCHEMA_DESCRIPTION,
          layout: LAYOUT,
          fieldNames: FIELD_NAMES,
        }),
      ],
      issuer,
      'createSchema',
    );
  }

  // 3. Verify + summary
  const okCred = await exists(credential);
  const okSchema = await exists(schema);
  console.log('\n─── SAS devnet bootstrap result ───');
  console.log(`Credential       ${credential}  ${okCred ? 'OK' : 'MISSING'}`);
  console.log(`Schema (Dota2)   ${schema}  ${okSchema ? 'OK' : 'MISSING'}`);
  console.log('\nWire into protocol_config at Phase 1 redeploy:');
  console.log(`  sas_credential   = ${credential}`);
  console.log(`  sas_schemas[1]   = ${schema}   // Dota2; [0],[2],[3],[4] = default until those games activate`);

  if (!okCred || !okSchema) process.exit(1);
}

main().catch((err) => {
  console.error('bootstrap failed:', err);
  process.exit(1);
});
