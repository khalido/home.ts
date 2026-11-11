import { z } from "zod";
import { type Clock, realClock } from "../../clock.ts";
import { ConnectorError, getJson } from "../../connector.ts";
import { writeLane } from "../../lane.ts";

// Daikin's JSON dsiot API (the BRP084 family): POST /dsiot/multireq, plain HTTP, no key. Field paths and value
// maps are protocol facts from pydaikin (GPL-3.0, read only; see README.md), checked against KO's unit 2026-10-13.

/** A failed Daikin call. `status` is the HTTP status, or the dsiot `rsc` when HTTP succeeded. */
export class DaikinError extends ConnectorError {}

export type Mode = "auto" | "cool" | "heat" | "fan" | "dry";
export type Fan = "1" | "2" | "3" | "4" | "5" | "auto" | "quiet";

/** The AC now. Temperatures in °C as the unit reports them. */
export type DaikinState = {
  on?: boolean;
  mode?: Mode; // the selected mode, kept while the unit is off
  targetC?: number; // the setpoint of the selected mode; none in fan or dry
  roomC?: number;
  humidity?: number; // percent
  fan?: Fan; // the fan speed of the selected mode; none in dry
  outsideC?: number;
  anomaly?: string; // a code or value the maps here do not know, kept visible rather than guessed
};

type Node = { pn?: string; pv?: unknown; pch?: Node[] };
const Node: z.ZodType<Node> = z.looseObject({
  pn: z.string().optional(),
  pv: z.unknown().optional(),
  get pch() {
    return z.array(Node).optional();
  },
});
const Multi = z.looseObject({
  responses: z.array(
    z.looseObject({
      fr: z.string().optional(),
      rsc: z.number().optional(),
      pc: Node.optional(),
    }),
  ),
});
type Multi = z.infer<typeof Multi>;

const INDOOR = "/dsiot/edge/adr_0100.dgc_status";
const OUTDOOR = "/dsiot/edge/adr_0200.dgc_status";

const MODES: Record<string, Mode> = {
  "0000": "fan",
  "0100": "heat",
  "0200": "cool",
  "0300": "auto",
  "0500": "dry",
};
const FANS: Record<string, Fan> = {
  "0300": "1",
  "0400": "2",
  "0500": "3",
  "0600": "4",
  "0700": "5",
  "0A00": "auto",
  "0B00": "quiet",
};
/** Each mode keeps its own setpoint and fan speed under `e_3001`. */
const TARGET: Partial<Record<Mode, string>> = {
  cool: "p_02",
  heat: "p_03",
  auto: "p_1D",
};
const FAN: Partial<Record<Mode, string>> = {
  cool: "p_09",
  heat: "p_0A",
  auto: "p_26",
  fan: "p_28",
};
/** The setpoint range per mode, from the unit's own `md.mi`/`md.mx` (KO's unit, 2026-10-13). */
const TARGET_RANGE: Partial<Record<Mode, [number, number]>> = {
  cool: [18, 32],
  heat: [10, 30],
  auto: [18, 30],
};

/**
 * The setpoint a mode gets when the caller names none: this library's opinion (KO's: not too cold, properly warm).
 * Without one, "cool" would mean whatever the remote last left. Auto keeps the unit's own.
 */
export const DEFAULT_TARGET_C = {
  cool: 25,
  heat: 27,
} as const satisfies Partial<Record<Mode, number>>;

/** What a write left: the state once the unit reported the change (`confirmed`), or as it stood when `CONFIRM_MS` ran out without it. */
export type DaikinApplied = { state: DaikinState; confirmed: boolean };
/** How long `power` and `mode` wait for the unit to report what was asked, reading once a second. */
export const CONFIRM_MS = 5000;

/** Little-endian hex to an integer, two's complement when `signed`: "2700" → 39, "EEFF" → -18. */
export function hexLE(hex: string, signed = false): number | undefined {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return undefined;
  const bytes = hex.match(/../g)!.reverse().join("");
  const n = Number.parseInt(bytes, 16);
  return signed && n >= 2 ** (hex.length * 4 - 1)
    ? n - 2 ** (hex.length * 4)
    : n;
}

/** The `pv` at a path of `pn` names under one response's tree, by name (never by position). */
function value(m: Multi, fr: string, path: string[]): string | undefined {
  let node = m.responses.find((r) => r.fr === fr)?.pc;
  for (const pn of path) node = node?.pch?.find((c) => c.pn === pn);
  return typeof node?.pv === "string" ? node.pv : undefined;
}

