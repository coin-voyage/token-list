/**
 * Builds tokenlist.json from all chain JSON files in tokens/.
 * Run: pnpm run build:tokenlist
 * Output: tokenlist.json at repo root (commit and use via GitHub raw URL).
 */
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const tokensDir = join(rootDir, "tokens");
const chainsPath = join(rootDir, "chains.json");
const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));

// Chain metadata: chainId -> { name, logoURI }
const chainsList = (() => {
  try {
    const raw = readFileSync(chainsPath, "utf8");
    const arr = JSON.parse(raw);
    const map = new Map();
    for (const c of Array.isArray(arr) ? arr : []) {
      if (c && Number.isFinite(c.chainId)) {
        map.set(Number(c.chainId), {
          name: typeof c.name === "string" ? c.name : `Chain ${c.chainId}`,
          logoURI: typeof c.logoURI === "string" ? c.logoURI : null,
        });
      }
    }
    return map;
  } catch (e) {
    console.warn("Warning: chains.json missing or invalid, chain names/logoURIs will fall back to native token.", e.message);
    return new Map();
  }
})();

function isValidToken(t) {
  if (!t || typeof t !== "object") return false;
  const validAddress = typeof t.address === "string" || t.address === null;
  const nonEmptyAddress = t.address === null || t.address.length > 0;
  return (
    validAddress &&
    nonEmptyAddress &&
    typeof t.ticker === "string" &&
    typeof t.name === "string" &&
    typeof t.decimals === "number" &&
    Number.isFinite(t.decimals) &&
    typeof t.chainId === "number" &&
    Number.isFinite(t.chainId)
  );
}

const chainFiles = readdirSync(tokensDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

const allTokens = [];
for (const file of chainFiles) {
  const path = join(tokensDir, file);
  const raw = readFileSync(path, "utf8");
  let list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    console.warn(`Warning: ${file} is invalid JSON, skipping.`, e.message);
    continue;
  }
  const arr = Array.isArray(list) ? list : [];
  for (const t of arr) {
    if (isValidToken(t)) allTokens.push(t);
    else console.warn(`Warning: invalid token in ${file}, skipping:`, t);
  }
}

allTokens.sort((a, b) => {
  if (a.chainId !== b.chainId) return a.chainId - b.chainId;
  return (a.ticker || "").toLowerCase().localeCompare((b.ticker || "").toLowerCase());
});

// Group by chainId and build chain metadata from native token (address === null)
const byChainId = new Map();
for (const t of allTokens) {
  const id = t.chainId;
  if (!byChainId.has(id)) byChainId.set(id, []);
  byChainId.get(id).push(t);
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const chains = [];
for (const [chainId, tokens] of byChainId) {
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
chains.sort((a, b) => a.chainId - b.chainId);

const [major = 0, minor = 0, patch = 0] = (pkg.version || "0.0.0").split(".").map(Number);
const tokenlist = {
  name: pkg.tokenListName || "Coinvoyage Token List",
  version: { major, minor, patch },
  timestamp: new Date().toISOString(),
  chains,
};

const outPath = join(rootDir, "tokenlist.json");
writeFileSync(outPath, JSON.stringify(tokenlist, null, 2), "utf8");
console.log(`Wrote ${outPath} with ${allTokens.length} tokens across ${chains.length} chain(s).`);
