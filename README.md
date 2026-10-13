# token-list

Single source of truth for supported chains and tokens. The consolidated **tokenlist.json** is generated from `chains.json` and the per-chain JSON files under `tokens/`.

The scripts use only Node built-ins (Node 24, no dependencies to install). The `pnpm run …` commands below are shortcuts for `node scripts/….mjs`.

| Command | What it does |
| ------- | ------------ |
| `pnpm run validate` | Checks `chains.json` and `tokens/*.json`. Writes nothing. |
| `pnpm run verify:onchain` | Compares every token's `decimals` with the chain (needs network access). |
| `pnpm run build` | Validates, then regenerates `tokenlist.json` and `tokenlist.preview.json`. |

---

## Consuming the list

Read the generated files at the **`v1`** tag, not at `main`:

```
https://raw.githubusercontent.com/coin-voyage/token-list/v1/tokenlist.json
https://raw.githubusercontent.com/coin-voyage/token-list/v1/tokenlist.preview.json
```

`v1` is a moving tag. CI advances it only after a commit on `main` has passed validation and the on-chain check and the regenerated lists are committed, so it never points at a half-updated or unvalidated state. `main` can briefly hold sources whose generated files have not been rebuilt yet; `v1` cannot.

---

## Adding a new token

1. Open the JSON file for the chain under `tokens/` (e.g. `tokens/ethereum.json`).
2. Add a token object to the array:

   | Field      | Type           | Required | Description                                                  |
   | ---------- | -------------- | -------- | ------------------------------------------------------------ |
   | `name`     | string         | yes      | Human-readable name                                          |
   | `address`  | string \| null | no       | Contract address. Omit it or use `null` for the native token |
   | `ticker`   | string         | yes      | Ticker (e.g. USDC, WETH)                                     |
   | `decimals` | number         | yes      | Token decimals, exactly as the contract reports them         |
   | `chainId`  | number         | yes      | Chain ID for this token; must match the rest of the file     |
   | `logoURI`  | string         | no       | Logo URL (https)                                             |

   Example:

   ```json
   {
     "name": "USD Coin",
     "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
     "ticker": "USDC",
     "decimals": 6,
     "chainId": 1,
     "logoURI": "https://..."
   }
   ```

   Copy the address from a block explorer in the format for the chain (see [What validation enforces](#what-validation-enforces)). Read `decimals` from the contract, not from another token with the same ticker: the same asset often has different decimals on different chains.

3. Run `pnpm run validate` and `pnpm run verify:onchain`, and fix anything they report.
4. Run `pnpm run build` and commit the source file together with the regenerated **tokenlist.json** and **tokenlist.preview.json**. CI fails a pull request whose generated files are out of date.

---

## What validation enforces

`pnpm run validate` runs on its own and as the first step of every build. Any problem fails the command with a message naming the file and the entry, and nothing is written; entries are never skipped or dropped.

**Every token**

- `name` and `ticker` are non-empty strings; `decimals` is an integer from 0 to 255; `logoURI`, when present, is an https URL.
- No fields other than the six in the table above (catches typos such as `logoUrl`).
- `chainId` exists in `chains.json`.
- All tokens in one file have the same `chainId`, and each chain has only one file.
- No duplicates: an address may appear once per chain (EVM addresses are compared case-insensitively), and a chain has at most one native token.

**Address, by the chain's `family` in `chains.json`**

| `family` | Chains                          | `address` must be |
| -------- | ------------------------------- | ----------------- |
| `evm`    | Ethereum, Base, Optimism, …     | `0x` + 40 hex characters with a valid [EIP-55](https://eips.ethereum.org/EIPS/eip-55) checksum. All-lowercase or all-uppercase addresses are rejected; the error shows the checksummed form. The zero address is rejected (omit `address` for the native token). |
| `solana` | Solana                          | A base58 mint address that decodes to 32 bytes. |
| `sui`    | Sui                             | A coin type `0x<lowercase hex>::module::Name`. `0x2::sui::SUI` is rejected (omit `address` for native SUI). |
| `utxo`   | Bitcoin, Zcash                  | Omitted or `null`. These chains only have their native asset. |

The native token of any chain is the entry with `address` omitted or `null`; both are accepted and the generated files always omit the field.

**On-chain check**

`pnpm run verify:onchain` reads `decimals` from the chain for every non-native token: `decimals()` on EVM chains, `getTokenSupply` on Solana, coin metadata on Sui. It asks several public RPC endpoints per chain, with retries and a timeout.

- A token **fails** when the chain returns a different value than the list.
- Tokens that could not be confirmed (no endpoint answered, or the address has no contract / is not a mint) are listed separately. They fail the run only with `pnpm run verify:onchain -- --strict`.
- Native tokens and `utxo` chains are skipped and listed as skipped.

To use your own nodes, set `RPC_URLS_<chainId>` to a comma-separated list, e.g. `RPC_URLS_1=https://…`. A new chain needs endpoints added to `DEFAULT_ENDPOINTS` in `scripts/verify-onchain.mjs`; until then its tokens are reported as unreachable.

**CI** (`.github/workflows/tokenlist.yml`) runs validation, the on-chain check and the build on every pull request and every push to `main`. On `main` it then commits the regenerated lists if they changed and moves `v1` to that commit.

---

## Adding a new chain and its tokens

1. **Add the chain to chains.json**  
   At the repo root, add an entry with `chainId`, `name`, `family` and `logoURI`:

   ```json
   { "chainId": 137, "name": "Polygon", "family": "evm", "logoURI": "https://..." }
   ```

   `family` is one of `evm`, `solana`, `sui`, `utxo` and selects the address rules above. A chain that fits none of them needs its own rules added to `scripts/lib/sources.mjs` first.

2. **Create the token list for that chain**  
   Create `tokens/<chain>.json` (e.g. `tokens/polygon.json`) with a JSON **array** of token objects. Each token must include the same fields as above, with `chainId` matching the new chain (e.g. `137` for Polygon).

3. **Add RPC endpoints** for the chain to `DEFAULT_ENDPOINTS` in `scripts/verify-onchain.mjs` (at least two).

4. **Build**  
   Run `pnpm run build`. The new chain and its tokens appear in **tokenlist.json**.

A token whose `chainId` has no entry in **chains.json** fails validation. A chain in **chains.json** without a token file is left out of the generated lists.

### Adding a chain before production rollout

Set `"preview": true` on its entry in `chains.json`. The chain and all its tokens
are excluded from `tokenlist.json`, including CI builds, and appear only in
`tokenlist.preview.json`. Chains with `"preview": false` or without this field appear
in both lists. Preview chains are validated and checked on-chain like any other.

No chain is in preview at the moment (Zcash was released and is in both lists), so the
two generated files currently have the same content.
Point the development app at `tokenlist.preview.json`; production should continue
consuming `tokenlist.json`. Commit both generated lists so development can fetch the
preview list through its GitHub raw URL. CI builds and checks both files, and updates
them on main.

To release a chain, remove `"preview": true` (or change it to `false`) and rebuild.
The build requires a readable, valid `chains.json` so a broken config cannot bypass
production exclusions.

---

## Structure of the consolidated file (`tokenlist.json`)

The build outputs a single JSON file with:

| Field       | Type   | Description |
| ----------- | ------ | ----------- |
| `name`      | string | Token list name |
| `version`   | object | `{ major, minor, patch }` |
| `timestamp` | string | ISO time of the last build that changed the content |
| `chains`    | array  | Supported chains and their metadata, each with nested `tokens` |

**Each item in `chains`:**

| Field            | Type   | Description |
| ---------------- | ------ | ----------- |
| `chainId`        | number | Chain ID |
| `name`           | string | Chain display name (from **chains.json**) |
| `logoURI`        | string \| null | Chain logo (from **chains.json**) |
| `nativeCurrency` | object \| null | `{ symbol, decimals }` (from native token) |
| `tokens`         | array  | Tokens for this chain only |

Token objects inside `chains[].tokens` use the same shape as in the per-chain source files (`name`, `address`, `ticker`, `decimals`, `chainId`, optional `logoURI`). `address` is absent for the native token. EVM addresses are EIP-55 checksummed, so compare them case-insensitively.
