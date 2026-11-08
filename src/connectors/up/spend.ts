import type { Category, Transaction } from "./client.ts";

// Pure helpers over transactions, one owner per number. Amounts are cents; spend is reported as a positive number.

/**
 * Up's own movements between your accounts that carry no `transferAccount` (unconfirmed: matched by description, the
 * way up-finance-skills does). Most movements do carry it and are caught by that field.
 */
const OWN_MOVEMENT = [
  /^cover from /i,
  /^forward to /i,
  /^round up\b/i,
  /^quick save transfer/i,
]; // not "Transfer to …": paying someone else is spend

/** Why a transaction is not spend, or undefined when it is. The one place the rule lives. */
export function notSpend(t: Transaction): string | undefined {
  if (t.status !== "SETTLED") return "held";
  if (t.amountCents === undefined) return "no amount";
  if (t.amountCents >= 0) return "money in";
  if (t.transferAccountId) return "transfer between your accounts";
  if (t.description && OWN_MOVEMENT.some((r) => r.test(t.description!)))
    return "cover, forward or round-up";
  return undefined;
}

/** Settled money out to someone else: not held, not a transfer, cover, forward or round-up between your own accounts. */
export const isSpend = (t: Transaction) => notSpend(t) === undefined;

/** Money spent, as a positive number of cents. */
const spent = (t: Transaction) => -(t.amountCents ?? 0);

/** A window of time by the transaction's creation, `[since, until)` as ISO strings; either end open. */
export type Window = { since?: string; until?: string };
const inWindow = (t: Transaction, w: Window = {}) => {
  if (!w.since && !w.until) return true;
  const at = Date.parse(t.createdAt ?? ""); // Up's times carry an offset (+11:00); compare instants, not text
  return (
    (!w.since || at >= Date.parse(w.since)) &&
    (!w.until || at < Date.parse(w.until))
  );
};

/** Money out that the rule leaves out (a transfer, cover, forward or round-up), counted so a total can be checked. */
const MOVED = new Set([
  "transfer between your accounts",
  "cover, forward or round-up",
]);

export type CategorySpend = {
  id: string;
  name?: string;
  cents: number;
  count: number;
  children: { id: string; name?: string; cents: number; count: number }[];
};
export type SpendSummary = {
  cents: number; // spend in the window
  count: number;
  excluded: { count: number; cents: number }; // money out that is not spend (transfers, covers, round-ups), so the total can be checked
  uncategorisedCents: number;
  byCategory: CategorySpend[]; // parents, largest first, each with its children
};

/** Spend in a window grouped by Up's parent and child categories, with what was excluded counted and summed. */
export function spendByCategory(
  txs: Transaction[],
  categories: Category[],
  window?: Window,
): SpendSummary {
  const name = new Map(categories.map((c) => [c.id, c.name]));
  const parentOf = new Map(categories.map((c) => [c.id, c.parentId]));
  const parents = new Map<string, CategorySpend>();
  const summary: SpendSummary = {
    cents: 0,
    count: 0,
    excluded: { count: 0, cents: 0 },
    uncategorisedCents: 0,
    byCategory: [],
  };
  for (const t of txs) {
    if (!inWindow(t, window)) continue;
    const why = notSpend(t);
    if (why) {
      if (MOVED.has(why))
        (summary.excluded.count++, (summary.excluded.cents += spent(t)));
      continue;
    }
    summary.cents += spent(t);
    summary.count++;
    if (!t.categoryId) {
      summary.uncategorisedCents += spent(t);
      continue;
    }
    const parentId =
      t.parentCategoryId ?? parentOf.get(t.categoryId) ?? t.categoryId;
    const p = parents.get(parentId) ?? {
      id: parentId,
      name: name.get(parentId),
      cents: 0,
      count: 0,
      children: [],
    };
    parents.set(parentId, p);
    p.cents += spent(t);
    p.count++;
    if (t.categoryId !== parentId) {
      let c = p.children.find((x) => x.id === t.categoryId);
      if (!c)
        p.children.push(
          (c = {
            id: t.categoryId,
            name: name.get(t.categoryId),
            cents: 0,
            count: 0,
          }),
        );
      c.cents += spent(t);
      c.count++;
    }
  }
  summary.byCategory = [...parents.values()].sort((a, b) => b.cents - a.cents);
  for (const p of summary.byCategory)
    p.children.sort((a, b) => b.cents - a.cents);
  return summary;
}

