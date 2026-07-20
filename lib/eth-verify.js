'use strict';

// Minimal EIP-191 (`personal_sign`) signature verification — enough to PROVE that the
// caller controls an Ethereum address, without any network access. Used to safely link
// an extra wallet to a public holder profile: the recovered signer IS the wallet we link,
// so a member can never showcase a wallet they don't actually control.
//
// Built on the audited, zero-dependency @noble packages already present in node_modules
// (transitive deps of @imtbl/orderbook, pinned as direct deps in package.json).

const { secp256k1 } = require('@noble/curves/secp256k1');
const { keccak_256 } = require('@noble/hashes/sha3');

// The exact preimage MetaMask hashes for `personal_sign`: the 0x19 prefix, the ASCII
// byte-length of the message, then the message bytes. We keccak that and recover from it.
function personalSignHash(message) {
  const msg = Buffer.from(String(message), 'utf8');
  const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`, 'utf8');
  return keccak_256(Buffer.concat([prefix, msg]));
}

function addressFromPubkey(uncompressed) {
  // Drop the 0x04 tag byte; keccak the 64-byte pubkey; the address is the last 20 bytes.
  const hash = keccak_256(uncompressed.slice(1));
  return '0x' + Buffer.from(hash).toString('hex').slice(-40);
}

// Recover the signer's address from an EIP-191 personal_sign signature. Returns a
// lowercased 0x address, or null if the signature is malformed / can't be recovered.
// Never throws — callers treat null as "verification failed".
function recoverPersonalSignAddress(message, signatureHex) {
  try {
    const sig = String(signatureHex || '').toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{130}$/.test(sig)) return null; // must be exactly 65 bytes
    const rs = sig.slice(0, 128);
    let v = parseInt(sig.slice(128, 130), 16);
    if (v >= 27) v -= 27;              // 27/28 → 0/1
    if (v !== 0 && v !== 1) return null;
    const hash = personalSignHash(message);
    const pub = secp256k1.Signature.fromCompact(rs).addRecoveryBit(v)
      .recoverPublicKey(hash).toRawBytes(false); // uncompressed 65 bytes
    return addressFromPubkey(pub);
  } catch {
    return null;
  }
}

module.exports = { recoverPersonalSignAddress };