/** Map the indoor and outdoor `dgc_status` trees to a state. Unknown codes go to `anomaly`, never to a guess. */
export function toState(response: unknown): DaikinState {
  const m = Multi.parse(response);
  const odd: string[] = [];
  const indoor = (...path: string[]) => value(m, INDOOR, ["e_1002", ...path]);
  const code = <T>(
    map: Record<string, T>,
    hex: string | undefined,
    what: string,
  ) => {
    if (hex !== undefined && !(hex in map))
      odd.push(`unknown ${what} code ${hex}`);
    return hex === undefined ? undefined : map[hex];
  };
  const temp = (hex: string | undefined, divisor: number, what: string) => {
    if (hex === undefined) return undefined;
    const n = hexLE(hex, true);
    if (n === undefined) odd.push(`${what} is not hex: ${hex}`);
    return n === undefined ? undefined : n / divisor;
  };
  const power = indoor("e_A002", "p_01");
  if (power !== undefined && power !== "00" && power !== "01")
    odd.push(`unknown power code ${power}`);
  const mode = code(MODES, indoor("e_3001", "p_01"), "mode");
  const target = mode && TARGET[mode];
  const fan = mode && FAN[mode];
  const humidityHex = indoor("e_A00B", "p_02");
  const humidity = humidityHex === undefined ? undefined : hexLE(humidityHex);
  if (humidityHex !== undefined && humidity === undefined)
    odd.push(`humidity is not hex: ${humidityHex}`);
  return {
    on: power === "01" ? true : power === "00" ? false : undefined,
    mode,
    targetC: target ? temp(indoor("e_3001", target), 2, "target") : undefined,
    roomC: temp(indoor("e_A00B", "p_01"), 1, "room temperature"),
    humidity,
    fan: fan ? code(FANS, indoor("e_3001", fan), "fan") : undefined,
    outsideC: temp(
      value(m, OUTDOOR, ["e_1003", "e_A00D", "p_01"]),
      2,
      "outside temperature",
    ),
    anomaly: odd.length ? odd.join("; ") : undefined,
  };
}

/** A multireq body that writes one or more `e_1002` fields of the indoor unit (op 3), merged into one tree. */
export type WriteRequest = { requests: { op: 3; to: string; pc: Node }[] };
const write = (
  fields: [entity: string, pn: string, pv: string][],
): WriteRequest => ({
  requests: [
    {
      op: 3,
      to: INDOOR,
      pc: {
        pn: "dgc_status",
        pch: [
          {
            pn: "e_1002",
            pch: fields.map(([e, pn, pv]) => ({ pn: e, pch: [{ pn, pv }] })),
          },
        ],
      },
    },
  ],
});
const fields = (r: WriteRequest): [string, string, string][] =>
  r.requests.flatMap((q) =>
    (q.pc.pch ?? []).flatMap((e1002) =>
      (e1002.pch ?? []).flatMap((e) =>
        (e.pch ?? []).map((f): [string, string, string] => [
          e.pn!,
          f.pn!,
          String(f.pv),
        ]),
      ),
    ),
  );

/** Two writes as one, field by field, the newer value winning: `setMode("cool")` then `setPower(false)` sends mode cool, power off. */
export function mergeWrites(
  older: WriteRequest,
  newer: WriteRequest,
): WriteRequest {
  const merged = new Map(fields(older).map((f) => [`${f[0]}/${f[1]}`, f]));
  for (const f of fields(newer)) merged.set(`${f[0]}/${f[1]}`, f);
  return write([...merged.values()]);
}

/** Writes to the unit at most this often, and at most `WRITE_PER_MINUTE` a minute; a guess, the BRP084's limits are unpublished. */
export const WRITE_GAP_MS = 1000;
export const WRITE_PER_MINUTE = 20;

const key = <T>(map: Record<string, T>, v: T) =>
  Object.keys(map).find((k) => map[k] === v)!;

/** Turn the unit on or off. */
export const setPower = (on: boolean) =>
  write([["e_A002", "p_01", on ? "01" : "00"]]);

/** Select a mode and turn the unit on, as pydaikin and the Alira integration both do. */
export const setMode = (mode: Mode) =>
  write([
    ["e_A002", "p_01", "01"],
    ["e_3001", "p_01", key(MODES, mode)],
  ]);

/** Set the setpoint of `mode` (usually the current one), one byte of °C × 2. Throws off the unit's range or 0.5 steps; never rounds. */
export function setTarget(c: number, mode: Mode): WriteRequest {
  const range = TARGET_RANGE[mode];
  if (!range) throw new DaikinError(`${mode} mode has no setpoint`);
  if (!Number.isInteger(c * 2) || c < range[0] || c > range[1])
    throw new DaikinError(
      `${c} °C is not a ${mode} setpoint (${range[0]}–${range[1]} in 0.5 steps)`,
    );
  return write([
    [
      "e_3001",
      TARGET[mode]!,
      (c * 2).toString(16).toUpperCase().padStart(2, "0"),
    ],
  ]);
}

