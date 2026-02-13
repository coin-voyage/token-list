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

if (!existsSync(tokensDir) || !statSync(tokensDir).isDirectory()) {
  console.error("Error: tokens/ directory is missing or not a directory.");
  process.exit(1);
}

let pkg = { version: "0.0.0", tokenListName: "Coinvoyage Token List" };
try {
  pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
} catch (e) {
  console.error("Error: could not read package.json:", e.message);
  process.exit(1);
}

// Chain metadata: chainId -> { name, logoURI }, and order from chains.json
const { chainsList, chainsOrder } = (() => {
  try {
    const raw = readFileSync(chainsPath, "utf8");
    const arr = JSON.parse(raw);
    const map = new Map();
    const order = [];
    for (const c of Array.isArray(arr) ? arr : []) {
      if (c && Number.isFinite(c.chainId)) {
        const id = Number(c.chainId);
        map.set(id, {
          name: typeof c.name === "string" ? c.name : `Chain ${id}`,
          logoURI: typeof c.logoURI === "string" ? c.logoURI : null,
        });
        order.push(id);
      }
    }
    return { chainsList: map, chainsOrder: order };
  } catch (e) {
    console.warn("Warning: chains.json missing or invalid, chain names/logoURIs will fall back to native token.", e.message);
    return { chainsList: new Map(), chainsOrder: [] };
  }
})();

const MAX_DECIMALS = 255;

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
  if (a == null || a === "" || a === "0x0000000000000000000000000000000000000000")
    return `${t.chainId}:native`;
  return `${t.chainId}:${String(a).toLowerCase()}`;
}

const chainFiles = readdirSync(tokensDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

let hadParseError = false;
const seenKeys = new Set();

// Group by chainId, preserving token order from each file (no global sort)
const byChainId = new Map();
let totalTokens = 0;
for (const file of chainFiles) {
  const path = join(tokensDir, file);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    console.error(`Error: could not read ${file}:`, e.message);
    process.exit(1);
  }
  let list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    console.error(`Error: ${file} is invalid JSON:`, e.message);
    hadParseError = true;
    continue;
  }
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

if (hadParseError) {
  console.error("Build failed due to invalid JSON in one or more token files.");
  process.exit(1);
}

if (totalTokens === 0) {
  console.error("Error: no valid tokens found. Add token JSON files under tokens/.");
  process.exit(1);
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const chains = [];
// First add chains in chains.json order
const seenChainIds = new Set();
for (const chainId of chainsOrder) {
  const tokens = byChainId.get(chainId);
  if (!tokens) continue;
  seenChainIds.add(chainId);
  const chainMeta = chainsList.get(Number(chainId)) ?? {};
  const native = tokens.find(
    (t) =>
      t.address === null ||
      t.address === undefined ||
      t.address === ZERO_ADDRESS
  );
  chains.push({
    chainId: Number(chainId),
    name: chainMeta.name ?? native?.name ?? `Chain ${chainId}`,
    logoURI: chainMeta.logoURI ?? native?.logoURI ?? null,
    nativeCurrency: native
      ? { symbol: native.ticker, decimals: native.decimals }
      : null,
    tokens,
  });
}
// Then any chains with tokens that aren't in chains.json (append in chainId order for stable output)
const remainingChainIds = [...byChainId.keys()].filter((id) => !seenChainIds.has(id)).sort((a, b) => a - b);
for (const chainId of remainingChainIds) {
  const tokens = byChainId.get(chainId);
  const chainMeta = chainsList.get(Number(chainId)) ?? {};
  const native = tokens.find(
    (t) =>
      t.address === null ||
      t.address === undefined ||
      t.address === ZERO_ADDRESS
  );
  chains.push({
    chainId: Number(chainId),
    name: chainMeta.name ?? native?.name ?? `Chain ${chainId}`,
    logoURI: chainMeta.logoURI ?? native?.logoURI ?? null,
    nativeCurrency: native
      ? { symbol: native.ticker, decimals: native.decimals }
      : null,
    tokens,
  });
}

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
