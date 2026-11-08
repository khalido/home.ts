# Performance

`bun run bench`, Bun 1.4.2, Apple M5, 2026-10-13. Means per iteration:

| What                                                   | Time   |
| ------------------------------------------------------ | ------ |
| Parse 1,000 event-stream messages in 4 KiB chunks      | 475 µs |
| Apply 1,000 events to a snapshot                       | 208 µs |
| Rooms view of a snapshot (fixture: 2 groups, 2 lights) | 0.6 µs |
| Queue 100 writes (fake clock, so overhead only)        | 14 µs  |

Against the bridge (Bun 1.4.2, measured by curl and `fetch` on KO's LAN): 124 ms for a cold pinned request, 16 ms kept alive.
