import { z } from "zod";
import { asOf, type Clock, realClock } from "../../clock.ts";
import { errorText } from "../../connector.ts";
import { envName, type Integration } from "../../home.ts";
import type { Manifest } from "../../manifest.ts";
import { poller } from "../../poll.ts";
import {
  type Category,
  type Transaction,
  type TransactionQuery,
  type UpClient,
  upClient,
  UpError,
} from "./client.ts";
import {
  anomalies,
  dollars,
  type Household,
  inHousehold,
  isSpend,
  type MerchantSpend,
  type SpendSummary,
  spendByCategory,
  spendByMerchant,
  uncategorised,
  unknownCategories,
} from "./spend.ts";

export {
  type Account,
  type Category,
  type Transaction,
  type TransactionQuery,
  type UpClient,
  upClient,
  UpError,
  type Webhook,
  type WebhookLog,
} from "./client.ts";
export {
  type CategorySpend,
  dollars,
  type Household,
  inHousehold,
  isSpend,
  merchantKey,
  type MerchantSpend,
  notSpend,
  type Recurring,
  recurring,
  type SpendSummary,
  spendByCategory,
  spendByMerchant,
  uncategorised,
  type Unusual,
  unusual,
  type Window,
} from "./spend.ts";
export {
  parseWebhookEvent,
  SIGNATURE_HEADER,
  verifyWebhook,
  type WebhookEvent,
} from "./webhook.ts";

/** Poll every 15 minutes: spending moves slowly, and a webhook can nudge a read sooner. */
export const POLL_MS = 15 * 60_000;

const ACCOUNT_TYPES = ["TRANSACTIONAL", "SAVER", "HOME_LOAN"] as const;
const OWNERSHIP_TYPES = ["INDIVIDUAL", "JOINT"] as const;

/** Which accounts to read: by type and ownership, never by id (e.g. the joint everyday account). All of them when left out. */
const AccountFilter = z.object({
  accountType: z.enum(ACCOUNT_TYPES).optional(),
  ownershipType: z.enum(OWNERSHIP_TYPES).optional(),
});
export type AccountFilter = z.infer<typeof AccountFilter>;

/** Up in a home config: the token's env name, and which accounts count as the household's. */
export const configSchema = z.looseObject({
  connector: z.literal("up"),
  key: envName.describe("env name holding the Up personal access token"),
  account: AccountFilter.optional().describe(
    "which accounts to read, by type and ownership; every account when left out",
  ),
  household: z
    .object({
      categories: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional()
    .describe(
      "what counts as the household's: Up category ids (a parent takes in its children, e.g. home) and tag labels; everything when left out",
    ),
});

export type UpConfig = {
  token: string;
  account?: AccountFilter;
  household?: Household;
  fetch: typeof fetch;
  clock?: Clock;
  timeZone?: string;
}; // timeZone: where a month starts (IANA), the runtime's by default

/** One month's spend: Up's figures through `spendByCategory`, plus the top merchants. */
export type MonthSpend = SpendSummary & {
  month: string;
  topMerchants: MerchantSpend[];
}; // month: "2026-10" in the home's zone

/** A transaction as the snapshot keeps it: no raw text, message, note, who spent, account or balance. */
export type RecentTransaction = Pick<
  Transaction,
  | "id"
  | "createdAt"
  | "description"
  | "amountCents"
  | "categoryId"
  | "parentCategoryId"
  | "status"
  | "tags"
>;

export type UpSnapshot = {
  asOf: string;
  thisMonth: MonthSpend; // month to date
  lastMonth: MonthSpend;
  uncategorised: string[]; // ids of spend, both months, with no category yet
  recent: RecentTransaction[]; // the latest 20 purchases: movements between your own accounts would name them
  accounts: number; // how many accounts the filter matched; 0 without a filter (every account)
  household?: Household; // what the totals and recent rows count; everything when absent
  truncated: boolean; // the read stopped at its page cap: totals are short
};

/** Transactions from the accounts a filter names (every account without one), newest first. The one read the integration and `home up` share. */
export async function readTransactions(
  client: UpClient,
  account: AccountFilter | undefined,
  query: TransactionQuery = {},
  signal?: AbortSignal,
) {
  const accounts = account ? await client.accounts(account, signal) : undefined;
  if (accounts && !accounts.length)
    throw new UpError(
      `no Up account is ${[account!.ownershipType, account!.accountType].filter(Boolean).join(" ").toLowerCase()}`,
    );
  const reads = await Promise.all(
    (accounts ?? [undefined]).map((a) =>
      client.transactions({ ...query, accountId: a?.id }, signal),
    ),
  );
  const transactions = reads
    .flatMap((r) => r.transactions)
    .sort((a, b) => ((a.createdAt ?? "") < (b.createdAt ?? "") ? 1 : -1));
  return {
    transactions,
    truncated: reads.some((r) => r.truncated),
    accounts: accounts?.length ?? 0,
  };
}

/** "2026-10" for each instant, in a time zone. */
const monthIn = (timeZone?: string) => {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  });
  return (ms: number) => f.format(ms).slice(0, 7);
};
const monthBefore = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

