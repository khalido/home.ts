import { z } from "zod";

// The JSON payloads a state reader receives, every field optional, unknown fields kept. Shapes from the live devices
// (2026-10-13, see README) and pychromecast for media status, which nothing was playing to record.

const Volume = z.looseObject({
  controlType: z.string().optional(), // "master" | "attenuation" | "fixed"
  level: z.number().optional(),
  muted: z.boolean().optional(),
  stepInterval: z.number().optional(),
});

export const Application = z.looseObject({
  appId: z.string().optional(),
  displayName: z.string().optional(),
  isIdleScreen: z.boolean().optional(),
  namespaces: z
    .array(z.looseObject({ name: z.string().optional() }))
    .optional(),
  sessionId: z.string().optional(),
  statusText: z.string().optional(),
  transportId: z.string().optional(),
});
export type Application = z.infer<typeof Application>;

export const ReceiverStatus = z.looseObject({
  type: z.literal("RECEIVER_STATUS"),
  status: z
    .looseObject({
      applications: z.array(Application).optional(),
      isStandBy: z.boolean().optional(),
      isActiveInput: z.boolean().optional(),
      volume: Volume.optional(),
    })
    .optional(),
});

export const MediaStatus = z.looseObject({
  type: z.literal("MEDIA_STATUS"),
  status: z
    .array(
      z.looseObject({
        mediaSessionId: z.number().optional(),
        playerState: z.string().optional(), // "PLAYING" | "PAUSED" | "BUFFERING" | "IDLE"
        idleReason: z.string().optional(), // "FINISHED" | "CANCELLED" | "INTERRUPTED" | "ERROR"
        currentTime: z.number().optional(), // seconds into the media
        media: z
          .looseObject({
            contentId: z.string().optional(),
            contentType: z.string().optional(),
            streamType: z.string().optional(),
            duration: z.number().nullish(), // seconds; null for a live stream
            metadata: z
              .looseObject({
                title: z.string().optional(),
                artist: z.string().optional(),
              })
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

const Member = z.looseObject({
  deviceId: z.string().optional(),
  name: z.string().optional(),
  volume: Volume.optional(),
});

export const MultizoneStatus = z.looseObject({
  type: z.literal("MULTIZONE_STATUS"),
  status: z.looseObject({ devices: z.array(Member).optional() }).optional(),
});

/** A group's membership changing while connected: added and updated carry the member, removed only its id. */
export const MemberChange = z.looseObject({
  type: z.enum(["DEVICE_ADDED", "DEVICE_UPDATED", "DEVICE_REMOVED"]),
  device: Member.optional(),
  deviceId: z.string().optional(),
});

/** Every payload the reducer reads; anything else (PONG, LAUNCH_STATUS, …) fails to parse and is ignored by type. */
export const CastPayload = z.discriminatedUnion("type", [
  ReceiverStatus,
  MediaStatus,
  MultizoneStatus,
  MemberChange,
]);
export type CastPayload = z.infer<typeof CastPayload>;

/** The types the reducer knows; a payload of one of these that fails its schema is an anomaly, any other type is ignored. */
export const KNOWN_TYPES = new Set([
  "RECEIVER_STATUS",
  "MEDIA_STATUS",
  "MULTIZONE_STATUS",
  "DEVICE_ADDED",
  "DEVICE_UPDATED",
  "DEVICE_REMOVED",
]);
