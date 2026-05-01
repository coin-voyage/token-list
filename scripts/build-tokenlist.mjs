/**
 * Builds tokenlist.json from all chain JSON files in tokens/.
 * Run: pnpm run build:tokenlist
 * Output: tokenlist.json at repo root (commit and use via GitHub raw URL).
 * Exits with code 1 on unrecoverable errors so CI can fail the build.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const tokensDir = join(rootDir, "tokens");
const chainsPath = join(rootDir, "chains.json");
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_DECIMALS = 255;

if (!existsSync(tokensDir) || !statSync(tokensDir).isDirectory()) {
  console.error("Error: tokens/ directory is missing or not a directory.");
  process.exit(1);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`Error: could not read ${label}:`, e.message);
    process.exit(1);
  }
}

function readChains() {
  try {
    const chains = JSON.parse(readFileSync(chainsPath, "utf8"));
    const validChains = Array.isArray(chains)
      ? chains.filter((chain) => chain && Number.isFinite(chain.chainId))
      : [];

    return {
      order: validChains.map((chain) => Number(chain.chainId)),
      meta: new Map(
        validChains.map((chain) => [
          Number(chain.chainId),
          {
            name: typeof chain.name === "string" ? chain.name : `Chain ${chain.chainId}`,
            logoURI: typeof chain.logoURI === "string" ? chain.logoURI : null,
          },
        ])
      ),
    };
  } catch (e) {
    console.warn("Warning: chains.json missing or invalid, chain names/logoURIs will fall back to native token.", e.message);
    return { order: [], meta: new Map() };
  }
}

function isValidToken(t) {
  if (!t || typeof t !== "object") return false;
  const validAddress = typeof t.address === "string" || t.address === undefined;
  const nonEmptyAddress = t.address === undefined || (typeof t.address === "string" && t.address.length > 0);
  const decimalsOk =
    typeof t.decimals === "number" &&
    Number.isInteger(t.decimals) &&
    t.decimals >= 0 &&
    t.decimals <= MAX_DECIMALS;
  const chainIdOk =
    typeof t.chainId === "number" && Number.isInteger(t.chainId) && t.chainId > 0;
  return (
    validAddress &&
    nonEmptyAddress &&
    typeof t.ticker === "string" &&
    typeof t.name === "string" &&
    t.name.trim().length > 0 &&
    t.ticker.trim().length > 0 &&
    decimalsOk &&
    chainIdOk
  );
}

/** Normalize address for dedupe: null, undefined, or 0x0... treated as native key. */
function tokenKey(t) {
  const a = t.address;
  if (a == null || a === "" || a === ZERO_ADDRESS)
    return `${t.chainId}:native`;
  return `${t.chainId}:${String(a).toLowerCase()}`;
}

function isNativeToken(t) {
  return t.address === null || t.address === undefined || t.address === ZERO_ADDRESS;
}

function buildChain(chainId, tokens, chainMeta = {}) {
  const native = tokens.find(isNativeToken);
  return {
    chainId: Number(chainId),
    name: chainMeta.name ?? native?.name ?? `Chain ${chainId}`,
    logoURI: chainMeta.logoURI ?? native?.logoURI ?? null,
    nativeCurrency: native ? { symbol: native.ticker, decimals: native.decimals } : null,
    tokens,
  };
}

const pkg = readJson(join(rootDir, "package.json"), "package.json");
const chainsConfig = readChains();
const chainFiles = readdirSync(tokensDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

const seenKeys = new Set();

// Group by chainId, preserving token order from each file (no global sort)
const byChainId = new Map();
let totalTokens = 0;
for (const file of chainFiles) {
  const list = readJson(join(tokensDir, file), file);
  const arr = Array.isArray(list) ? list : [];
  for (const t of arr) {
    if (!isValidToken(t)) {
      console.warn(`Warning: invalid token in ${file}, skipping:`, t);
      continue;
    }
    const key = tokenKey(t);
    if (seenKeys.has(key)) {
      console.warn(`Warning: duplicate token in ${file} (chainId=${t.chainId}, address=${t.address ?? "native"}), skipping.`);
      continue;
    }
    seenKeys.add(key);
    const normalized = {
      ...t,
      name: t.name.trim(),
      ticker: t.ticker.trim(),
    };
    const id = t.chainId;
    if (!byChainId.has(id)) byChainId.set(id, []);
    byChainId.get(id).push(normalized);
    totalTokens++;
  }
}

if (totalTokens === 0) {
  console.error("Error: no valid tokens found. Add token JSON files under tokens/.");
  process.exit(1);
}

const configuredChainIds = chainsConfig.order.filter((chainId) => byChainId.has(chainId));
const configuredChainIdSet = new Set(configuredChainIds);
const extraChainIds = [...byChainId.keys()]
  .filter((chainId) => !configuredChainIdSet.has(chainId))
  .sort((a, b) => a - b);

const orderedChainIds = [
  ...configuredChainIds,
  ...extraChainIds,
];

const chains = orderedChainIds.map((chainId) =>
  buildChain(chainId, byChainId.get(chainId), chainsConfig.meta.get(chainId))
);

const [major = 0, minor = 0, patch = 0] = (pkg.version || "0.0.0").split(".").map(Number);
const tokenlist = {
  name: pkg.tokenListName || "Coinvoyage Token List",
  version: { major, minor, patch },
  timestamp: new Date().toISOString(),
  chains,
};

const outPath = join(rootDir, "tokenlist.json");
try {
  writeFileSync(outPath, JSON.stringify(tokenlist, null, 2), "utf8");
} catch (e) {
  console.error("Error: could not write tokenlist.json:", e.message);
  process.exit(1);
}
console.log(`Wrote ${outPath} with ${totalTokens} tokens across ${chains.length} chain(s).`);