/** The snapshot from two months of transactions: pure, so tests and a consumer's own reads build the same thing. */
export function toSnapshot(
  txs: Transaction[],
  categories: Category[],
  at: {
    now: number;
    asOf: string;
    timeZone?: string;
    accounts: number;
    truncated: boolean;
    household?: Household;
  },
): UpSnapshot {
  const monthOf = monthIn(at.timeZone);
  const thisMonth = monthOf(at.now);
  const lastMonth = monthBefore(thisMonth);
  const shared = txs.filter((t) => inHousehold(t, at.household));
  const byMonth = Map.groupBy(shared, (t) =>
    t.createdAt === undefined ? "" : monthOf(Date.parse(t.createdAt)),
  );
  const of = (month: string) => byMonth.get(month) ?? [];
  const month = (m: string): MonthSpend => ({
    month: m,
    ...spendByCategory(of(m), categories),
    topMerchants: spendByMerchant(of(m)).slice(0, 5),
  });
  // To categorise looks at every purchase in the accounts: a category is how one joins the household.
  const both = txs.filter(
    (t) =>
      t.createdAt !== undefined &&
      [thisMonth, lastMonth].includes(monthOf(Date.parse(t.createdAt))),
  );
  return {
    asOf: at.asOf,
    thisMonth: month(thisMonth),
    lastMonth: month(lastMonth),
    uncategorised: uncategorised(both).map((t) => t.id),
    recent: shared
      .filter(isSpend)
      .slice(0, 20)
      .map(
        ({
          id,
          createdAt,
          description,
          amountCents,
          categoryId,
          parentCategoryId,
          status,
          tags,
        }) => ({
          id,
          createdAt,
          description,
          amountCents,
          categoryId,
          parentCategoryId,
          status,
          tags,
        }),
      ),
    accounts: at.accounts,
    household: at.household,
    truncated: at.truncated,
  };
}

/** Up as a home integration: two months of transactions now, then every 15 minutes. The integration only reads; `client` is there for a consumer's writes. */
export function up(config: UpConfig): Integration<UpSnapshot, "up"> & {
  client: UpClient;
} {
  const client = upClient(config);
  const clock = config.clock ?? realClock;
  const poll = poller(clock);
  return {
    name: "up",
    client,
    refresh: poll.nudge,
    async run(signal, update) {
      let last: UpSnapshot | undefined;
      while (!signal.aborted) {
        try {
          const now = clock.now();
          // 63 days back covers all of last month from any day of this one; months are cut in the home's zone below.
          const since = new Date(now - 63 * 86_400_000).toISOString();
          const categories = await client.categories(signal);
          const read = await readTransactions(
            client,
            config.account,
            { since },
            signal,
          );
          last = toSnapshot(read.transactions, categories, {
            now,
            asOf: asOf(clock),
            timeZone: config.timeZone,
            accounts: read.accounts,
            truncated: read.truncated,
            household: config.household,
          });
          const odd = [
            ...anomalies(read.transactions),
            ...unknownCategories(config.household, categories),
            last.truncated
              ? "read stopped at its page cap; totals are short"
              : "",
          ].filter(Boolean);
          update({
            status: "connected",
            anomaly: odd.length ? odd.join("; ") : undefined,
            state: last,
          });
        } catch (error) {
          if (signal.aborted) return; // stopped mid-read: not a failure
          if (error instanceof UpError && error.status === 401)
            return update({
              status: "unavailable",
              detail: "Up rejected the token",
              state: last,
            });
          update({
            status: "disconnected",
            detail: errorText(error),
            state: last,
          });
        }
        await poll.wait(POLL_MS, signal);
      }
    },
  };
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const monthName = (month: string) =>
  MONTHS[Number(month.slice(5, 7)) - 1] ?? month;

/** "Oct so far $2,140 · Sep $1,980 · 3 to categorise": this month's spend against last month's. */
export function upText(s: UpSnapshot): string {
  return [
    `${monthName(s.thisMonth.month)} so far ${dollars(s.thisMonth.cents)}`,
    `${monthName(s.lastMonth.month)} ${dollars(s.lastMonth.cents)}`,
    s.uncategorised.length ? `${s.uncategorised.length} to categorise` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** One line per parent category this month, largest five: "home $1,030: groceries $620, utilities $410". */
export const categoryLines = (m: MonthSpend) =>
  m.byCategory
    .slice(0, 5)
    .map(
      (p) =>
        `${p.name ?? p.id} ${dollars(p.cents)}${p.children.length ? `: ${p.children.map((c) => `${(c.name ?? c.id).toLowerCase()} ${dollars(c.cents)}`).join(", ")}` : ""}`,
    );

export const manifest: Manifest<UpSnapshot> = {
  name: "up",
  title: "Up Bank",
  iotClass: "cloud_polling",
  pollSeconds: POLL_MS / 1000,
  access: "cloud HTTPS, UP_TOKEN; reads only, writes are `home up` verbs",
  env: [
    {
      name: "UP_TOKEN",
      example: "up:yeah:xxxxxxxx",
      what: "Up personal access token (api.up.com.au/getting_started)",
    },
    {
      name: "UP_ACCOUNT",
      example: "JOINT TRANSACTIONAL",
      optional: true,
      what: "which accounts count, by ownership and type; every account when unset",
    },
    {
      name: "UP_HOUSEHOLD",
      example: "home tag:home",
      optional: true,
      what: "what counts as the household's: Up category ids and tag:labels; everything when unset",
    },
  ],
  lines: ({ state }) =>
    state ? [upText(state), ...categoryLines(state.thisMonth)] : [],
};
