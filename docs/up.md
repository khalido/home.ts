# Up Bank: the money connector

Proposed 2026-10-14 from two Sonnet research passes over [Up's API](https://developer.up.com.au/), its [OpenAPI spec](https://github.com/up-banking/api/blob/master/v1/openapi.json), [fane-ye/up-bank-mcp](https://github.com/fane-ye/up-bank-mcp), [xaviershay/up-finance-skills](https://github.com/xaviershay/up-finance-skills) and [edkranz/up-mcp](https://github.com/edkranz/up-mcp). Built 2026-10-16 as `src/connectors/up/`; its README says what the live read found and what is still unverified. This page stays as the design.

**Short answer.** A connector like the others: `src/connectors/up/`, `iot_class` cloud_polling every 15 minutes, one token (`UP_TOKEN`) over `fetch`, zod schemas, about 150 lines plus pure helpers. It reads; the two writes Up allows (category, tags) are methods on the object and explicit `home up` verbs, never called by the integration, the same gate as Cast. No MCP: an agent drives it through the library or the CLI, which already exist.

## What KO wants from it

Surface the household's spending to the kids through the home bot, so "utilities" and "groceries" are real numbers from real purchases. Let an agent or the CLI pull the latest transactions (JSON or CSV), see Up's categories, find what still needs a category, and set one so Up's auto-categorisation improves. The library stays deterministic; an agent (or Jev) decides what to tag, the library applies it.

## What the three repos taught

- **up-bank-mcp** is a thin wrapper: 20 tools, raw API JSON back, no shaping, no transfer exclusion, writes report success without reading the result. No licence; read for the endpoint list only.
- **up-finance-skills** has the useful idea: a transaction is *spend* only after excluding transfers between own accounts, covers, forwards, round-ups and interest, and every report carries a validation block (date range, raw and filtered counts, categories reconciling to the total). It matches those movements by description text, which is fragile; the API gives `transferAccount` for own-account transfers and `roundUp` on the purchase, but names no field for cover and forward (**unconfirmed** beyond description matching).
- **up-mcp**: thin, MIT, 2025.

## The API facts that shape it

- Child categories only can be assigned; parents are rejected; `isCategorizable` must be true. `PATCH …/relationships/category` with `data: null` uncategorises (204). `filter[category]` accepts a parent and returns its children's transactions.
- Tags: at most 6 per transaction, identified by label; duplicate adds and absent removals are ignored.
- Whether a category set through the API teaches Up about that merchant is **not documented**: the first live write on one transaction, then the next purchase from that merchant, answers it.
- HELD versus SETTLED: `holdInfo` keeps the held amounts; `amount` is the settled value; `settledAt` null while held. `foreignAmount` null for domestic. `cashback.amount` positive.
- No rate limit published: read `X-RateLimit-Remaining`, back off on 429. Webhooks need a public URL and an HMAC check: jaldi's or the bot's job, not the library's.
- The token can write (categories, tags, webhooks). Read-only is this connector's discipline: GETs in the integration, writes only through the two methods.

## Surface

**`client.ts`** (`{ fetch, token }` in, zod-typed values out, every field optional):

- Reads: `accounts()`, `transactions({ since, until, status, category, tag, accountId, limit })` following cursors to `limit` and a page cap and returning `{ transactions, truncated }` so a cut-off result never looks complete; `transaction(id)`; `categories()`; `tags()`; `ping()`.
- Writes: `setCategory(id, categoryId | null)`, `addTags(id, labels)`, `removeTags(id, labels)`. Each re-reads the transaction and returns it, so the caller sees what Up now holds.

**`spend.ts`**, pure functions over `Transaction[]`, one owner per number:

- `isSpend(t)`: settled, amount below zero, no `transferAccount`, not a round-up movement, description not on the cover/forward list. The one place that rule lives.
- `spendByCategory(txs, categories, window)` grouped to parents by the tree; `spendByMerchant(txs)`.
- `uncategorised(txs)`: categorisable with no category.
- `recurring(txs)`: the same normalised merchant in three or more distinct months at a similar amount; labelled a heuristic, since Up has no subscription endpoint.
- `unusual(txs)`: an amount well above that merchant's median with three or more prior samples.
- Anything odd (a missing amount, held and settled differing) goes to `anomaly`, never clamped.

**State** in the snapshot: the window (month to date and last month), `asOf`, totals with the excluded transfers counted and summed so a figure is auditable, spend by parent and child category, top merchants, the uncategorised ids, the last 20 transactions trimmed to id, time, description, amount, category, status, tags. Not kept: `rawText`, `message`, balances, account ids, attachments, the full history.

**CLI**, `home up …`:

| Verb | Prints | |
|---|---|---|
| `home up` | the window, spend, top five categories, uncategorised count | read |
| `home up transactions [--since] [--until] [--category] [--tag] [--status] [--json\|--csv]` | trimmed rows | read |
| `home up categories` | the tree with ids | read |
| `home up uncategorised` | categorisable transactions with no category | read |
| `home up spend [--by category\|merchant]` | the helper's output | read |
| `home up categorise <id> <category\|none>` | the transaction before and after | **write** |
| `home up tag <id> <tag> [--remove]` | the transaction before and after | **write** |

No bulk "fix all" verb. Writes exist so an agent with its own judgement can act one transaction at a time.

## Webhooks

Polling stays the source of truth; a webhook only makes it faster. Up posts an event when a transaction is created, settled or deleted; the library has no server, so receiving it is the bot's or the sidecar's job, and the whole handler is one line: verify, then `home.refresh("up")`, which makes the integration read now. The snapshot shape, `isSpend` and the helpers do not change. The same pattern holds for any future connector with a push side: the push nudges the poll.

What the library carries so a consumer needs nothing else:

- **Client**: `webhooks()`, `webhook(id)`, `webhookLogs(id)` as reads; `createWebhook(url, description)`, `deleteWebhook(id)`, `pingWebhook(id)` as writes, gated like the others. The `secretKey` comes back once, on creation; the client returns it and never stores or logs it.
- **A pure `verifyWebhook(rawBody, signatureHeader, secret)`** over Web Crypto (HMAC-SHA256, constant-time compare), runtime-neutral, and `parseWebhookEvent(body)` returning the event type and the transaction id.
- **CLI**: `home up webhooks` (list), `home up webhooks get|logs <id>`, `home up webhooks ping <id>`, and `create <url>` and `delete <id>` as writes behind KO's hand.

When to set one up: only when the bot should say "a purchase just happened" within seconds. For a daily or on-demand summary, the 15-minute poll is enough, and the bot needs no public URL. (Hue already pushes over its event stream; Amber's v1 API has no webhooks.)

## The message to the kids

Only numbers the API returned, through `spendByCategory`, with Up's own category names and the excluded transfers stated. The shape, with invented figures: "October so far: $2,140 on the house. Groceries $620, utilities $410 (power $230, water $90), eating out $180. Up from $1,980 last month. 3 purchases still need a category." No budgets, no "you saved", no judgement; the bot adds those if KO wants them.

## Privacy

The token is never printed. Nothing real in the repo, fixtures or tests: fixtures come from the docs' example payloads. Balances, account names, `message` and `rawText` do not reach the bot by default. Everything lives in memory; the library writes nothing to disk.

## Build the writes from the start

Yes. Three endpoints, about 30 lines, reversible (a category resets to null, a tag comes off). The gate is the design: methods on the object, explicit single-transaction verbs, the integration never writes, and the first live write is KO's on one transaction, which also answers whether Up learns from it.

## Before building

One live `GET /categories` and one `GET /transactions?page[size]=5` with the token (field names and category ids only, nothing kept) to confirm the ids and the transfer and round-up shapes. KO names the env variable; it is not in `.zshrc`, `.zprofile` or `.zshenv`.
