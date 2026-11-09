# Up Bank

Reads the household's spending from Up Bank's API: two months of transactions, spend by Up's own categories, top merchants, what still needs a category. `iot_class`: **cloud_polling**, every 15 minutes. Built from KO's design in [docs/up.md](../../../docs/up.md); one live read on 2026-10-16. The writes (a category, a tag, webhooks) are built and untried.

## Built

- **`client.ts`**: `upClient({ token, fetch })`. Reads: `ping`, `accounts(filter)`, `transactions(query)` following cursors to `limit` (default 1000) and `pageCap` (20) and returning `{ transactions, truncated }` so a cut-off list never looks complete, `transaction(id)`, `categories`, `tags`, `webhooks`, `webhook(id)`, `webhookLogs(id)`. Writes: `setCategory(id, categoryId | null)`, `addTags(id, labels)`, `removeTags(id, labels)`, each re-reading and returning the transaction as Up now holds it; `createWebhook`, `deleteWebhook`, `pingWebhook`. A transaction is flattened to cents (Up's `valueInBaseUnits`) and ids.
- **`spend.ts`**, pure, one owner per number. `notSpend(t)` is the rule and says why: held, money in, `transferAccount` set (a movement between your own accounts), or a description Up gives its own movements ("Cover from", "Forward to", "Round Up", "Quick save transfer"). "Transfer to …" is not on the list: paying someone else is spend. `isSpend`, `spendByCategory` (parents and children, excluded movements counted and summed so a total can be checked), `spendByMerchant`, `uncategorised` (spend with no category; money in is categorisable too but left out), `recurring` (a heuristic: three or more months within 20% of the median), `unusual` (over twice the median of three or more earlier purchases at that merchant), `dollars` for display.
- **`webhook.ts`**: `verifyWebhook(rawBody, signature, secret)`, the SHA-256 HMAC of the raw body in hex, Web Crypto, compared in constant time; `parseWebhookEvent(body)` gives the event type and the transaction id. A consumer's handler verifies, then calls `home.refresh("up")`.
- **The integration** (`up({ token, account?, timeZone?, fetch })`, with `client` on it for a consumer's writes): every 15 minutes it reads the categories, the accounts the filter names, and 63 days of transactions, then cuts this month and last in the home's time zone. The snapshot holds each month's spend by category and top five merchants, the ids still to categorise, and the latest 20 purchases trimmed to id, time, description, amount, category, status and tags (movements between your own accounts are left out: their descriptions name the accounts). Never kept: raw text, message, note, who spent (`performingCustomer`), account ids, balances. A 401 is `unavailable`; a read that hit its page cap is an `anomaly`, as is an amount missing or not in AUD. It never writes.
- **Config**: `{ connector: "up", key: "UP_TOKEN", account: { ownershipType: "JOINT", accountType: "TRANSACTIONAL" } }`. Accounts are chosen by type and ownership, never by id. Without `account`, every account is read; transfers between them are excluded by `transferAccount`.
- **CLI**: `home up` (this month, last month, to categorise, top five categories), `home up transactions [--since] [--until] [--category] [--tag] [--status] [--limit] [--json|--csv]`, `categories`, `uncategorised`, `spend [--by category|merchant|recurring]`, and the writes `categorise <id> <category|none>`, `tag <id> <label> [--remove]`, `webhooks [get|logs|ping|create|delete]`. `UP_ACCOUNT` ("JOINT TRANSACTIONAL") is the filter's env form.
- **Household filter** (`household: { categories, tags }` in the config, `UP_HOUSEHOLD="home tag:home"` in env): the totals, top merchants and recent rows count only purchases in a listed category or its parent, or with a listed tag, so a family dashboard shows groceries and utilities, not personal spending. Tag anything else `home` in the Up app to bring it in. "To categorise" still looks at every purchase, since a category is how one joins. A listed category Up does not have is an `anomaly`, not a silent zero. `inHousehold` is the one owner of the rule; `home up spend` applies it too. `webhooks create` writes the secret Up returns once to `~/.config/home/up-webhook-<id>.secret` (0600); it is never printed.

## The API

`https://api.up.com.au/api/v1`, a bearer token, JSON:API shapes. Only child categories can be set; `data: null` clears one. At most six tags per transaction, by label. Pages of up to 100, `links.next` an absolute URL. No published rate limit: `X-RateLimit-Remaining` answered 997 on the first read. Webhook events: `TRANSACTION_CREATED`, `TRANSACTION_SETTLED`, `TRANSACTION_DELETED`, `PING`, signed in `X-Up-Authenticity-Signature`.

## Unverified

- Whether a category set through the API teaches Up about that merchant. The first live write, on one transaction, then the next purchase there, answers it.
- Covers, forwards and round-ups without a `transferAccount` are matched by description, which Up could change.
- Every write, the webhook calls and `verifyWebhook` against a real Up signature (tested against Node's `createHmac`).

## Live, 2026-10-16 (Bun 1.4.3)

- 44 categories under 4 parents: `good-life`, `personal`, `home`, `transport`. `home` holds `groceries`, `utilities`, `internet`, `rent-and-mortgage` and four more.
- Fields beyond the spec: `transactionType` ("Purchase", "Payment", "International Purchase", "Salary", "Osko Payment Received"), `note`, `performingCustomer.displayName`, `deepLinkURL`. A transfer between own accounts has `transferAccount` set and no category.
- Accounts come as TRANSACTIONAL or SAVER, INDIVIDUAL or JOINT.
- One integration read of two months: 4.0 s for one account, 6.2 s for every account, under the page cap. Salary and payments received are categorisable with no category, which is why "to categorise" counts spend only.

## Sources

- [Up API docs](https://developer.up.com.au/) and [OpenAPI spec](https://github.com/up-banking/api/blob/master/v1/openapi.json) (Up's own).
- [fane-ye/up-bank-mcp](https://github.com/fane-ye/up-bank-mcp) (no licence, read for the endpoint list), [xaviershay/up-finance-skills](https://github.com/xaviershay/up-finance-skills) (the spend exclusions), [edkranz/up-mcp](https://github.com/edkranz/up-mcp) (MIT). No code copied.
