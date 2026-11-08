import { describe, expect, test } from "bun:test";
import { checkPlan } from "../src/config.ts";
import { applyLocation, geocode } from "../src/locate.ts";

// An invented answer in Nominatim's jsonv2 shape, for a documentation address.
const answer = [
  {
    place_id: 1,
    lat: "-33.8688197",
    lon: "151.2092955",
    display_name: "1, Example Street, Sydney, New South Wales, 2000, Australia",
    type: "house",
  },
];

describe("geocode", () => {
  test("one request with the address, jsonv2, one result and the User-Agent; coordinates as numbers, unrounded", async () => {
    const calls: { url: string; agent: string | null }[] = [];
    const f = (async (url: string, init?: RequestInit) => (
      calls.push({ url, agent: new Headers(init?.headers).get("user-agent") }),
      Response.json(answer)
    )) as unknown as typeof fetch;
    const at = await geocode("1 Example Street, Sydney", {
      fetch: f,
      userAgent: "khalido-home/0.0.0",
    });
    expect(at).toEqual({
      name: answer[0]!.display_name,
      latitude: -33.8688197,
      longitude: 151.2092955,
    });
    expect(calls).toEqual([
      {
        url: "https://nominatim.openstreetmap.org/search?q=1+Example+Street%2C+Sydney&format=jsonv2&limit=1",
        agent: "khalido-home/0.0.0",
      },
    ]);
  });

  test("no match is undefined; a refusal or an odd answer throws", async () => {
    const reply = (body: unknown, status = 200) =>
      (async () => Response.json(body, { status })) as unknown as typeof fetch;
    expect(
      await geocode("nowhere", { fetch: reply([]), userAgent: "x" }),
    ).toBeUndefined();
    await expect(
      geocode("x", { fetch: reply({ error: "blocked" }, 403), userAgent: "x" }),
    ).rejects.toThrow("Nominatim answered 403");
    await expect(
      geocode("x", {
        fetch: reply([{ display_name: "x", lat: "north" }]),
        userAgent: "x",
      }),
    ).rejects.toThrow("not a list of places");
  });
});

describe("applyLocation", () => {
  const at = { latitude: -33.8688197, longitude: 151.2092955 };

  test("sets latitude and longitude in place; an existing timezone and every other line stay", () => {
    const text = `{\n  // where it is\n  "location": { "latitude": 1, "longitude": 2, "bomForecast": "Sydney", "timezone": "Australia/Sydney" },\n  "name": "x"\n}\n`;
    const r = applyLocation(text, at, "Europe/London");
    expect(r).toMatchObject({ fresh: false, timezoneSet: false });
    expect(r.text).toBe(
      text.replace(
        '"latitude": 1, "longitude": 2',
        '"latitude": -33.8688197, "longitude": 151.2092955',
      ),
    );
  });

  test("a location without a timezone gets the runtime's", () => {
    const r = applyLocation(
      `{ "location": { "latitude": 1, "longitude": 2 } }`,
      at,
      "Australia/Sydney",
    );
    expect(r.timezoneSet).toBe(true);
    expect(checkPlan(Bun.JSONC.parse(r.text)).config!.location).toEqual({
      ...at,
      timezone: "Australia/Sydney",
    });
  });

  test("a commented-out location is left as it was and a fresh one added", () => {
    const text = `{\n  "name": "x",\n  // "location": { "latitude": 1, "longitude": 2 },\n  "devices": []\n}\n`;
    const r = applyLocation(text, at, "Australia/Sydney");
    expect(r.fresh).toBe(true);
    expect(r.text).toContain(
      `// "location": { "latitude": 1, "longitude": 2 },`,
    );
    const parsed = checkPlan(Bun.JSONC.parse(r.text));
    expect(parsed.problems).toEqual([]);
    expect(parsed.config!.location).toEqual({
      ...at,
      timezone: "Australia/Sydney",
    });
  });
});
