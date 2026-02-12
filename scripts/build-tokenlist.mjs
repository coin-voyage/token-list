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
const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));

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

const [major = 0, minor = 0, patch = 0] = (pkg.version || "0.0.0").split(".").map(Number);
const tokenlist = {
  name: pkg.tokenListName || "Coinvoyage Token List",
  version: { major, minor, patch },
  timestamp: new Date().toISOString(),
  tokens: allTokens,
};

const outPath = join(rootDir, "tokenlist.json");
writeFileSync(outPath, JSON.stringify(tokenlist, null, 2), "utf8");
console.log(`Wrote ${outPath} with ${allTokens.length} tokens from ${chainFiles.length} chain(s).`);
