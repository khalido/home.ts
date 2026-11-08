---
name: draw-home
description: Draw a simple, themeable SVG plan of a home from photos, a floor plan or a description, plus the rooms in home.jsonc (the home config) that place devices, so an app can show each device's live state on it. Use when asked to draw, trace or update a house plan or home view for @khalido/home. One home per run.
---

# Draw a home

The library does not draw. This guide is for the coding agent that does: turn what the person has (a floor plan PDF or photo, phone photos of rooms, a sketch, a description) into a drawing plus its entries in the home config, private when they describe a real house:

- `home.svg`: a plain plan, one group and one empty marker per room.
- `home.jsonc`: the home config (`src/config.ts`, `home.schema.json`). This skill writes its `plan.svg` and `rooms`, and a device's `room` or `marker`; the connectors' fields (addresses, ids, key names) belong to whoever sets the device up. `checkPlan` checks the result.

Start from `examples/home.svg` and `examples/home.jsonc`. Never start from a blank file. If the person already has a `home.jsonc`, edit its `rooms` and `plan` in place, keeping its comments, and leave every other field alone.

This is the home-sized version of the sfl-mes `device-drawing` skill (`~/code/sfl-mes/.claude/skills/device-drawing/`), which draws single machines; read it when a rule here seems thin.

## 1. Sources, before any geometry

Make a **room table** first, in the SVG's header comment: each room, its floor, its name as the person says it, and the source (plan sheet and page, or photo). Nothing is drawn that has no row.