/** A merchant's name as grouped: lower case, digits and punctuation dropped ("WOOLWORTHS 1234" and "Woolworths" are one); a name with no letters stays itself. */
export const merchantKey = (description = "") =>
  description
    .toLowerCase()
    .replace(/[^\p{L} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim() || description;

export type MerchantSpend = { merchant: string; cents: number; count: number };

/** Spend per merchant, largest first; the merchant shown as its latest description. */
export function spendByMerchant(
  txs: Transaction[],
  window?: Window,
): MerchantSpend[] {
  const by = new Map<string, MerchantSpend>();
  for (const t of txs) {
    if (!inWindow(t, window) || !isSpend(t)) continue;
    const key = merchantKey(t.description);
    const m = by.get(key) ?? {
      merchant: t.description ?? "?",
      cents: 0,
      count: 0,
    };
    by.set(key, m);
    m.cents += spent(t);
    m.count++;
  }
  return [...by.values()].sort((a, b) => b.cents - a.cents);
}

/** What the household shares: Up category ids (a parent takes in its children) and tag labels. */
export type Household = { categories?: string[]; tags?: string[] };

/** The one rule for what counts as the household's: a listed category or its parent, or a listed tag. Everything counts without a list. */
export function inHousehold(t: Transaction, h: Household | undefined): boolean {
  if (!h?.categories?.length && !h?.tags?.length) return true;
  const byCategory =
    h.categories?.some((c) => c === t.categoryId || c === t.parentCategoryId) ??
    false;
  return byCategory || (t.tags?.some((tag) => h.tags?.includes(tag)) ?? false);
}

/** Household categories Up does not have, said in words: a typo would otherwise count nothing, silently. */
export const unknownCategories = (
  h: Household | undefined,
  categories: Category[],
) =>
  (h?.categories ?? [])
    .filter((c) => !categories.some((k) => k.id === c))
    .map((c) => `household category ${c} is not an Up category`);

/** Spend Up lets you categorise that has no category yet. Money in (salary, a payment received) is categorisable too, but is not spend. */
export const uncategorised = (txs: Transaction[]) =>
  txs.filter((t) => t.isCategorizable && !t.categoryId && isSpend(t));

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export type Recurring = {
  merchant: string;
  months: number;
  medianCents: number;
  lastAt?: string;
};

/**
 * A heuristic, since Up has no subscription endpoint: the same merchant in three or more distinct months, every amount
 * within 20% of that merchant's median.
 */
export function recurring(txs: Transaction[], timeZone?: string): Recurring[] {
  const month = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  });
  const by = new Map<string, Transaction[]>();
  for (const t of txs) {
    if (!isSpend(t) || !t.createdAt) continue;
    const key = merchantKey(t.description);
    by.set(key, [...(by.get(key) ?? []), t]);
  }
  const out: Recurring[] = [];
  for (const list of by.values()) {
    const months = new Set(
      list.map((t) => month.format(new Date(t.createdAt!))),
    );
    if (months.size < 3) continue;
    const mid = median(list.map(spent));
    if (!list.every((t) => Math.abs(spent(t) - mid) <= mid * 0.2)) continue;
    const latest = list.reduce((a, b) => (a.createdAt! > b.createdAt! ? a : b));
    out.push({
      merchant: latest.description ?? "?",
      months: months.size,
      medianCents: mid,
      lastAt: latest.createdAt,
    });
  }
  return out.sort((a, b) => b.medianCents - a.medianCents);
}

export type Unusual = {
  id: string;
  merchant: string;
  cents: number;
  medianCents: number;
  at?: string;
};

/** Spend well above that merchant's usual: more than twice the median of at least three earlier purchases there. */
export function unusual(txs: Transaction[]): Unusual[] {
  const sorted = txs
    .filter((t) => isSpend(t) && t.createdAt)
    .sort((a, b) => (a.createdAt! < b.createdAt! ? -1 : 1));
  const seen = new Map<string, number[]>();
  const out: Unusual[] = [];
  for (const t of sorted) {
    const key = merchantKey(t.description);
    const prior = seen.get(key) ?? [];
    if (prior.length >= 3) {
      const mid = median(prior);
      if (spent(t) > 2 * mid)
        out.push({
          id: t.id,
          merchant: t.description ?? "?",
          cents: spent(t),
          medianCents: mid,
          at: t.createdAt,
        });
    }
    seen.set(key, [...prior, spent(t)]);
  }
  return out;
}

/** Readings that look wrong, said in words: never fixed here. */
export function anomalies(txs: Transaction[]): string[] {
  const out: string[] = [];
  const noAmount = txs.filter((t) => t.amountCents === undefined).length;
  if (noAmount) out.push(`${noAmount} transaction(s) without an amount`);
  const foreign = txs.filter(
    (t) => t.currency !== undefined && t.currency !== "AUD",
  ).length;
  if (foreign) out.push(`${foreign} transaction(s) not in AUD`);
  return out;
}

/** Cents as dollars for reading: "$1,234" (whole dollars) or "$12.50". Display only. */
export const dollars = (cents: number, whole = true) =>
  `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-AU", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 })}`;
