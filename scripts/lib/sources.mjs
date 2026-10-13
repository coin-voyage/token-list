/**
 * Loads and validates chains.json and tokens/*.json.
 *
 * Every problem is collected as a message naming the file and entry, so a contributor
 * sees all of them in one run. Callers (build, validate, verify-onchain) must refuse to
 * continue when `errors` is non-empty: nothing here is ever skipped or silently dropped.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertKeccakSelfTest, toChecksumAddress } from "./keccak256.mjs";

/**
 * Address rules per chain family. Every chain in chains.json must declare one of these;
 * a new kind of chain needs a new entry here rather than falling through to a default.
 */
export const CHAIN_FAMILIES = ["evm", "solana", "sui", "utxo"];

export const MAX_DECIMALS = 255;
const TOKEN_FIELDS = new Set(["name", "address", "ticker", "decimals", "chainId", "logoURI"]);
const CHAIN_FIELDS = new Set(["chainId", "name", "logoURI", "family", "preview"]);
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SUI_COIN_TYPE = /^0x([0-9a-f]{1,64})::([A-Za-z][A-Za-z0-9_]*)::([A-Za-z][A-Za-z0-9_]*)$/;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decodes base58 (Bitcoin alphabet). Returns the byte length, or null if a character is invalid. */
function base58ByteLength(text) {
  let value = 0n;
  for (const char of text) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit === -1) return null;
    value = value * 58n + BigInt(digit);
  }
  let leadingZeroBytes = 0;
  while (leadingZeroBytes < text.length && text[leadingZeroBytes] === "1") leadingZeroBytes++;
  let valueBytes = 0;
  while (value > 0n) {
    value >>= 8n;
    valueBytes++;
  }
  return leadingZeroBytes + valueBytes;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isHttpsUrl(value) {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validates a non-native address for its chain family.
 * @returns {{ error: string } | { key: string }} `key` is the canonical form used to detect duplicates.
 */
function checkAddress(family, address) {
  if (family === "evm") {
    if (!EVM_ADDRESS.test(address)) {
      return { error: `address ${JSON.stringify(address)} is not a 20-byte hex EVM address (0x + 40 hex characters)` };
    }
    if (/^0x0{40}$/.test(address)) {
      return { error: "the zero address is not a token; list the native token with `address` omitted or null" };
    }
    const checksummed = toChecksumAddress(address);
    if (address !== checksummed) {
      const body = address.slice(2);
      const singleCase = body === body.toLowerCase() || body === body.toUpperCase();
      return {
        error: singleCase
          ? `address ${address} is not EIP-55 checksummed; write it as ${checksummed} (after confirming the address on a block explorer)`
          : `address ${address} fails its EIP-55 checksum, so at least one character is wrong; copy it again from a block explorer`,
      };
    }
    return { key: address.toLowerCase() };
  }

  if (family === "solana") {
    const length = base58ByteLength(address);
    if (length === null) return { error: `mint ${JSON.stringify(address)} contains characters that are not base58` };
    if (length !== 32) return { error: `mint ${JSON.stringify(address)} decodes to ${length} bytes; a Solana mint is 32 bytes` };
    return { key: address }; // base58 is case-sensitive
  }

  if (family === "sui") {
    const match = SUI_COIN_TYPE.exec(address);
    if (!match) {
      return { error: `coin type ${JSON.stringify(address)} must look like 0x<lowercase hex, up to 64 digits>::module::Name` };
    }
    const [, packageHex, moduleName, typeName] = match;
    const packageId = packageHex.padStart(64, "0");
    if (BigInt(`0x${packageId}`) === 2n && moduleName === "sui" && typeName === "SUI") {
      return { error: "0x2::sui::SUI is the native token; list it with `address` omitted or null" };
    }
    return { key: `0x${packageId}::${moduleName}::${typeName}` };
  }

  if (family === "utxo") {
    return { error: `this chain only has a native asset, so \`address\` must be omitted or null (got ${JSON.stringify(address)})` };
  }

  // Unreachable while chains.json validation rejects unknown families; kept so a new family cannot pass unchecked.
  return { error: `no address rules are implemented for chain family ${JSON.stringify(family)}` };
}

function readJsonFile(path, label, errors) {
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (e) {
    errors.push(`${label}: cannot be read as JSON: ${e.message}`);
    return null;
  }
}

function loadChains(rootDir, errors, invalidChainIds) {
  const chains = new Map();
  const parsed = readJsonFile(join(rootDir, "chains.json"), "chains.json", errors);
  if (!parsed) return chains;
  if (!Array.isArray(parsed.value)) {
    errors.push("chains.json: expected a JSON array of chains");
    return chains;
  }

  parsed.value.forEach((chain, index) => {
    const prefix = `chains.json [entry #${index + 1}${chain && typeof chain === "object" && chain.name ? ` ${JSON.stringify(chain.name)}` : ""}]`;
    if (!chain || typeof chain !== "object" || Array.isArray(chain)) {
      errors.push(`${prefix}: expected an object`);
      return;
    }
    const problems = [];
    if (!Number.isSafeInteger(chain.chainId) || chain.chainId <= 0) problems.push("`chainId` must be a positive integer");
    if (!isNonEmptyString(chain.name)) problems.push("`name` must be a non-empty string");
    if (chain.logoURI !== undefined && chain.logoURI !== null && !isHttpsUrl(chain.logoURI)) problems.push("`logoURI` must be an https URL");
    if (chain.preview !== undefined && typeof chain.preview !== "boolean") problems.push("`preview` must be true or false");
    if (!CHAIN_FAMILIES.includes(chain.family)) {
      problems.push(`\`family\` must be one of ${CHAIN_FAMILIES.join(", ")} (got ${JSON.stringify(chain.family)}); it selects the address rules for the chain's tokens`);
    }
    for (const field of Object.keys(chain)) {
      if (!CHAIN_FIELDS.has(field)) problems.push(`unknown field \`${field}\``);
    }
    if (Number.isSafeInteger(chain.chainId) && chains.has(chain.chainId)) problems.push(`chainId ${chain.chainId} is listed more than once`);
    for (const problem of problems) errors.push(`${prefix}: ${problem}`);
    if (problems.length > 0 && Number.isSafeInteger(chain.chainId)) invalidChainIds.add(chain.chainId);
    if (problems.length === 0) {
      chains.set(chain.chainId, {
        chainId: chain.chainId,
        name: chain.name.trim(),
        logoURI: chain.logoURI ?? null,
        family: chain.family,
        preview: chain.preview === true,
      });
    }
  });
  return chains;
}

/**
 * @returns {{
 *   errors: string[],
 *   chains: Map<number, { chainId: number, name: string, logoURI: string | null, family: string, preview: boolean }>,
 *   tokens: Array<{ file: string, label: string, family: string, native: boolean, token: object }>
 * }} `tokens` holds only entries that passed every check, in file order. `token.address` is absent for native tokens.
 */
export function loadSources(rootDir) {
  const errors = [];
  const tokens = [];

  try {
    assertKeccakSelfTest();
  } catch (e) {
    return { errors: [`scripts/lib/keccak256.mjs: ${e.message}`], chains: new Map(), tokens };
  }

  // Chains that exist but are themselves invalid: their tokens are held back without a second, misleading error.
  const invalidChainIds = new Set();
  const chains = loadChains(rootDir, errors, invalidChainIds);
  const tokensDir = join(rootDir, "tokens");
  if (!existsSync(tokensDir) || !statSync(tokensDir).isDirectory()) {
    errors.push("tokens/: directory is missing");
    return { errors, chains, tokens };
  }

  const files = readdirSync(tokensDir).filter((name) => name.endsWith(".json")).sort();
  if (files.length === 0) errors.push("tokens/: no token files found");

  const fileByChainId = new Map();
  const seen = new Map(); // `${chainId}:${canonical address}` -> where it was first listed

  for (const name of files) {
    const file = `tokens/${name}`;
    const parsed = readJsonFile(join(tokensDir, name), file, errors);
    if (!parsed) continue;
    if (!Array.isArray(parsed.value) || parsed.value.length === 0) {
      errors.push(`${file}: expected a non-empty JSON array of tokens`);
      continue;
    }

    // One file describes one chain: the first usable chainId is the file's chain.
    const fileChainId = parsed.value.find((t) => t && Number.isSafeInteger(t.chainId))?.chainId;
    if (fileChainId !== undefined) {
      const otherFile = fileByChainId.get(fileChainId);
      if (otherFile) {
        errors.push(`${file}: chainId ${fileChainId} already has a token file (${otherFile}); keep one file per chain`);
      } else {
        fileByChainId.set(fileChainId, file);
      }
    }

    parsed.value.forEach((token, index) => {
      const isObject = token && typeof token === "object" && !Array.isArray(token);
      const ticker = isObject && typeof token.ticker === "string" ? ` ${token.ticker.trim()}` : "";
      const label = `${file} [entry #${index + 1}${ticker}]`;
      if (!isObject) {
        errors.push(`${label}: expected a token object`);
        return;
      }

      const problems = [];
      if (!isNonEmptyString(token.name)) problems.push("`name` must be a non-empty string");
      if (!isNonEmptyString(token.ticker)) problems.push("`ticker` must be a non-empty string");
      if (token.decimals === undefined) {
        problems.push("`decimals` is missing");
      } else if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > MAX_DECIMALS) {
        problems.push(`\`decimals\` must be an integer from 0 to ${MAX_DECIMALS} (got ${JSON.stringify(token.decimals)})`);
      }
      if (token.logoURI !== undefined && !isHttpsUrl(token.logoURI)) problems.push("`logoURI` must be an https URL");
      for (const field of Object.keys(token)) {
        if (!TOKEN_FIELDS.has(field)) problems.push(`unknown field \`${field}\` (allowed: ${[...TOKEN_FIELDS].join(", ")})`);
      }

      let chain;
      if (token.chainId === undefined) {
        problems.push("`chainId` is missing");
      } else if (!Number.isSafeInteger(token.chainId) || token.chainId <= 0) {
        problems.push(`\`chainId\` must be a positive integer (got ${JSON.stringify(token.chainId)})`);
      } else {
        chain = chains.get(token.chainId);
        if (!chain && !invalidChainIds.has(token.chainId)) problems.push(`chainId ${token.chainId} is not defined in chains.json`);
        if (token.chainId !== fileChainId) {
          problems.push(`chainId ${token.chainId} differs from the rest of this file (${fileChainId}); each token file holds exactly one chain`);
        }
      }

      const native = token.address === undefined || token.address === null;
      let addressKey = native ? "native" : null;
      if (!native && typeof token.address !== "string") {
        problems.push(`\`address\` must be a string, or omitted/null for the native token (got ${JSON.stringify(token.address)})`);
      } else if (!native && chain) {
        const result = checkAddress(chain.family, token.address);
        if (result.error) problems.push(result.error);
        else addressKey = result.key;
      }

      if (chain && addressKey !== null) {
        const key = `${chain.chainId}:${addressKey}`;
        const first = seen.get(key);
        if (first) {
          problems.push(
            native
              ? `duplicate native token for chainId ${chain.chainId} (first listed at ${first}); only one entry per chain may omit \`address\``
              : `duplicate of ${first} (chainId ${chain.chainId}, address ${token.address})`
          );
        } else {
          seen.set(key, label);
        }
      }

      for (const problem of problems) errors.push(`${label}: ${problem}`);
      if (problems.length > 0 || !chain) return;

      // Keeps the source key order; a null address is emitted as an omitted one.
      const normalized = { ...token, name: token.name.trim(), ticker: token.ticker.trim() };
      if (native) delete normalized.address;
      tokens.push({ file, label, family: chain.family, native, token: normalized });
    });
  }

  return { errors, chains, tokens };
}

/** Prints validation errors in a uniform way and returns true when there are any. */
export function reportErrors(errors) {
  if (errors.length === 0) return false;
  console.error(`Token list validation failed with ${errors.length} error(s):\n`);
  for (const error of errors) console.error(`  - ${error}`);
  console.error("\nNothing was written. Fix the entries above and run the command again.");
  return true;
}
