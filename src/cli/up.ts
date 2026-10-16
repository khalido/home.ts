// `home up …`: Up Bank's reads, and the two writes Up allows (a category, a tag), one transaction at a time.
// `home up` alone is the status line; nothing here runs from `home status`.
import { homedir } from "node:os";
import { join } from "node:path";
import { writePrivate } from "../finders.ts";
import { type AccountFilter, type Category, dollars, readTransactions, recurring, spendByCategory, spendByMerchant, type Transaction, type TransactionQuery, uncategorised, up, upClient } from "../connectors/up/index.ts";
import { die, env, fail, type Options, printJson, text, type Verbs } from "./context.ts";

export const UP_USAGE =
  "usage: home up transactions [--since <date>] [--until <date>] [--category <id>] [--tag <label>] [--status HELD|SETTLED] [--limit <n>] [--json|--csv] | categories | uncategorised | spend [--by category|merchant|recurring] | categorise <transaction id> <category id|none> | tag <transaction id> <label> [--remove] | webhooks [get|logs|ping|create|delete] [id|url]";

export const UP_OPTIONS: [string, string, { type: unknown[] }?][] = [
  ["--since <date>", "from this date; uncategorised and spend default to 30 days ago, spend --by recurring to 180", { type: [String] }],
  ["--until <date>", "transactions, spend: before this date", { type: [String] }],
  ["--category <id>", "transactions: one category (a parent includes its children)", { type: [String] }],
  ["--tag <label>", "transactions: one tag", { type: [String] }],
  ["--status <status>", "transactions: HELD or SETTLED", { type: [String] }],
  ["--limit <n>", "transactions: at most this many (default 100)"],
  ["--csv", "transactions: CSV"],
  ["--by <what>", "spend: category (default), merchant or recurring", { type: [String] }],
  ["--remove", "tag: take the tag off"],
];

type UpOptions = Options & { since?: string; until?: string; category?: string; tag?: string; status?: string; limit?: number | string; csv?: boolean; by?: string; remove?: boolean };

/** `UP_ACCOUNT` ("JOINT TRANSACTIONAL") as a filter; unset reads every account. */
function accountFromEnv(): AccountFilter | undefined {
  const words = (env.UP_ACCOUNT ?? "").toUpperCase().split(/[\s,]+/).filter(Boolean);
  if (!words.length) return undefined;
  const filter: AccountFilter = {};
  for (const w of words) {
    if (w === "INDIVIDUAL" || w === "JOINT") filter.ownershipType = w;
    else if (w === "TRANSACTIONAL" || w === "SAVER" || w === "HOME_LOAN") filter.accountType = w;
    else fail(`UP_ACCOUNT: "${w}" is not INDIVIDUAL, JOINT, TRANSACTIONAL, SAVER or HOME_LOAN`);
  }
  return filter;
}

const token = () => env.UP_TOKEN ?? fail("set UP_TOKEN");
const client = () => upClient({ token: token(), fetch });

/** Up as an integration from UP_TOKEN and UP_ACCOUNT, for `home status`. */
export const upFromEnv = () => up({ token: token(), account: accountFromEnv(), fetch });

