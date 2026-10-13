/**
 * Dependency-free Keccak-256 (the pre-NIST padding variant Ethereum uses; this is NOT
 * the same function as Node's `sha3-256`) and the EIP-55 address checksum built on it.
 *
 * `assertKeccakSelfTest()` checks the implementation against published test vectors and
 * runs on every validation, so a broken edit here fails loudly instead of silently
 * accepting or rewriting addresses.
 */

const MASK_64 = (1n << 64n) - 1n;
const RATE_BYTES = 136; // 1088-bit rate for a 256-bit digest

const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

function rotateLeft(value, bits) {
  if (bits === 0n) return value;
  return ((value << bits) | (value >> (64n - bits))) & MASK_64;
}

/** Keccak-f[1600] permutation over 25 lanes indexed as x + 5 * y. */
function permute(state) {
  const column = new Array(5);
  const row = new Array(5);
  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      column[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const d = column[(x + 4) % 5] ^ rotateLeft(column[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) state[x + y] ^= d;
    }
    // rho and pi
    let x = 1;
    let y = 0;
    let current = state[1];
    for (let t = 0; t < 24; t++) {
      const nextX = y;
      const nextY = (2 * x + 3 * y) % 5;
      const index = nextX + 5 * nextY;
      const displaced = state[index];
      state[index] = rotateLeft(current, BigInt((((t + 1) * (t + 2)) / 2) % 64));
      current = displaced;
      x = nextX;
      y = nextY;
    }
    // chi
    for (let rowStart = 0; rowStart < 25; rowStart += 5) {
      for (let i = 0; i < 5; i++) row[i] = state[rowStart + i];
      for (let i = 0; i < 5; i++) {
        state[rowStart + i] = (row[i] ^ (~row[(i + 1) % 5] & row[(i + 2) % 5])) & MASK_64;
      }
    }
    // iota
    state[0] ^= ROUND_CONSTANTS[round];
  }
}

/** @param {Uint8Array|string} input bytes, or a string hashed as UTF-8. @returns {string} lowercase hex digest */
export function keccak256(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const paddedLength = Math.ceil((bytes.length + 1) / RATE_BYTES) * RATE_BYTES;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[paddedLength - 1] ^= 0x80;

  const state = new Array(25).fill(0n);
  for (let offset = 0; offset < paddedLength; offset += RATE_BYTES) {
    for (let lane = 0; lane < RATE_BYTES / 8; lane++) {
      let word = 0n;
      for (let b = 7; b >= 0; b--) word = (word << 8n) | BigInt(padded[offset + lane * 8 + b]);
      state[lane] ^= word;
    }
    permute(state);
  }

  let hex = "";
  for (let lane = 0; lane < 4; lane++) {
    for (let b = 0n; b < 8n; b++) {
      hex += Number((state[lane] >> (8n * b)) & 0xffn).toString(16).padStart(2, "0");
    }
  }
  return hex;
}

/** Returns the EIP-55 mixed-case form of a 20-byte hex address (any input casing). */
export function toChecksumAddress(address) {
  const lower = address.slice(2).toLowerCase();
  const hash = keccak256(lower);
  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

const SELF_TEST_HASHES = [
  ["", "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
  ["abc", "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"],
  ["decimals()", "313ce567add4d438edf58b94ff345d7d38c45b17dfc0f947988d7819dca364f9"],
];

// Addresses from the EIP-55 specification.
const SELF_TEST_ADDRESSES = [
  "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
  "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
];

export function assertKeccakSelfTest() {
  for (const [input, expected] of SELF_TEST_HASHES) {
    const actual = keccak256(input);
    if (actual !== expected) {
      throw new Error(`keccak256 self-test failed for ${JSON.stringify(input)}: got ${actual}`);
    }
  }
  for (const address of SELF_TEST_ADDRESSES) {
    if (toChecksumAddress(address.toLowerCase()) !== address) {
      throw new Error(`EIP-55 self-test failed for ${address}`);
    }
  }
}
