import { z } from "zod";

// Shapes from Signify's CLIP v2, checked against openhue-api's OpenAPI spec (Apache-2.0,
// github.com/openhue/openhue-api, 2026-10). Signify's own reference is login-gated, so every
// field is unconfirmed from the primary source. Only the fields the snapshot reads are parsed;
// all are optional and unknown fields pass through, so a schema change degrades, never throws.

const ref = z.object({ rid: z.string(), rtype: z.string() });

/** The resource kinds this library reads. */
export const KINDS = ["light", "room", "zone", "grouped_light", "scene", "bridge_home", "zigbee_connectivity"] as const;
export type Kind = (typeof KINDS)[number];

/** One CLIP v2 resource, loosely typed: id and type, plus the optional fields the snapshot uses. */
export const Resource = z.looseObject({
  id: z.string(),
  type: z.string(),
  owner: ref.optional(),
  metadata: z.looseObject({ name: z.string().optional() }).optional(),
  on: z.looseObject({ on: z.boolean() }).optional(),
  dimming: z.looseObject({ brightness: z.number() }).optional(),
  children: z.array(ref).optional(),
  services: z.array(ref).optional(),
  group: ref.optional(), // scene: the room or zone it belongs to
  status: z.unknown().optional(), // scene: { active }; zigbee_connectivity: "connected" | …
});
export type Resource = z.infer<typeof Resource>;

/** The CLIP v2 response envelope: `{ errors, data }`. */
export const Envelope = z.object({
  errors: z.array(z.object({ description: z.string() })).default([]),
  data: z.array(z.unknown()).default([]),
});

/** One event-stream batch. `data` holds partial resources: only the fields that changed. */
export const HueEvent = z.object({
  id: z.string(),
  type: z.string(), // "add" | "update" | "delete" | "error"; anything newer is ignored, not fatal
  creationtime: z.string(),
  data: z.array(z.looseObject({ id: z.string(), type: z.string() })),
});
export type HueEvent = z.infer<typeof HueEvent>;

/** `POST /api` answers with a one-element array holding `success` or `error` (v1 shape). */
export const PairResponse = z.array(
  z.object({
    success: z.object({ username: z.string(), clientkey: z.string().optional() }).optional(),
    error: z.object({ type: z.number(), description: z.string() }).optional(),
  }),
);
