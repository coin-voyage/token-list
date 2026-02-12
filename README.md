# token-list

Single source of truth for supported chains and tokens. The consolidated **tokenlist.json** is generated from per-chain JSON files and can be consumed via the GitHub raw URL once the repo is public.

## Flow

1. **Add or edit tokens**  
   - Add tokens to existing files under `tokens/` (e.g. `tokens/ethereum.json`).  
   - Or add a new chain by creating `tokens/<chain>.json` with an array of tokens (each token must include `chainId`).

2. **Build the consolidated list**  
   ```bash
   pnpm install
   pnpm run build:tokenlist
   ```  
   This writes **tokenlist.json** at the repo root.

3. **Use the list**  
   Commit and push `tokenlist.json`. Anyone can use it via the raw GitHub URL, e.g.:  
   `https://raw.githubusercontent.com/<owner>/<repo>/main/tokenlist.json`

## Token shape

Each token in a chain JSON file must have:

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

## Adding a new chain

1. Create `tokens/<chain>.json` (e.g. `tokens/polygon.json`).
2. Put a JSON **array** of token objects; each must include `chainId` (e.g. `137` for Polygon).
3. Run `pnpm run build:tokenlist`. The new chain is included automatically.

No other config or code changes are required.
