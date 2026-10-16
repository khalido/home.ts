import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { Clock, Part } from "../src/index.ts";
import { loadHome } from "../src/index.ts";
import {
  dollars,
  type Household,
  isSpend,
  manifest,
  merchantKey,
  notSpend,
  parseWebhookEvent,
  recurring,
  spendByCategory,
  spendByMerchant,
  toSnapshot,
  type Transaction,
  uncategorised,
  unusual,
  up,
  upClient,
  type UpSnapshot,
  verifyWebhook,
} from "../src/connectors/up/index.ts";
import { toTransaction } from "../src/connectors/up/client.ts";

// Invented transactions in Up's resource shape (developer.up.com.au); never a real one.
type TxIn = { id: string; amount: number; description?: string; status?: string; createdAt: string; category?: string; parent?: string; transfer?: string; categorizable?: boolean; tags?: string[] };
const resource = (t: TxIn) => ({
  type: "transactions",
  id: t.id,
  attributes: {
    status: t.status ?? "SETTLED",
    rawText: "RAW TEXT 0000",
    description: t.description ?? "Example Grocer",
    message: null,
    isCategorizable: t.categorizable ?? true,
    holdInfo: { amount: { currencyCode: "AUD", value: (t.amount / 100).toFixed(2), valueInBaseUnits: t.amount }, foreignAmount: null },
    roundUp: null,
    cashback: null,
    amount: { currencyCode: "AUD", value: (t.amount / 100).toFixed(2), valueInBaseUnits: t.amount },
    foreignAmount: null,
    cardPurchaseMethod: null,
    settledAt: t.status === "HELD" ? null : t.createdAt,
    createdAt: t.createdAt,
    transactionType: "Purchase",
    note: null,
    performingCustomer: { displayName: "Someone" },
    deepLinkURL: "up://transaction/x",
  },
  relationships: {
    account: { data: { type: "accounts", id: "acct-1" } },
    transferAccount: { data: t.transfer ? { type: "accounts", id: t.transfer } : null },
    category: { data: t.category ? { type: "categories", id: t.category } : null },
    parentCategory: { data: t.parent ? { type: "categories", id: t.parent } : null },
    tags: { data: (t.tags ?? []).map((id) => ({ type: "tags", id })) },
  },
});
const tx = (t: TxIn): Transaction => toTransaction(resource(t));

const categories = [
  { id: "home", name: "Home" },
  { id: "groceries", name: "Groceries", parentId: "home" },
  { id: "utilities", name: "Utilities", parentId: "home" },
  { id: "good-life", name: "Good Life" },
  { id: "takeaway", name: "Takeaway", parentId: "good-life" },
];
const categoriesBody = {
  data: categories.map((c) => ({ type: "categories", id: c.id, attributes: { name: c.name }, relationships: { parent: { data: c.parentId ? { type: "categories", id: c.parentId } : null }, children: { data: [] } } })),
};

