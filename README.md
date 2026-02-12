# token-list

Single source of truth for supported chains and tokens. The consolidated **tokenlist.json** is generated from per-chain JSON files under `tokens/`.

---

## Adding a new token

1. Open the JSON file for the chain under `tokens/` (e.g. `tokens/ethereum.json`).
2. Add a token object to the array. Each token must have:

   | Field      | Type           | Required | Description                          |
   | ---------- | -------------- | -------- | ------------------------------------ |
   | `name`     | string         | yes      | Human-readable name                  |
   | `address`  | string \| null | yes      | Contract address (null for native)   |
   | `ticker`   | string         | yes      | Ticker (e.g. USDC, WETH)             |
   | `decimals` | number         | yes      | Token decimals                       |
   | `chainId`  | number         | yes      | Chain ID for this token              |
   | `logoURI`  | string         | no       | Logo URL                             |

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

3. Run `pnpm run build:tokenlist` to regenerate **tokenlist.json**.

---

## Adding a new chain and its tokens

1. **Add the chain to chains.json**  
   At the repo root, add an entry with `chainId`, `name`, and `logoURI`:

   ```json
   { "chainId": 137, "name": "Polygon", "logoURI": "https://..." }
   ```

2. **Create the token list for that chain**  
   Create `tokens/<chain>.json` (e.g. `tokens/polygon.json`) with a JSON **array** of token objects. Each token must include the same fields as above, with `chainId` matching the new chain (e.g. `137` for Polygon).

3. **Build**  
   Run `pnpm run build:tokenlist`. The new chain and its tokens appear in **tokenlist.json**.

If a chain has tokens but no entry in **chains.json**, the build falls back to the native token’s name/logo (or `"Chain <chainId>"`).

---

## Structure of the consolidated file (`tokenlist.json`)

The build outputs a single JSON file with:

| Field       | Type   | Description |
| ----------- | ------ | ----------- |
| `name`      | string | Token list name |
| `version`   | object | `{ major, minor, patch }` |
| `timestamp` | string | ISO build time |
| `chains`    | array  | Supported chains and their metadata, each with nested `tokens` |

**Each item in `chains`:**

| Field            | Type   | Description |
| ---------------- | ------ | ----------- |
| `chainId`        | number | Chain ID |
| `name`           | string | Chain display name (from **chains.json**) |
| `logoURI`        | string \| null | Chain logo (from **chains.json**) |
| `nativeCurrency` | object \| null | `{ symbol, decimals }` (from native token) |
| `tokens`         | array  | Tokens for this chain only |

Token objects inside `chains[].tokens` use the same shape as in the per-chain source files (`name`, `address`, `ticker`, `decimals`, `chainId`, optional `logoURI`).
