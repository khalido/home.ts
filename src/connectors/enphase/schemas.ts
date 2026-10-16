import { z } from "zod";

// Shapes from Enphase's TEB-00060 and pyenphase's recorded gateway replies (MIT, software 7 and 8).
// Loose objects, optional fields: a firmware change degrades a reading, it does not throw.

/** One measurement in `/production.json`: an `inverters` total or an `eim` meter reading. */
export const Measurement = z.looseObject({
  type: z.string(), // "inverters" | "eim" | "acb" (battery)
  measurementType: z.string().optional(), // eim: "production" | "total-consumption" | "net-consumption"
  activeCount: z.number().optional(), // 0 means the meter is not really measuring
  wNow: z.number().optional(),
  whToday: z.number().optional(),
  whLifetime: z.number().optional(),
  readingTime: z.number().optional(), // unix seconds
});
export type Measurement = z.infer<typeof Measurement>;

/** `GET /production.json?details=1`. */
export const Production = z.looseObject({
  production: z.array(Measurement).default([]),
  consumption: z.array(Measurement).default([]),
});

/** `GET /ivp/meters`: which current transformers exist and whether they are switched on. */
export const Meters = z.array(z.looseObject({ eid: z.number().optional(), measurementType: z.string(), state: z.string() }));

/** `GET /ivp/meters/readings`: one reading per meter, joined to `/ivp/meters` by `eid`. */
export const Readings = z.array(
  z.looseObject({
    eid: z.number(),
    timestamp: z.number().optional(), // unix seconds
    activePower: z.number().optional(), // W: production, or grid import (negative = export) on a net meter
    actEnergyDlvd: z.number().optional(), // Wh lifetime: produced, or imported on a net meter
    actEnergyRcvd: z.number().optional(), // Wh lifetime: exported on a net meter
  }),
);

/** The JSON from Enphase's login: only the session id is used. */
export const Login = z.looseObject({ session_id: z.string() });