/** A date argument as ISO; "2026-10-01" is midnight in this machine's zone. */
const iso = (v: string | undefined, name: string) => {
  if (v === undefined) return undefined;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00` : v);
  return Number.isNaN(ms) ? fail(`--${name}: not a date: ${v}`) : new Date(ms).toISOString();
};
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/** Every transaction in the accounts UP_ACCOUNT names, newest first; says so when a read stopped short. */
async function read(query: TransactionQuery): Promise<Transaction[]> {
  const r = await readTransactions(client(), accountFromEnv(), query);
  if (r.truncated) console.error("home: more transactions than the limit; this list is cut short");
  return r.transactions;
}

/** One row as printed: the fields a person reads, nothing about who spent or from which account. */
const row = (t: Transaction) => ({
  id: t.id,
  at: t.createdAt,
  description: t.description,
  amount: t.amountCents === undefined ? undefined : t.amountCents / 100,
  category: t.categoryId,
  status: t.status,
  tags: t.tags.join(" "),
});
const csvCell = (v: unknown) => (v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const line = (t: Transaction) =>
  `${(t.createdAt ?? "").slice(0, 10)}  ${(t.amountCents === undefined ? "?" : dollars(t.amountCents, false)).padStart(11)}  ${(t.description ?? "").padEnd(32).slice(0, 32)}  ${(t.categoryId ?? "-").padEnd(24)} ${t.status === "HELD" ? "held " : ""}${t.id}`;

/** The category tree: each parent, then its children, with ids. */
function tree(categories: Category[]): string[] {
  return categories
    .filter((c) => !c.parentId)
    .flatMap((p) => [`${p.id}  ${p.name ?? ""}`, ...categories.filter((c) => c.parentId === p.id).map((c) => `  ${c.id.padEnd(36)} ${c.name ?? ""}`)]);
}

/** A transaction before and after a write, on two lines. */
const beforeAfter = (before: Transaction, after: Transaction) => {
  console.log(`before  ${line(before)}  tags: ${before.tags.join(", ") || "-"}`);
  console.log(`after   ${line(after)}  tags: ${after.tags.join(", ") || "-"}`);
};

export const upVerbs: Verbs = {
  async transactions(_args, o: UpOptions) {
    const status = text(o.status)?.toUpperCase();
    if (status !== undefined && status !== "HELD" && status !== "SETTLED") die(UP_USAGE);
    const limit = Number(text(o.limit) ?? 100);
    if (!Number.isInteger(limit) || limit < 1) fail(`--limit: a whole number above 0, not ${text(o.limit)}`);
    const txs = await read({ since: iso(text(o.since), "since"), until: iso(text(o.until), "until"), category: text(o.category), tag: text(o.tag), status: status as "HELD" | "SETTLED" | undefined, limit });
    if (o.json) return printJson(txs.map(row));
    if (o.csv) {
      const cols = ["id", "at", "description", "amount", "category", "status", "tags"] as const;
      return console.log([cols.join(","), ...txs.map((t) => cols.map((k) => csvCell(row(t)[k])).join(","))].join("\n"));
    }
    for (const t of txs) console.log(line(t));
  },
  async categories(_args, o) {
    const categories = await client().categories();
    if (o.json) return printJson(categories);
    for (const l of tree(categories)) console.log(l);
  },
  async uncategorised(_args, o: UpOptions) {
    const txs = uncategorised(await read({ since: iso(text(o.since), "since") ?? daysAgo(30), status: "SETTLED" }));
    if (o.json) return printJson(txs.map(row));
    if (!txs.length) return console.log("none");
    for (const t of txs) console.log(line(t));
  },
  async spend(_args, o: UpOptions) {
    const by = text(o.by) ?? "category";
    if (by !== "category" && by !== "merchant" && by !== "recurring") die(UP_USAGE);
    // Recurring needs three distinct months, so its default window is six.
    const window = { since: iso(text(o.since), "since") ?? daysAgo(by === "recurring" ? 180 : 30), until: iso(text(o.until), "until") };
    const txs = await read({ ...window, status: "SETTLED", limit: 5000, pageCap: 60 });
    if (by === "merchant") {
      const list = spendByMerchant(txs);
      if (o.json) return printJson(list);
      for (const m of list.slice(0, 30)) console.log(`${dollars(m.cents).padStart(9)}  ${m.count.toString().padStart(3)}×  ${m.merchant}`);
      return;
    }
    if (by === "recurring") {
      const list = recurring(txs);
      if (o.json) return printJson(list);
      console.log("a heuristic: the same merchant in three or more months at a similar amount");
      for (const r of list) console.log(`${dollars(r.medianCents, false).padStart(10)}  ${r.months} months  ${r.merchant}`);
      return;
    }
    if (by !== "category") die(UP_USAGE);
    const s = spendByCategory(txs, await client().categories());
    if (o.json) return printJson(s);
    console.log(`${dollars(s.cents)} spent in ${s.count} purchases since ${window.since.slice(0, 10)}; ${dollars(s.excluded.cents)} in ${s.excluded.count} transfers and round-ups left out`);
    for (const p of s.byCategory) {
      console.log(`${dollars(p.cents).padStart(9)}  ${p.name ?? p.id}`);
      for (const c of p.children) console.log(`${dollars(c.cents).padStart(9)}    ${c.name ?? c.id}`);
    }
    if (s.uncategorisedCents) console.log(`${dollars(s.uncategorisedCents).padStart(9)}  uncategorised`);
  },

  /** A write: one transaction's category, or `none` to clear it. Only a child category can be set. */
  async categorise([txId, category]) {
    if (!txId || !category) die(UP_USAGE);
    const c = client();
    const before = await c.transaction(txId!);
    beforeAfter(before, await c.setCategory(txId!, category === "none" ? null : category!));
  },
  /** A write: add one tag to a transaction, or take it off with --remove. */
  async tag([txId, label], o: UpOptions) {
    if (!txId || !label) die(UP_USAGE);
    const c = client();
    const before = await c.transaction(txId!);
    beforeAfter(before, o.remove ? await c.removeTags(txId!, [label!]) : await c.addTags(txId!, [label!]));
  },

  /** Webhooks: list, get, logs and ping read or test; create and delete are writes. */
  async webhooks([verb, arg], o) {
    const c = client();
    if (verb === undefined) {
      const hooks = await c.webhooks();
      if (o.json) return printJson(hooks);
      if (!hooks.length) return console.log("no webhooks");
      for (const h of hooks) console.log(`${h.id}  ${h.url ?? "?"}  ${h.description ?? ""}`);
      return;
    }
    if (!arg) die(UP_USAGE);
    if (verb === "get") {
      const { secretKey: _, ...hook } = await c.webhook(arg!); // Up returns the secret only on creation; never print one
      return printJson(hook);
    }
    if (verb === "logs") {
      for (const l of await c.webhookLogs(arg!)) console.log(`${l.createdAt ?? "?"}  ${l.deliveryStatus ?? "?"}  ${l.statusCode ?? ""}`);
      return;
    }
    if (verb === "ping") return (await c.pingWebhook(arg!), console.log("ping sent"));
    if (verb === "delete") return (await c.deleteWebhook(arg!), console.log(`deleted ${arg}`));
    if (verb === "create") {
      const h = await c.createWebhook(arg!, "home");
      // Up returns the secret this once. It goes to an owner-only file, never the terminal.
      if (!h.secretKey) return console.log(`created ${h.id}; Up returned no secret`);
      const path = join(homedir(), ".config", "home", `up-webhook-${h.id}.secret`);
      writePrivate(path, `${h.secretKey}\n`);
      console.log(`created ${h.id}; its secret is in ${path} (0600)`);
      return;
    }
    die(UP_USAGE);
  },
};
