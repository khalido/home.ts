import { z } from "zod";
import { ConnectorError, fetchTimeout, getJson } from "../../connector.ts";

// Up Bank's API v1 (https://developer.up.com.au/, spec github.com/up-banking/api, v1/openapi.json). Field names checked
// against one live read, 2026-10-16. Every field optional so a change degrades a reading rather than throwing.

const BASE = "https://api.up.com.au/api/v1";

/** A failed Up call. `status` 401 or 403 (`isRejectedKey`) means the token is wrong or revoked; 429 the rate limit (unpublished: read `X-RateLimit-Remaining`). */
export class UpError extends ConnectorError {}

const Money = z.looseObject({
  currencyCode: z.string().optional(),
  value: z.string().optional(),
  valueInBaseUnits: z.number().optional(),
});
const Ref = z.looseObject({
  data: z.looseObject({ id: z.string() }).nullable().optional(),
});

const TransactionResource = z.looseObject({
  id: z.string(),
  attributes: z
    .looseObject({
      status: z.string().optional(), // "HELD" | "SETTLED"
      rawText: z.string().nullable().optional(),
      description: z.string().optional(),
      message: z.string().nullable().optional(),
      isCategorizable: z.boolean().optional(),
      holdInfo: z
        .looseObject({ amount: Money.optional() })
        .nullable()
        .optional(),
      roundUp: z
        .looseObject({ amount: Money.optional() })
        .nullable()
        .optional(),
      cashback: z
        .looseObject({ amount: Money.optional() })
        .nullable()
        .optional(),
      amount: Money.optional(),
      foreignAmount: Money.nullable().optional(),
      settledAt: z.string().nullable().optional(),
      createdAt: z.string().optional(),
      transactionType: z.string().nullable().optional(),
      note: z
        .looseObject({ text: z.string().optional() })
        .nullable()
        .optional(),
      performingCustomer: z
        .looseObject({ displayName: z.string().optional() })
        .nullable()
        .optional(),
      deepLinkURL: z.string().optional(),
    })
    .optional(),
  relationships: z
    .looseObject({
      account: Ref.optional(),
      transferAccount: Ref.optional(),
      category: Ref.optional(),
      parentCategory: Ref.optional(),
      tags: z
        .looseObject({
          data: z.array(z.looseObject({ id: z.string() })).optional(),
        })
        .optional(),
    })
    .optional(),
});

const Page = <T extends z.ZodType>(item: T) =>
  z.looseObject({
    data: z.array(item),
    links: z.looseObject({ next: z.string().nullable().optional() }).optional(),
  });
const One = <T extends z.ZodType>(item: T) => z.looseObject({ data: item });

const CategoryResource = z.looseObject({
  id: z.string(),
  attributes: z.looseObject({ name: z.string().optional() }).optional(),
  relationships: z.looseObject({ parent: Ref.optional() }).optional(),
});
const AccountResource = z.looseObject({
  id: z.string(),
  attributes: z
    .looseObject({
      displayName: z.string().optional(),
      accountType: z.string().optional(),
      ownershipType: z.string().optional(),
      balance: Money.optional(),
    })
    .optional(),
});
const WebhookResource = z.looseObject({
  id: z.string(),
  attributes: z
    .looseObject({
      url: z.string().optional(),
      description: z.string().nullable().optional(),
      secretKey: z.string().optional(),
      createdAt: z.string().optional(),
    })
    .optional(),
});
const LogResource = z.looseObject({
  id: z.string(),
  attributes: z
    .looseObject({
      deliveryStatus: z.string().optional(),
      createdAt: z.string().optional(),
      response: z
        .looseObject({ statusCode: z.number().optional() })
        .nullable()
        .optional(),
    })
    .optional(),
});

