/**
 * Builds tokenlist.json from chains.json and the per-chain files in tokens/.
 * Run: pnpm run build:tokenlist
 * Output: tokenlist.json at repo root (commit and use via GitHub raw URL).
 * --preview writes tokenlist.preview.json with unreleased chains included.
 *
 * The sources are validated first (see scripts/lib/sources.mjs). Any invalid or
 * duplicate entry fails the build with exit code 1 and nothing is written.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSources, reportErrors } from "./lib/sources.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const includePreview = process.argv.includes("--preview");

const { errors, chains: chainConfig, tokens } = loadSources(rootDir);
if (reportErrors(errors)) process.exit(1);

let pkg;
try {
  pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
} catch (e) {
  console.error("Error: could not read package.json:", e.message);
  process.exit(1);
}

// Group by chainId, preserving token order from each file (no global sort).
const byChainId = new Map();
let totalTokens = 0;
for (const { token } of tokens) {
  if (!includePreview && chainConfig.get(token.chainId).preview) continue;
  if (!byChainId.has(token.chainId)) byChainId.set(token.chainId, []);
  byChainId.get(token.chainId).push(token);
  totalTokens++;
}

if (totalTokens === 0) {
  console.error("Error: no tokens to publish. Add token JSON files under tokens/.");
  process.exit(1);
}

// Chains appear in chains.json order; chains without tokens are left out.
const chains = [...chainConfig.values()]
  .filter((chain) => byChainId.has(chain.chainId))
  .map((chain) => {
    const chainTokens = byChainId.get(chain.chainId);
    const native = chainTokens.find((t) => t.address === undefined);
    return {
      chainId: chain.chainId,
      name: chain.name,
      logoURI: chain.logoURI ?? native?.logoURI ?? null,
      nativeCurrency: native ? { symbol: native.ticker, decimals: native.decimals } : null,
      tokens: chainTokens,
    };
  });

const [major = 0, minor = 0, patch = 0] = (pkg.version || "0.0.0").split(".").map(Number);
const tokenlist = {
  name: pkg.tokenListName || "Coinvoyage Token List",
  version: { major, minor, patch },
  timestamp: new Date().toISOString(),
  chains,
};

const outName = includePreview ? "tokenlist.preview.json" : "tokenlist.json";
const outPath = join(rootDir, outName);
// Preserve the build timestamp when content is unchanged so CI can verify committed lists.
if (existsSync(outPath)) {
  try {
    const previous = JSON.parse(readFileSync(outPath, "utf8"));
    const { timestamp: previousTimestamp, ...previousContent } = previous;
    const { timestamp, ...nextContent } = tokenlist;
    if (typeof previousTimestamp === "string" &&
      JSON.stringify(previousContent) === JSON.stringify(nextContent)) {
      tokenlist.timestamp = previousTimestamp;
    }
  } catch {
    // Replace an unreadable or invalid generated file with fresh output.
  }
}
try {
  writeFileSync(outPath, JSON.stringify(tokenlist, null, 2), "utf8");
} catch (e) {
  console.error(`Error: could not write ${outName}:`, e.message);
  process.exit(1);
}
console.log(`Wrote ${outPath} with ${totalTokens} tokens across ${chains.length} chain(s).`);