- **The plan first, at full resolution**: a builder's or renovation plan beats photos for layout. Photos settle names, doors and where devices sit.
- **Unknown stays unknown.** A room the source leaves unlabelled gets a neutral id (`room-unnamed-a`) and a question to the person. No furniture, fittings, dimensions or decoration to make it look rich.
- **Devices from the person or from the connectors** (`home discover`, Hue's room list), never guessed from a photo of a lamp.
- **Not to scale is fine**; say so. If a plan is old, say the house as built may differ.

## 2. Draw

- Rooms as rectangles, or simple paths for L-shapes; walls, the front door, stairs. Front of the house in the same place on every floor; one floor per band of the canvas, labelled, ground below.
- **Style: a flat plan by default.** `README.md` beside this file lists the drawing references (iso-glow, Anatomy, Hairline, iso-figure) with what each is good for.
- **Isometric options.** A glowing fine-line drawing in the [iso-glow](https://isoglow.dev/) style suits a live view; an isometric cutaway in the **Anatomy** style (solid figures, MIT, `~/code/refs/anatomy/`, [skills.wheresryan.sh/anatomy](https://skills.wheresryan.sh/anatomy)) is an option when the person asks for it: read its `SKILL.md` craft rules and `examples/desk-computer/` (in the Anatomy repo), keep this contract, and draw rooms as low boxes with the markers on their floors.

## 3. The contract (an app draws on this; keep it exact)

1. Each room is `<g class="room" id="room-…" data-floor="…" data-name="…">` with its shape and label. Ids are lowercase, stable, never renamed once devices refer to them.
2. Each room holds one empty `<g class="marker" id="marker-…" transform="translate(x,y)">` at its top-right inner corner. Apps draw state there at the origin and never move it.
3. `currentColor` and low-alpha fills, so a page that inlines the SVG themes it; a `<style>` on `svg:root` colours it when opened alone; `prefers-color-scheme` for dark. One file, no external loads.
4. A header comment: source, date, not to scale, the room table, and this contract. `role="img"` and an `aria-label` on the root.
5. The SVG fills its host (`width: 100%; height: 100%`; the viewBox holds everything).
6. **Zoomable**: one root `<g id="plan">` holding every floor, no fixed pixel sizes, labels sized so they still read when a single room fills the screen. Each room group's `getBBox()` is its zoom target, so keep a room's label and marker inside its shape.

**What an app does with it** (from sfl-mes's live contract): it draws each device's state into its room's marker from `home.snapshot()`. A missing part is "no data": grey marker, no value, never a stale number shown as live. Values are shown as read, never clamped; odd ones (`Part.anomaly`) get a flag. Hover names the device. Controls live in the app's side panel, not in the SVG.

**Energy on the plan** (the numbers are the library's, the drawing and animation are the app's):

- **Solar.** The Enphase device's `marker` in `home.jsonc` names a `<g class="marker" id="marker-…">` outside any room, where the array is drawn on the roof (the panels as a group of low-alpha rects, the marker at its top-right corner). The app glows the panels from `solarLevel(energyNow(…), capacityW)`: against the device's `capacityW` (rated watts, from the config, never guessed) when set, else against today's highest reading so far (`solarPeakTodayW`). The two scales mean different things, so the drawing says which ("of 6.6 kW" or "of today's peak"). The level is never clamped: above 1 is drawn as full and labelled as read. "No data" when `solarW` is undefined.
- **Flow.** Lines run panels → house while `solarW` is above zero, and house ↔ grid from the outer wall to the plan's edge, animated in the direction of `energyNow.flow`: outward while `"exporting"`, inward while `"importing"`, still while `"balanced"` (the library's 20 W display band). The speed or density scales with `surplusW` when exporting and `gridW` when importing. "No data" (no animation, grey line) when `gridW` is undefined; never a last value shown as live.
- Labels beside the lines come from the same object: "exporting 1.2 kW, earning 42 c/h" from `surplusW` and `surplusCentsPerHour`, never recomputed in the app.

**Interactive, in the app**: wheel or pinch zooms and drag pans (animate the `viewBox`, or a transform on `#plan`); clicking a room zooms to its bounding box and opens that room's devices in the side panel; Escape or double-click returns to the whole house; arrow keys move between rooms. Respect reduced motion (jump, do not animate). A flat plan only zooms and pans.

**SVG with a camera** (the interactive option, Anatomy's approach and sfl-mes's "spin"): build the house once as a model in metres (each room a box: x, y, width, depth, floor height; walls and doors on it), and render it to SVG through a camera `{ azimuth, elevation, target, zoom }` with Anatomy's `fitProjection` (`~/code/refs/anatomy/kit/iso-kit.mjs`). The scene is a pure function of the camera, so zooming, orbiting and "fly to this room" are a redraw with a new camera, eased; drag orbits, wheel zooms, click a room sets the target to its centre. The rendered SVG still meets the contract above: one `<g class="room">` per room and a marker projected to the room's top corner on every redraw. Keep the model in its own file named by `plan.json` in the config (sizes are data, not hard-coded in the drawing), and spring back to the default camera on Escape.

## 4. home.jsonc

```jsonc
{
  "$schema": "<path to home.schema.json>",
  "plan": { "svg": "home.svg" },
  "rooms": [
    // id matches <g class="room" id="…">; hueRoom: the Hue room whose lights this room's marker shows, once known
    {
      "id": "room-living",
      "name": "Living",
      "floor": "ground",
      "hueRoom": "<hue room id>",
    },
  ],
  // devices: set `room` on one that already exists; adding a device is the connector's job, not this skill's
}
```

Room ids start with `room-`; names are what the person calls them (an unlabelled room keeps `""` until they say). No `room` on whole-house devices (solar, prices). The solar array is drawn on the roof with its own marker; set the Enphase device's `marker` to its id, and `capacityW` only when the person gives the rated size. Lights are placed through the room's `hueRoom`, not as devices. `marker` in the config always means an SVG marker id.

## 5. Check before hand-over

- [ ] Every room-table row is drawn or listed as left out; every room has a marker; ids match the config's `rooms`; `checkPlan` reports nothing and `home config check` runs clean (`test/config.test.ts` shows the SVG check).
- [ ] Open it in a browser, light and dark, at 320 px and 900 px wide: labels readable, nothing overlaps, no scroll.
- [ ] Side by side with the source plan: same rooms, same order, same doors.
- [ ] **Review**: a second agent with fresh context gets the source, the room table and the SVG (not your report), checks each row, and reports `wrong`, `guessed`, `ok`. Open three of its findings yourself.
- [ ] Private files stay private: a real `home.svg` and `home.jsonc` live beside the person's settings, never in this repo or any public one.

Hand over: the two paths, the room table's open questions, and what could not be verified.