/** One transaction as the library keeps it: amounts in cents (Up's base units), ids flattened, nothing derived. */
export type Transaction = {
  id: string;
  status?: string; // "HELD" | "SETTLED"
  description?: string; // usually the merchant
  rawText?: string;
  message?: string;
  amountCents?: number; // negative is money out
  currency?: string;
  foreignCents?: number;
  foreignCurrency?: string;
  heldCents?: number; // the amount while held, kept after it settles
  roundUpCents?: number; // the round-up this purchase triggered (negative), a separate movement
  cashbackCents?: number;
  isCategorizable?: boolean;
  createdAt?: string;
  settledAt?: string;
  transactionType?: string;
  note?: string;
  performedBy?: string; // performingCustomer.displayName: who spent, on a joint account
  deepLink?: string;
  accountId?: string;
  transferAccountId?: string; // set on a movement between your own accounts
  categoryId?: string;
  parentCategoryId?: string;
  tags: string[];
};

export type Category = { id: string; name?: string; parentId?: string };
export type Account = {
  id: string;
  displayName?: string;
  accountType?: string;
  ownershipType?: string;
  balanceCents?: number;
};
export type Webhook = {
  id: string;
  url?: string;
  description?: string;
  createdAt?: string;
  secretKey?: string;
};
export type WebhookLog = {
  id: string;
  deliveryStatus?: string;
  createdAt?: string;
  statusCode?: number;
};

const id = (r?: z.infer<typeof Ref>) => r?.data?.id ?? undefined;
const nul = <T>(v: T | null | undefined) => v ?? undefined;

/** Up's transaction resource to the library's shape. */
export function toTransaction(
  r: z.infer<typeof TransactionResource>,
): Transaction {
  const a = r.attributes ?? {};
  const rel = r.relationships ?? {};
  return {
    id: r.id,
    status: a.status,
    description: a.description,
    rawText: nul(a.rawText),
    message: nul(a.message),
    amountCents: a.amount?.valueInBaseUnits,
    currency: a.amount?.currencyCode,
    foreignCents: nul(a.foreignAmount)?.valueInBaseUnits,
    foreignCurrency: nul(a.foreignAmount)?.currencyCode,
    heldCents: nul(a.holdInfo)?.amount?.valueInBaseUnits,
    roundUpCents: nul(a.roundUp)?.amount?.valueInBaseUnits,
    cashbackCents: nul(a.cashback)?.amount?.valueInBaseUnits,
    isCategorizable: a.isCategorizable,
    createdAt: a.createdAt,
    settledAt: nul(a.settledAt),
    transactionType: nul(a.transactionType),
    note: nul(a.note)?.text,
    performedBy: nul(a.performingCustomer)?.displayName,
    deepLink: a.deepLinkURL,
    accountId: id(rel.account),
    transferAccountId: id(rel.transferAccount),
    categoryId: id(rel.category),
    parentCategoryId: id(rel.parentCategory),
    tags: rel.tags?.data?.map((t) => t.id) ?? [],
  };
}

export type TransactionQuery = {
  since?: string; // ISO date-time
  until?: string;
  status?: "HELD" | "SETTLED";
  category?: string; // a parent includes its children
  tag?: string;
  accountId?: string;
  limit?: number; // most transactions to return; default 1000
  pageCap?: number; // most pages to follow; default 20
};

