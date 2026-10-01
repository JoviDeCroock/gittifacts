# @fixture/lib

Small money helpers that keep amounts in **integer minor units** (cents for EUR/USD/GBP,
yen for JPY), plus compact HMAC-signed session tokens.

```ts
import { add, allocate, formatMoney, money, parseMoney } from "@fixture/lib";

const rent = money(150000, "EUR"); // €1500.00
const split = allocate(rent, [1, 1, 1]); // three shares that add up to exactly €1500.00
formatMoney(add(split[0], split[1])); // "1000.00 EUR"
parseMoney("12.50 USD"); // { amount: 1250, currency: "USD" }
```

```ts
import { signToken, verifyToken } from "@fixture/lib";

const token = await signToken({ sub: "user_42", exp: now + 3600 }, secret);
await verifyToken(token, secret); // { sub: "user_42", exp: ... } or null
```

## API

| Export | Module | What it does |
|---|---|---|
| `Money`, `CurrencyCode` | `src/money.ts` | Value type: `{ amount, currency }` in minor units. |
| `money(amount, currency)` | `src/money.ts` | Validating constructor (safe integers, known currencies). |
| `add(a, b)`, `subtract(a, b)` | `src/money.ts` | Same-currency arithmetic. |
| `multiply(value, factor)` | `src/money.ts` | Scale by a factor, rounding halves away from zero. |
| `allocate(total, ratios)` | `src/allocate.ts` | Proportional split that never loses a minor unit. |
| `formatMoney(value)`, `parseMoney(text)` | `src/format.ts` | Locale-independent `1234.56 EUR` text form. |
| `TokenClaims`, `signToken`, `verifyToken` | `src/auth/token.ts` | HMAC-SHA256 session tokens (Web Crypto). |

`src/internal/` holds helpers shared between modules; they are not part of the public API.

## Development

```sh
pnpm install
pnpm test        # vitest
pnpm run build   # tsc → dist/ (JS + .d.ts)
```

Repository automation lives in `.platform/`: `policy.ts` (review policy) and `ci.ts` (pipeline).