/** Set the fan speed of `mode` (usually the current one). */
export function setFan(fan: Fan, mode: Mode): WriteRequest {
  if (!FAN[mode]) throw new DaikinError(`${mode} mode has no fan speed`);
  return write([["e_3001", FAN[mode]!, key(FANS, fan)]]);
}

/** A client for one unit. Reads are op 2. `power` and `mode` are the writes most callers want; `write` sends any body built by setPower, setMode, setTarget or setFan. */
export function daikinClient(options: {
  host: string;
  fetch: typeof fetch;
  clock?: Clock;
}) {
  const lane = writeLane({
    gapMs: WRITE_GAP_MS,
    perMinute: WRITE_PER_MINUTE,
    clock: options.clock,
  });
  const multireq = (body: unknown, signal?: AbortSignal): Promise<Multi> =>
    getJson(options.fetch, `http://${options.host}/dsiot/multireq`, {
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      signal,
      schema: Multi,
      error: DaikinError,
    });
  const clock = options.clock ?? realClock;
  const client = {
    /** The indoor and outdoor status in one request. A failed outdoor read leaves `outsideC` empty. */
    async read(signal?: AbortSignal): Promise<DaikinState> {
      const m = await multireq(
        {
          requests: [INDOOR, OUTDOOR].map((to) => ({
            op: 2,
            to: `${to}?filter=pv,pt,md`,
          })),
        },
        signal,
      );
      const indoor = m.responses.find((r) => r.fr === INDOOR);
      if (indoor?.rsc !== 2000)
        throw new DaikinError(`no indoor status (rsc ${indoor?.rsc})`, {
          status: indoor?.rsc,
        });
      return toState(m);
    },
    /**
     * Send a write. Only when KO asks: this changes the AC. Needs an answer for the indoor unit below 4000 (success codes
     * unconfirmed; re-read to be sure). Writes waiting their turn merge (`mergeWrites`) and resolve with the send that carried them.
     */
    write(request: WriteRequest): Promise<void> {
      return lane.send(
        "unit",
        request,
        async (r) => {
          const answer = (await multireq(r)).responses.find(
            (x) => x.fr === INDOOR,
          );
          if (!answer || answer.rsc === undefined || answer.rsc >= 4000)
            throw new DaikinError(
              `no accepted answer from the indoor unit (rsc ${answer?.rsc})`,
              { status: answer?.rsc },
            );
        },
        mergeWrites,
      );
    },
  };
  /** Send `request`, then read once a second until the unit reports `asked` or `CONFIRM_MS` passes. Rejects if the write is refused, or if no read after it succeeds. */
  async function apply(
    request: WriteRequest,
    asked: (s: DaikinState) => boolean,
  ): Promise<DaikinApplied> {
    await client.write(request);
    const until = clock.now() + CONFIRM_MS;
    let state: DaikinState | undefined;
    let failed: unknown;
    // The write was accepted, so one dropped read must not turn it into a failure: keep reading until the time is up.
    for (;;) {
      try {
        state = await client.read();
        if (asked(state)) break;
      } catch (error) {
        failed = error;
      }
      if (clock.now() >= until) break;
      await clock.sleep(1000);
    }
    if (!state) throw failed; // sent, but the unit answered no read since: nothing to report
    return { state, confirmed: asked(state) };
  }
  return {
    ...client,
    /** Turn the unit on or off, as it was last left. Only when a person asks. Resolves with what the unit then reported. */
    power: (on: boolean): Promise<DaikinApplied> =>
      apply(setPower(on), (s) => s.on === on),
    /**
     * Select a mode, turn the unit on and set its setpoint, in one request: `targetC`, else `DEFAULT_TARGET_C` (cool 25,
     * heat 27), else (auto) the unit's own. Dry and fan take none, and a `targetC` for them throws before anything is
     * sent, as one off the unit's range does. Only when a person asks. Resolves with what the unit then reported.
     */
    async mode(mode: Mode, targetC?: number): Promise<DaikinApplied> {
      const c =
        targetC ?? (DEFAULT_TARGET_C as Partial<Record<Mode, number>>)[mode];
      return apply(
        c === undefined
          ? setMode(mode)
          : mergeWrites(setMode(mode), setTarget(c, mode)),
        (s) =>
          s.on === true &&
          s.mode === mode &&
          (c === undefined || s.targetC === c),
      );
    },
  };
}
