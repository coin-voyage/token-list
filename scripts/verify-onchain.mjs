/**
 * Checks every token's `decimals` against the chain it lives on.
 * Run: pnpm run verify:onchain            (add `-- --strict` to also fail on unverified tokens)
 *
 *   evm     eth_call decimals() (selector 0x313ce567)
 *   solana  getTokenSupply
 *   sui     suix_getCoinMetadata, or the GraphQL `coinMetadata` query on GraphQL endpoints
 *
 * Outcomes per token:
 *   ok            an endpoint returned the listed value
 *   MISMATCH      an endpoint returned a different value and no endpoint returned the listed one. Fails the run.
 *   inconclusive  an endpoint answered but gave no decimals (no contract at the address, revert,
 *                 not a mint, no metadata), or endpoints disagree with each other
 *   unreachable   no endpoint answered at all
 *   skipped       native tokens and chain families with nothing to query
 *
 * inconclusive and unreachable are listed but fail the run only with --strict, so one
 * flaky public RPC cannot block a pull request.
 *
 * Endpoints are public and keyless. Override per chain with a comma-separated list in
 * RPC_URLS_<chainId>, e.g. RPC_URLS_1=https://my-node.example,https://other.example
 * (Sui GraphQL endpoints are recognised by a path ending in /graphql).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSources, reportErrors } from "./lib/sources.mjs";

const DEFAULT_ENDPOINTS = {
  1: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://mainnet.gateway.tenderly.co"],
  10: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com", "https://optimism.drpc.org"],
  56: ["https://bsc-dataseed1.bnbchain.org", "https://bsc-rpc.publicnode.com", "https://bsc-dataseed1.defibit.io"],
  137: ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org", "https://polygon.gateway.tenderly.co"],
  8453: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.gateway.tenderly.co"],
  42161: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"],
  4663: ["https://robinhood-rpc.publicnode.com", "https://robinhood.drpc.org", "https://rpc.mainnet.chain.robinhood.com"],
  30000000000001: ["https://api.mainnet-beta.solana.com", "https://public.rpc.solanavibestation.com", "https://solana-mainnet.gateway.tatum.io"],
  // The public Sui fullnodes no longer serve JSON-RPC, so the official endpoint is the GraphQL one.
  30000000000002: ["https://graphql.mainnet.sui.io/graphql", "https://sui-rpc.publicnode.com", "https://sui-mainnet-endpoint.blockvision.org"],
};

const DECIMALS_SELECTOR = "0x313ce567";
const TIMEOUT_MS = 10_000;
const ATTEMPTS_PER_ENDPOINT = 3;
const RETRY_DELAY_MS = 750;

const strict = process.argv.includes("--strict");
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The endpoint could not give an answer (network, timeout, rate limit, server error). Worth retrying. */
class EndpointError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function postJson(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new EndpointError(e.name === "TimeoutError" ? `timed out after ${TIMEOUT_MS} ms` : (e.cause?.code ?? e.message));
  }
  if (!response.ok) throw new EndpointError(`HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new EndpointError("response was not JSON");
  }
}

/** Returns `{ result }` or `{ rpcError: { code, message } }`; transport problems throw EndpointError. */
async function jsonRpc(url, method, params) {
  const reply = await postJson(url, { jsonrpc: "2.0", id: 1, method, params });
  if (reply && reply.error) return { rpcError: { code: reply.error.code, message: String(reply.error.message ?? "") } };
  if (!reply || !("result" in reply)) throw new EndpointError("malformed JSON-RPC response");
  return { result: reply.result };
}

async function withRetries(task) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS_PER_ENDPOINT; attempt++) {
    try {
      return await task();
    } catch (e) {
      if (!(e instanceof EndpointError)) throw e;
      lastError = e;
      if (attempt < ATTEMPTS_PER_ENDPOINT) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

// Each reader resolves to { decimals: number } or { noDecimals: reason }, or throws EndpointError.

const evmChainIds = new Map(); // url -> Promise<number>: the chain each endpoint says it serves

/** An endpoint that serves another chain would return confident, wrong answers, so it is never trusted. */
async function assertEvmChain(url, chainId) {
  if (!evmChainIds.has(url)) {
    const lookup = (async () => {
      const reply = await jsonRpc(url, "eth_chainId", []);
      if (reply.rpcError || typeof reply.result !== "string") throw new EndpointError("eth_chainId failed");
      return Number(BigInt(reply.result));
    })();
    evmChainIds.set(url, lookup);
    lookup.catch(() => evmChainIds.delete(url)); // a failed lookup is retried, not remembered
  }
  const served = await evmChainIds.get(url);
  if (served !== chainId) throw new EndpointError(`endpoint serves chain ${served}, expected ${chainId}`);
}

async function readEvm(url, token) {
  await assertEvmChain(url, token.chainId);
  const reply = await jsonRpc(url, "eth_call", [{ to: token.address, data: DECIMALS_SELECTOR }, "latest"]);
  if (reply.rpcError) {
    if (/revert/i.test(reply.rpcError.message)) return { noDecimals: "decimals() reverted" };
    throw new EndpointError(`eth_call failed: ${reply.rpcError.message || reply.rpcError.code}`);
  }
  if (typeof reply.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(reply.result)) throw new EndpointError("malformed eth_call result");
  if (reply.result === "0x") {
    const code = await jsonRpc(url, "eth_getCode", [token.address, "latest"]);
    if (code.rpcError || typeof code.result !== "string") throw new EndpointError("eth_getCode failed");
    return { noDecimals: code.result === "0x" ? "no contract code at this address" : "contract returned no data for decimals()" };
  }
  if (reply.result.length !== 66) return { noDecimals: `decimals() returned ${reply.result.length / 2 - 1} bytes instead of 32` };
  const value = BigInt(reply.result);
  if (value > 255n) return { noDecimals: `decimals() returned ${value}, which is not a uint8` };
  return { decimals: Number(value) };
}

async function readSolana(url, token) {
  const reply = await jsonRpc(url, "getTokenSupply", [token.address]);
  if (reply.rpcError) {
    // -32602: the node looked the account up and it is missing or not an SPL mint.
    if (reply.rpcError.code === -32602 && /not a token mint|could not find/i.test(reply.rpcError.message)) {
      return { noDecimals: `not an SPL token mint (${reply.rpcError.message})` };
    }
    throw new EndpointError(`getTokenSupply failed: ${reply.rpcError.message || reply.rpcError.code}`);
  }
  const decimals = reply.result?.value?.decimals;
  if (!Number.isInteger(decimals)) throw new EndpointError("malformed getTokenSupply result");
  return { decimals };
}

async function readSui(url, token) {
  if (new URL(url).pathname.endsWith("/graphql")) {
    const reply = await postJson(url, {
      query: "query ($coinType: String!) { coinMetadata(coinType: $coinType) { decimals } }",
      variables: { coinType: token.address },
    });
    if (reply?.errors?.length) throw new EndpointError(`GraphQL error: ${reply.errors[0].message}`);
    if (!reply?.data || !("coinMetadata" in reply.data)) throw new EndpointError("malformed GraphQL response");
    if (reply.data.coinMetadata === null) return { noDecimals: "no coin metadata for this coin type" };
    const decimals = reply.data.coinMetadata.decimals;
    if (!Number.isInteger(decimals)) return { noDecimals: "coin metadata has no decimals" };
    return { decimals };
  }
  const reply = await jsonRpc(url, "suix_getCoinMetadata", [token.address]);
  if (reply.rpcError) throw new EndpointError(`suix_getCoinMetadata failed: ${reply.rpcError.message || reply.rpcError.code}`);
  if (reply.result === null) return { noDecimals: "no coin metadata for this coin type" };
  if (!Number.isInteger(reply.result?.decimals)) throw new EndpointError("malformed suix_getCoinMetadata result");
  return { decimals: reply.result.decimals };
}

const READERS = { evm: readEvm, solana: readSolana, sui: readSui };

function endpointsFor(chainId) {
  const override = process.env[`RPC_URLS_${chainId}`];
  if (override) return override.split(",").map((url) => url.trim()).filter(Boolean);
  return DEFAULT_ENDPOINTS[chainId] ?? [];
}

const host = (url) => new URL(url).host;

/** Asks endpoints in order until one confirms the listed value or all have been asked. */
async function verifyToken(entry, endpoints) {
  const { token, family } = entry;
  const different = []; // endpoints that returned another value
  const noDecimals = [];
  const failures = [];

  for (const url of endpoints) {
    let answer;
    try {
      answer = await withRetries(() => READERS[family](url, token));
    } catch (e) {
      if (!(e instanceof EndpointError)) throw e;
      failures.push(`${host(url)}: ${e.message}`);
      continue;
    }
    if ("decimals" in answer) {
      if (answer.decimals === token.decimals) {
        return different.length === 0
          ? { status: "ok" }
          : {
              status: "inconclusive",
              detail: `endpoints disagree: ${host(url)} returned ${answer.decimals}, ${different.map((d) => `${d.host} returned ${d.decimals}`).join(", ")}`,
            };
      }
      different.push({ host: host(url), decimals: answer.decimals });
      continue; // keep asking: a second endpoint either confirms the mismatch or exposes a bad endpoint
    }
    noDecimals.push(`${host(url)}: ${answer.noDecimals}`);
  }

  if (different.length > 0) {
    const values = [...new Set(different.map((d) => d.decimals))];
    if (values.length > 1) {
      return { status: "inconclusive", detail: `endpoints disagree: ${different.map((d) => `${d.host} returned ${d.decimals}`).join(", ")}` };
    }
    return { status: "mismatch", onchain: values[0], detail: `returned by ${different.map((d) => d.host).join(", ")}` };
  }
  if (noDecimals.length > 0) return { status: "inconclusive", detail: noDecimals.join("; ") };
  return { status: "unreachable", detail: failures.join("; ") };
}

const { errors, chains, tokens } = loadSources(rootDir);
if (reportErrors(errors)) process.exit(1);

const results = []; // { entry, status, detail?, onchain? }
const byChain = new Map();
for (const entry of tokens) {
  const { token, family, native } = entry;
  if (native) {
    results.push({ entry, status: "skipped", detail: "native token (no contract to query)" });
  } else if (!READERS[family]) {
    results.push({ entry, status: "skipped", detail: `no on-chain check for chain family "${family}"` });
  } else {
    if (!byChain.has(token.chainId)) byChain.set(token.chainId, []);
    byChain.get(token.chainId).push(entry);
  }
}

// Chains run in parallel; tokens within a chain run one at a time to stay under public rate limits.
await Promise.all(
  [...byChain].map(async ([chainId, entries]) => {
    const endpoints = endpointsFor(chainId);
    for (const entry of entries) {
      if (endpoints.length === 0) {
        results.push({ entry, status: "unreachable", detail: `no RPC endpoints configured for chainId ${chainId}; add them to DEFAULT_ENDPOINTS in scripts/verify-onchain.mjs` });
        continue;
      }
      results.push({ entry, ...(await verifyToken(entry, endpoints)) });
    }
  })
);

const order = new Map(tokens.map((entry, index) => [entry, index]));
results.sort((a, b) => order.get(a.entry) - order.get(b.entry));
const describe = ({ entry }) => `${entry.label} on ${chains.get(entry.token.chainId).name}${entry.native ? "" : ` (${entry.token.address})`}`;
const pick = (status) => results.filter((r) => r.status === status);

const sections = [
  ["skipped", "Skipped (not checked)", (r) => `${describe(r)}: ${r.detail}`],
  ["unreachable", "Unreachable (no endpoint answered)", (r) => `${describe(r)}: ${r.detail}`],
  ["inconclusive", "Inconclusive (an endpoint answered, but decimals could not be confirmed)", (r) => `${describe(r)}: listed ${r.entry.token.decimals}; ${r.detail}`],
  ["mismatch", "MISMATCH (listed decimals differ from the chain)", (r) => `${describe(r)}: listed ${r.entry.token.decimals}, on-chain ${r.onchain} (${r.detail})`],
];
for (const [status, title, format] of sections) {
  const rows = pick(status);
  if (rows.length === 0) continue;
  const print = status === "skipped" ? console.log : console.error;
  print(`\n${title}: ${rows.length}`);
  for (const row of rows) print(`  - ${format(row)}`);
}

const count = (status) => pick(status).length;
console.log(
  `\nOn-chain decimals: ${count("ok")} verified, ${count("mismatch")} mismatched, ${count("inconclusive")} inconclusive, ` +
    `${count("unreachable")} unreachable, ${count("skipped")} skipped (of ${results.length} tokens).`
);

const unverified = count("inconclusive") + count("unreachable");
if (count("mismatch") > 0) {
  console.error("Failed: listed decimals do not match the chain.");
  process.exit(1);
}
if (strict && unverified > 0) {
  console.error(`Failed (--strict): ${unverified} token(s) could not be verified.`);
  process.exit(1);
}
if (unverified > 0) console.log(`Note: ${unverified} token(s) could not be verified; run with --strict to treat that as a failure.`);
