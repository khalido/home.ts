# Agent memory

What earlier agent runs learned about this repository: how it is laid out,
what recurs, what its people prefer, decisions and why, traps. Dated, edited
in place, under 80 lines. A model of the repo, not a diary of runs.

- 2026-11-12: Spotify's cap workaround lives in `applyCap` and the start-signal checks inside `handle` in `src/connectors/spotify/index.ts`. `capped` allows one lowering per window; a later volume above the cap only rewrites `capNote`. Tests for it sit in `test/spotify.test.ts` under "the first play's volume (Soloist issue #23)".
- 2026-11-12: The connector README and `docs/decisions.md` are ahead of issues.json. KO rewrites the latest section as the work lands, and the README now says which version a fix is in.
- 2026-11-12: `docs/handover.md` item 1 ("hold the level, not a cap") is an unagreed proposal and contradicts `docs/decisions.md`'s "maxVolume is a write policy". Treat decisions.md as authority.
