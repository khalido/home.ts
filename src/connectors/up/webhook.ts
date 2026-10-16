// Receiving Up's webhooks is the consumer's job (it needs a public URL); these two pure functions are all it needs from
// here. The handler: verify, parse, then `home.refresh("up")`. Web Crypto only, so it runs on Bun, Node and workers.

/** The header Up signs each event with: the SHA-256 HMAC of the raw body under the webhook's `secretKey`, hex. */
export const SIGNATURE_HEADER = "X-Up-Authenticity-Signature";

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** True when `signature` (the header's value) is the HMAC of `rawBody` under `secret`. Compares in constant time. */
export async function verifyWebhook(rawBody: string | Uint8Array, signature: string | null | undefined, secret: string): Promise<boolean> {
  if (!signature) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const body = typeof rawBody === "string" ? enc.encode(rawBody) : rawBody;
  const want = hex(await crypto.subtle.sign("HMAC", key, body as Uint8Array<ArrayBuffer>));
  const got = signature.trim().toLowerCase();
  let diff = want.length ^ got.length;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ (got.charCodeAt(i) || 0);
  return diff === 0;
}

/** One webhook event: its type ("TRANSACTION_CREATED", "TRANSACTION_SETTLED", "TRANSACTION_DELETED", "PING") and the transaction it names. */
export type WebhookEvent = { id?: string; type?: string; createdAt?: string; transactionId?: string };

/** The event in a webhook body. Fields Up leaves out stay undefined; a body that is not JSON throws. */
export function parseWebhookEvent(body: unknown): WebhookEvent {
  const json = (typeof body === "string" ? JSON.parse(body) : body) as { data?: { id?: string; attributes?: { eventType?: string; createdAt?: string }; relationships?: { transaction?: { data?: { id?: string } } } } };
  const d = json?.data;
  return { id: d?.id, type: d?.attributes?.eventType, createdAt: d?.attributes?.createdAt, transactionId: d?.relationships?.transaction?.data?.id };
}
