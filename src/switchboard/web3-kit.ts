import {
  AccountRole,
  address,
  type Address,
  type Instruction,
} from '@solana/kit';
import type {
  AddressLookupTableAccount,
  TransactionInstruction,
} from '@solana/web3.js';

export function web3RoleToKit(
  isSigner: boolean,
  isWritable: boolean,
): AccountRole {
  if (isSigner && isWritable) return AccountRole.WRITABLE_SIGNER;
  if (isSigner) return AccountRole.READONLY_SIGNER;
  if (isWritable) return AccountRole.WRITABLE;
  return AccountRole.READONLY;
}

export function toKitInstruction(ix: TransactionInstruction): Instruction {
  return {
    programAddress: address(ix.programId.toBase58()),
    accounts: ix.keys.map((k) => ({
      address: address(k.pubkey.toBase58()),
      role: web3RoleToKit(k.isSigner, k.isWritable),
    })),
    data: new Uint8Array(ix.data),
  };
}

export function lutsToKitAddressesByLut(
  luts: AddressLookupTableAccount[],
): Record<Address, Address[]> {
  const out: Record<Address, Address[]> = {};
  for (const lut of luts) {
    out[address(lut.key.toBase58())] = lut.state.addresses.map((a) =>
      address(a.toBase58()),
    );
  }
  return out;
}
