/**
 * Validates chains.json and tokens/*.json without writing anything.
 * Run: pnpm run validate
 * Exits with code 1 and one line per problem (file + entry) when anything is wrong.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSources, reportErrors } from "./lib/sources.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const { errors, chains, tokens } = loadSources(rootDir);
if (reportErrors(errors)) process.exit(1);
console.log(`OK: ${tokens.length} tokens across ${new Set(tokens.map((t) => t.token.chainId)).size} chain(s); ${chains.size} chain(s) in chains.json.`);