/** The Up client: the token comes in, nothing is stored. Reads are GETs; the writes are the three Up allows, each re-reading what Up now holds. */
export function upClient(options: { token: string; fetch: typeof fetch }) {
  const headers = {
    authorization: `Bearer ${options.token}`,
    accept: "application/json",
  };
  const url = (path: string) =>
    path.startsWith("https://") ? path : `${BASE}${path}`;
  const get = <T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal) =>
    getJson(options.fetch, url(path), {
      init: { headers },
      signal,
      schema,
      error: UpError,
    });
  /** A write: JSON in, the status checked, the body (if any) returned. Up answers 204 to category and tag writes. */
  async function send(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const init = {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    const res = await fetchTimeout(options.fetch, url(path), init, { signal });
    if (!res.ok)
      throw new UpError(
        `HTTP ${res.status} on ${method} ${new URL(url(path)).pathname}`,
        { status: res.status },
      );
    return res.status === 204 ? undefined : res.json();
  }
  /** Follow `links.next` until `limit` items or `pageCap` pages; `truncated` says more were there. */
  async function pages<T extends z.ZodType>(
    path: string,
    item: T,
    limit: number,
    pageCap: number,
    signal?: AbortSignal,
  ) {
    const out: z.infer<T>[] = [];
    let next: string | undefined = path;
    let n = 0;
    while (next && out.length < limit && n < pageCap) {
      const page: { data: z.infer<T>[]; links?: { next?: string | null } } =
        await get(next, Page(item), signal);
      out.push(...page.data);
      next = page.links?.next ?? undefined;
      n++;
    }
    return {
      items: out.slice(0, limit),
      truncated: next !== undefined || out.length > limit,
    };
  }
  const transaction = async (txId: string, signal?: AbortSignal) =>
    toTransaction(
      (
        await get(
          `/transactions/${encodeURIComponent(txId)}`,
          One(TransactionResource),
          signal,
        )
      ).data,
    );
  const tagBody = (labels: string[]) => ({
    data: labels.map((l) => ({ type: "tags", id: l })),
  });

  return {
    /** 200 when the token is good. */
    async ping(signal?: AbortSignal): Promise<void> {
      await get("/util/ping", z.unknown(), signal);
    },
    async accounts(
      filter: { accountType?: string; ownershipType?: string } = {},
      signal?: AbortSignal,
    ): Promise<Account[]> {
      const q = new URLSearchParams({ "page[size]": "100" });
      if (filter.accountType) q.set("filter[accountType]", filter.accountType);
      if (filter.ownershipType)
        q.set("filter[ownershipType]", filter.ownershipType);
      const { items } = await pages(
        `/accounts?${q}`,
        AccountResource,
        1000,
        10,
        signal,
      );
      return items.map((r) => ({
        id: r.id,
        displayName: r.attributes?.displayName,
        accountType: r.attributes?.accountType,
        ownershipType: r.attributes?.ownershipType,
        balanceCents: r.attributes?.balance?.valueInBaseUnits,
      }));
    },
    /** Transactions newest first, following cursors. A cut-off result says so in `truncated`, so it never looks complete. */
    async transactions(
      query: TransactionQuery = {},
      signal?: AbortSignal,
    ): Promise<{ transactions: Transaction[]; truncated: boolean }> {
      const limit = query.limit ?? 1000;
      const q = new URLSearchParams({
        "page[size]": String(Math.min(100, limit)),
      });
      for (const [k, v] of [
        ["since", query.since],
        ["until", query.until],
        ["status", query.status],
        ["category", query.category],
        ["tag", query.tag],
      ] as const)
        if (v) q.set(`filter[${k}]`, v);
      const base = query.accountId
        ? `/accounts/${encodeURIComponent(query.accountId)}/transactions`
        : "/transactions";
      const { items, truncated } = await pages(
        `${base}?${q}`,
        TransactionResource,
        limit,
        query.pageCap ?? 20,
        signal,
      );
      return { transactions: items.map(toTransaction), truncated };
    },
    transaction,
    async categories(signal?: AbortSignal): Promise<Category[]> {
      const { data } = await get(
        "/categories",
        z.looseObject({ data: z.array(CategoryResource) }),
        signal,
      );
      return data.map((c) => ({
        id: c.id,
        name: c.attributes?.name,
        parentId: id(c.relationships?.parent),
      }));
    },
    async tags(signal?: AbortSignal): Promise<string[]> {
      return (
        await pages(
          "/tags?page[size]=100",
          z.looseObject({ id: z.string() }),
          1000,
          10,
          signal,
        )
      ).items.map((t) => t.id);
    },

    // Writes. The integration never calls these; `home up categorise|tag` and a consumer's own code do.

    /** Set a child category, or `null` to clear it. Returns the transaction as Up now holds it. */
    async setCategory(
      txId: string,
      categoryId: string | null,
      signal?: AbortSignal,
    ): Promise<Transaction> {
      await send(
        "PATCH",
        `/transactions/${encodeURIComponent(txId)}/relationships/category`,
        {
          data:
            categoryId === null ? null : { type: "categories", id: categoryId },
        },
        signal,
      );
      return transaction(txId, signal);
    },
    /** Add tags by label (at most 6 per transaction; a duplicate is ignored). Returns the transaction as Up now holds it. */
    async addTags(
      txId: string,
      labels: string[],
      signal?: AbortSignal,
    ): Promise<Transaction> {
      await send(
        "POST",
        `/transactions/${encodeURIComponent(txId)}/relationships/tags`,
        tagBody(labels),
        signal,
      );
      return transaction(txId, signal);
    },
    /** Remove tags by label (an absent one is ignored). Returns the transaction as Up now holds it. */
    async removeTags(
      txId: string,
      labels: string[],
      signal?: AbortSignal,
    ): Promise<Transaction> {
      await send(
        "DELETE",
        `/transactions/${encodeURIComponent(txId)}/relationships/tags`,
        tagBody(labels),
        signal,
      );
      return transaction(txId, signal);
    },

    // Webhooks: reads, then writes behind the same gate.

    async webhooks(signal?: AbortSignal): Promise<Webhook[]> {
      return (
        await pages(
          "/webhooks?page[size]=100",
          WebhookResource,
          1000,
          10,
          signal,
        )
      ).items.map(toWebhook);
    },
    async webhook(webhookId: string, signal?: AbortSignal): Promise<Webhook> {
      return toWebhook(
        (
          await get(
            `/webhooks/${encodeURIComponent(webhookId)}`,
            One(WebhookResource),
            signal,
          )
        ).data,
      );
    },
    async webhookLogs(
      webhookId: string,
      signal?: AbortSignal,
    ): Promise<WebhookLog[]> {
      const { items } = await pages(
        `/webhooks/${encodeURIComponent(webhookId)}/logs?page[size]=30`,
        LogResource,
        30,
        1,
        signal,
      );
      return items.map((l) => ({
        id: l.id,
        deliveryStatus: l.attributes?.deliveryStatus,
        createdAt: l.attributes?.createdAt,
        statusCode: nul(l.attributes?.response)?.statusCode,
      }));
    },
    /** Create a webhook. Its `secretKey` comes back this once: the caller keeps it; this client never stores or logs it. */
    async createWebhook(
      hookUrl: string,
      description?: string,
      signal?: AbortSignal,
    ): Promise<Webhook> {
      const body = await send(
        "POST",
        "/webhooks",
        {
          data: {
            attributes: {
              url: hookUrl,
              ...(description ? { description } : {}),
            },
          },
        },
        signal,
      );
      return toWebhook(One(WebhookResource).parse(body).data);
    },
    async deleteWebhook(
      webhookId: string,
      signal?: AbortSignal,
    ): Promise<void> {
      await send(
        "DELETE",
        `/webhooks/${encodeURIComponent(webhookId)}`,
        undefined,
        signal,
      );
    },
    /** Ask Up to send a PING event to the webhook. */
    async pingWebhook(webhookId: string, signal?: AbortSignal): Promise<void> {
      await send(
        "POST",
        `/webhooks/${encodeURIComponent(webhookId)}/ping`,
        undefined,
        signal,
      );
    },
  };
}

export type UpClient = ReturnType<typeof upClient>;

const toWebhook = (w: z.infer<typeof WebhookResource>): Webhook => ({
  id: w.id,
  url: w.attributes?.url,
  description: nul(w.attributes?.description),
  createdAt: w.attributes?.createdAt,
  secretKey: w.attributes?.secretKey,
});