/** A fake Up: routes by path, records every call. */
function fakeUp(routes: Record<string, (url: URL, init?: RequestInit) => Response | Promise<Response>>) {
  const calls: { method: string; url: URL; body?: unknown }[] = [];
  const f = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes).find((k) => `${init?.method ?? "GET"} ${url.pathname}`.endsWith(k));
    return key ? routes[key]!(url, init) : new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("client", () => {
  test("a transaction flattens to cents and ids; who spent and the raw text are read but kept apart", () => {
    const t = tx({ id: "t1", amount: -1250, createdAt: "2026-10-03T09:00:00+11:00", category: "groceries", parent: "home", tags: ["weekly"] });
    expect(t).toMatchObject({ id: "t1", amountCents: -1250, currency: "AUD", heldCents: -1250, categoryId: "groceries", parentCategoryId: "home", tags: ["weekly"], status: "SETTLED", performedBy: "Someone" });
    expect(t.transferAccountId).toBeUndefined();
    expect(tx({ id: "t2", amount: -500, createdAt: "2026-10-03T09:00:00+11:00", transfer: "acct-2" }).transferAccountId).toBe("acct-2");
  });

  test("transactions follow the cursor to the limit and say when they were cut short", async () => {
    const page = (ids: string[], next?: string) => json({ data: ids.map((id) => resource({ id, amount: -100, createdAt: "2026-10-01T00:00:00Z" })), links: { prev: null, next: next ?? null } });
    const { f, calls } = fakeUp({
      "GET /api/v1/accounts/acct-9/transactions": (u) => (u.searchParams.get("page[after]") ? page(["c", "d"], "https://api.up.com.au/api/v1/accounts/acct-9/transactions?page[after]=2") : page(["a", "b"], "https://api.up.com.au/api/v1/accounts/acct-9/transactions?page[after]=1")),
    });
    const r = await upClient({ token: "t", fetch: f }).transactions({ accountId: "acct-9", since: "2026-09-01T00:00:00.000Z", status: "SETTLED", limit: 3 });
    expect(r.transactions.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(r.truncated).toBe(true);
    expect(calls[0]!.url.searchParams.get("filter[since]")).toBe("2026-09-01T00:00:00.000Z");
    expect(calls[0]!.url.searchParams.get("filter[status]")).toBe("SETTLED");
    expect(calls[0]!.url.searchParams.get("page[size]")).toBe("3");
    const all = await upClient({ token: "t", fetch: fakeUp({ "GET /api/v1/transactions": () => page(["x"]) }).f }).transactions();
    expect(all).toEqual({ transactions: [expect.objectContaining({ id: "x" })], truncated: false });
  });

  test("a category write PATCHes the relationship, then re-reads; none clears it; tags POST and DELETE by label", async () => {
    const { f, calls } = fakeUp({
      "PATCH /api/v1/transactions/t1/relationships/category": () => new Response(null, { status: 204 }),
      "POST /api/v1/transactions/t1/relationships/tags": () => new Response(null, { status: 204 }),
      "DELETE /api/v1/transactions/t1/relationships/tags": () => new Response(null, { status: 204 }),
      "GET /api/v1/transactions/t1": () => json({ data: resource({ id: "t1", amount: -100, createdAt: "2026-10-01T00:00:00Z", category: "groceries", tags: ["weekly"] }) }),
    });
    const c = upClient({ token: "t", fetch: f });
    expect((await c.setCategory("t1", "groceries")).categoryId).toBe("groceries");
    await c.setCategory("t1", null);
    await c.addTags("t1", ["weekly"]);
    await c.removeTags("t1", ["weekly"]);
    expect(calls.map((x) => `${x.method} ${x.url.pathname.replace("/api/v1", "")}`)).toEqual([
      "PATCH /transactions/t1/relationships/category", "GET /transactions/t1",
      "PATCH /transactions/t1/relationships/category", "GET /transactions/t1",
      "POST /transactions/t1/relationships/tags", "GET /transactions/t1",
      "DELETE /transactions/t1/relationships/tags", "GET /transactions/t1",
    ]);
    expect(calls[0]!.body).toEqual({ data: { type: "categories", id: "groceries" } });
    expect(calls[2]!.body).toEqual({ data: null });
    expect(calls[4]!.body).toEqual({ data: [{ type: "tags", id: "weekly" }] });
  });

  test("a rejected token is an UpError with status 401", async () => {
    const c = upClient({ token: "bad", fetch: fakeUp({ "GET /api/v1/util/ping": () => json({ errors: [] }, 401) }).f });
    await expect(c.ping()).rejects.toMatchObject({ name: "UpError", status: 401 });
  });
});

describe("spend", () => {
  const at = "2026-10-05T10:00:00+11:00";
  test("spend is settled money out to someone else; the reason is named when it is not", () => {
    expect(notSpend(tx({ id: "a", amount: -100, createdAt: at, status: "HELD" }))).toBe("held");
    expect(notSpend(tx({ id: "b", amount: 100, createdAt: at }))).toBe("money in");
    expect(notSpend(tx({ id: "c", amount: -100, createdAt: at, transfer: "saver" }))).toBe("transfer between your accounts");
    expect(notSpend(tx({ id: "d", amount: -100, createdAt: at, description: "Cover from Rainy Day" }))).toBe("cover, forward or round-up");
    expect(notSpend(tx({ id: "e", amount: -100, createdAt: at, description: "Round Up" }))).toBe("cover, forward or round-up");
    expect(isSpend(tx({ id: "f", amount: -100, createdAt: at, description: "Transfer to A Plumber" }))).toBe(true); // paying someone else is spend
    expect(isSpend(tx({ id: "g", amount: -100, createdAt: at }))).toBe(true);
  });

  test("by category: parents with children, largest first; what was left out counted and summed", () => {
    const txs = [
      tx({ id: "1", amount: -6000, createdAt: at, category: "groceries", parent: "home" }),
      tx({ id: "2", amount: -4000, createdAt: at, category: "utilities", parent: "home" }),
      tx({ id: "3", amount: -2500, createdAt: at, category: "takeaway", parent: "good-life" }),
      tx({ id: "4", amount: -900, createdAt: at }),
      tx({ id: "5", amount: -50000, createdAt: at, transfer: "saver" }),
      tx({ id: "6", amount: 200000, createdAt: at, description: "Salary" }),
    ];
    const s = spendByCategory(txs, categories);
    expect(s).toMatchObject({ cents: 13400, count: 4, excluded: { count: 1, cents: 50000 }, uncategorisedCents: 900 });
    expect(s.byCategory.map((p) => [p.name, p.cents, p.children.map((c) => [c.name, c.cents])])).toEqual([
      ["Home", 10000, [["Groceries", 6000], ["Utilities", 4000]]],
      ["Good Life", 2500, [["Takeaway", 2500]]],
    ]);
    expect(spendByCategory(txs, categories, { since: "2026-11-01" }).cents).toBe(0);
  });

  test("by merchant: one row per merchant whatever the store number", () => {
    expect(merchantKey("WOOLWORTHS 1234 SYDNEY")).toBe("woolworths sydney");
    const m = spendByMerchant([
      tx({ id: "1", amount: -1000, createdAt: at, description: "Example Grocer 0001" }),
      tx({ id: "2", amount: -3000, createdAt: at, description: "Example Grocer 0002" }),
      tx({ id: "3", amount: -500, createdAt: at, description: "Corner Cafe" }),
    ]);
    expect(m.map((x) => [x.cents, x.count])).toEqual([[4000, 2], [500, 1]]);
  });

  test("uncategorised: categorisable spend with no category; money in is left out", () => {
    const list = uncategorised([tx({ id: "1", amount: -100, createdAt: at }), tx({ id: "2", amount: -100, createdAt: at, category: "groceries" }), tx({ id: "3", amount: -100, createdAt: at, categorizable: false }), tx({ id: "4", amount: 5000, createdAt: at, description: "Salary" })]);
    expect(list.map((t) => t.id)).toEqual(["1"]);
  });

  test("recurring: three months at a similar amount; a merchant that varies is not", () => {
    const months = ["2026-08-03", "2026-09-03", "2026-10-03"];
    const txs = [
      ...months.map((d, i) => tx({ id: `s${i}`, amount: -1599, createdAt: `${d}T08:00:00+10:00`, description: "Example Stream" })),
      ...months.map((d, i) => tx({ id: `g${i}`, amount: -(1000 + i * 4000), createdAt: `${d}T08:00:00+10:00`, description: "Example Grocer" })),
    ];
    expect(recurring(txs, "Australia/Sydney")).toEqual([{ merchant: "Example Stream", months: 3, medianCents: 1599, lastAt: "2026-10-03T08:00:00+10:00" }]);
  });

  test("unusual: more than twice the median of at least three earlier purchases", () => {
    const txs = [1, 2, 3].map((d) => tx({ id: `c${d}`, amount: -500, createdAt: `2026-10-0${d}T08:00:00Z`, description: "Corner Cafe" }));
    txs.push(tx({ id: "big", amount: -1500, createdAt: "2026-10-04T08:00:00Z", description: "Corner Cafe" }));
    expect(unusual(txs)).toEqual([{ id: "big", merchant: "Corner Cafe", cents: 1500, medianCents: 500, at: "2026-10-04T08:00:00Z" }]);
  });

  test("dollars are for reading only", () => {
    expect(dollars(214000)).toBe("$2,140");
    expect(dollars(-1250, false)).toBe("-$12.50");
  });
});

describe("webhooks", () => {
  const body = JSON.stringify({ data: { type: "webhook-events", id: "e1", attributes: { eventType: "TRANSACTION_CREATED", createdAt: "2026-10-16T10:00:00+11:00" }, relationships: { transaction: { data: { type: "transactions", id: "t1" } } } } });
  test("the signature is the HMAC-SHA256 of the raw body under the secret, hex; anything else is refused", async () => {
    const sig = createHmac("sha256", "s3cret").update(body).digest("hex");
    expect(await verifyWebhook(body, sig, "s3cret")).toBe(true);
    expect(await verifyWebhook(body, sig.toUpperCase(), "s3cret")).toBe(true);
    expect(await verifyWebhook(`${body} `, sig, "s3cret")).toBe(false);
    expect(await verifyWebhook(body, sig, "other")).toBe(false);
    expect(await verifyWebhook(body, sig.slice(0, -2), "s3cret")).toBe(false);
    expect(await verifyWebhook(body, undefined, "s3cret")).toBe(false);
  });
  test("the event names its type and transaction", () => {
    expect(parseWebhookEvent(body)).toEqual({ id: "e1", type: "TRANSACTION_CREATED", createdAt: "2026-10-16T10:00:00+11:00", transactionId: "t1" });
    expect(parseWebhookEvent({ data: { attributes: { eventType: "PING" } } })).toEqual({ id: undefined, type: "PING", createdAt: undefined, transactionId: undefined });
  });
});

describe("the integration", () => {
  // 2026-10-16 10:00 in Sydney.
  const NOW = Date.parse("2026-10-15T23:00:00Z");
  const txs = [
    resource({ id: "oct1", amount: -6000, createdAt: "2026-10-10T09:00:00+11:00", category: "groceries", parent: "home" }),
    resource({ id: "oct2", amount: -900, createdAt: "2026-10-01T00:30:00+10:00" }), // Sydney's October, UTC's September
    resource({ id: "sep1", amount: -4000, createdAt: "2026-09-12T09:00:00+10:00", category: "utilities", parent: "home" }),
    resource({ id: "aug1", amount: -100000, createdAt: "2026-08-20T09:00:00+10:00", category: "groceries", parent: "home" }),
  ];
  function run(routes: Parameters<typeof fakeUp>[0], account?: { accountType?: "TRANSACTIONAL"; ownershipType?: "JOINT" }, household?: Household) {
    const clock: Clock = { now: () => NOW, sleep: (_ms, signal) => new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })) };
    const { f, calls } = fakeUp(routes);
    const integration = up({ token: "t", fetch: f, clock, account, household, timeZone: "Australia/Sydney" });
    const stop = new AbortController();
    const parts: Part<UpSnapshot>[] = [];
    const done = new Promise<void>((resolve) => void integration.run(stop.signal, (p) => (parts.push(p), stop.abort(), resolve())));
    return { done, parts, calls };
  }

  test("two months, cut in the home's zone; recent rows carry no raw text, message or who spent", async () => {
    const r = run({ "GET /api/v1/categories": () => json(categoriesBody), "GET /api/v1/transactions": () => json({ data: txs, links: { next: null } }) });
    await r.done;
    const s = r.parts[0]!.state!;
    expect(r.parts[0]!.status).toBe("connected");
    expect(s.thisMonth).toMatchObject({ month: "2026-10", cents: 6900, count: 2, uncategorisedCents: 900 });
    expect(s.lastMonth).toMatchObject({ month: "2026-09", cents: 4000 });
    expect(s.uncategorised).toEqual(["oct2"]);
    expect(Object.keys(s.recent[0]!).sort()).toEqual(["amountCents", "categoryId", "createdAt", "description", "id", "parentCategoryId", "status", "tags"]);
    expect(r.calls.find((c) => c.url.pathname.endsWith("/transactions"))!.url.searchParams.get("filter[since]")).toBe(new Date(NOW - 63 * 86_400_000).toISOString());
    expect(manifest.lines(r.parts[0]!)).toEqual(["Oct so far $69 · Sep $40 · 1 to categorise", "Home $60: groceries $60"]);
  });

  test("a household filter counts its categories and tags only; to categorise still looks at every purchase", async () => {
    const mixed = [
      ...txs,
      resource({ id: "oct3", amount: -5000, createdAt: "2026-10-11T09:00:00+11:00", category: "booze", parent: "good-life" }),
      resource({ id: "oct4", amount: -2000, createdAt: "2026-10-12T09:00:00+11:00", category: "booze", parent: "good-life", tags: ["home"] }),
    ];
    const r = run({ "GET /api/v1/categories": () => json(categoriesBody), "GET /api/v1/transactions": () => json({ data: mixed, links: { next: null } }) }, undefined, { categories: ["home", "nope"], tags: ["home"] });
    await r.done;
    const s = r.parts[0]!.state!;
    expect(s.thisMonth).toMatchObject({ cents: 8000, count: 2 }); // groceries and the tagged one; not the untagged booze nor the uncategorised
    expect(s.recent.map((t) => t.id).sort()).toEqual(["aug1", "oct1", "oct4", "sep1"]); // not oct2 (no category) nor oct3 (untagged booze)
    expect(s.uncategorised).toEqual(["oct2"]);
    expect(s.household).toEqual({ categories: ["home", "nope"], tags: ["home"] });
    expect(r.parts[0]!.anomaly).toBe("household category nope is not an Up category");
  });

  test("an account filter reads only those accounts; none matching says so", async () => {
    const r = run(
      {
        "GET /api/v1/categories": () => json(categoriesBody),
        "GET /api/v1/accounts": () => json({ data: [{ type: "accounts", id: "joint-1", attributes: { accountType: "TRANSACTIONAL", ownershipType: "JOINT" } }], links: { next: null } }),
        "GET /api/v1/accounts/joint-1/transactions": () => json({ data: txs.slice(0, 1), links: { next: null } }),
      },
      { accountType: "TRANSACTIONAL", ownershipType: "JOINT" },
    );
    await r.done;
    const accountsCall = r.calls.find((c) => c.url.pathname.endsWith("/accounts"))!;
    expect(accountsCall.url.searchParams.get("filter[ownershipType]")).toBe("JOINT");
    expect(r.parts[0]!.state).toMatchObject({ accounts: 1, thisMonth: { cents: 6000 } });
    const none = run({ "GET /api/v1/categories": () => json(categoriesBody), "GET /api/v1/accounts": () => json({ data: [], links: { next: null } }) }, { ownershipType: "JOINT" });
    await none.done;
    expect(none.parts[0]).toMatchObject({ status: "disconnected", detail: "no Up account is joint" });
  });

  test("a rejected token stops for good; a page cap marks the snapshot truncated", async () => {
    const bad = run({ "GET /api/v1/categories": () => json({}, 401) });
    await bad.done;
    expect(bad.parts[0]).toMatchObject({ status: "unavailable", detail: "Up rejected the token" });
    const snap = toSnapshot([], categories, { now: NOW, asOf: "x", accounts: 0, truncated: true });
    expect(snap.truncated).toBe(true);
  });

  test("the integration never writes", async () => {
    const r = run({ "GET /api/v1/categories": () => json(categoriesBody), "GET /api/v1/transactions": () => json({ data: txs, links: { next: null } }) });
    await r.done;
    expect(r.calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("config", () => {
  test("loadHome builds Up from the token's env name and the account filter", () => {
    const [i] = loadHome({ devices: [{ id: "bank", connector: "up", key: "UP_TOKEN", account: { ownershipType: "JOINT", accountType: "TRANSACTIONAL" } }] }, { env: { UP_TOKEN: "t" } });
    expect(i!.name).toBe("up");
    expect(() => loadHome({ devices: [{ id: "bank", connector: "up", key: "UP_TOKEN", account: { ownershipType: "SHARED" } }] }, { env: { UP_TOKEN: "t" } })).toThrow();
  });
});
