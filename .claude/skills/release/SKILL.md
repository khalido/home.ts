---
name: release
description: Cut a release of @khalido/home - pick the 0.x bump from what a consumer would notice, roll Unreleased into a dated CHANGELOG section, fact-check it, tag, publish to npm with bun, and tell the consumers. Human-in-the-loop; nothing tags or publishes without KO's yes.
---

# /release

Cut a release of **@khalido/home** on npm (`khalido/home.ts` on GitHub). jaldi and chota-bot install it, so a version is a promise about what their code can still call.

## The design

- **SemVer at 0.x.** npm's caret treats a 0.x minor as breaking: `^0.1.0` takes 0.1.x and never 0.2.0. So:
  - **minor** (0.1.0 → 0.2.0): anything a consumer calls changes or goes: an export renamed or removed, a return type, a config field, a status or event a consumer switches on, a write's behaviour.
  - **patch** (0.1.0 → 0.1.1): fixes and additions that break nothing: a new connector, a new export, a field added to a state, a fix.
  - Never propose 1.0.0; KO decides that.
- **A published version is immutable.** npm never takes the same number twice, even after an unpublish. A mistake is the next patch.
- **`CHANGELOG.md` is the canonical record**, in [Keep a Changelog](https://keepachangelog.com/) form: `## [Unreleased]` rolls into `## [X.Y.Z] - YYYY-MM-DD` with `Added`, `Changed`, `Fixed`, `Removed`, `Deprecated`, `Security`. "Fixed" means it was wrong; "Changed" means it worked and now differs. The GitHub release notes are that section, verbatim. The first release is one `Added` section.
- **Full commit bodies in, never raw diffs.** The body has the why.
- **A fresh subagent fact-checks every claim** against the code before it lands: an editorial pass can invert meaning or name an export that doesn't exist.
- **Manual publish with `bun publish`** until trusted publishing from Actions is set up (`docs/publishing.md`). `bun publish` gives no provenance and needs KO's 2FA.

## Steps

### 1. Range and state

```bash
git fetch --tags --quiet
git describe --tags --abbrev=0 2>/dev/null   # empty = first release
git rev-parse --abbrev-ref HEAD              # main
git status --porcelain                       # clean
git log --oneline origin/main..main          # what the push will send
```

### 2. What changed

```bash
git log <last-tag>..HEAD --format='%h %ci%n%s%n%b%n---'
git diff --stat <last-tag>..HEAD
```

`## [Unreleased]` should already say most of it, since entries land with the change. Add what's missing; account for every commit; drop nothing silently. Diff the public surface against the last release, since that decides the bump:

```bash
git diff <last-tag>..HEAD -- package.json test/exports.test.ts   # entry points and their names
```

### 3. Decide the bump, in one line

Name the change that forces it: "minor: spotify's `setVolume` now resolves `{ state, confirmed }`, not a number" is an answer; "lots of improvements" isn't.

### 4. Roll the changelog and the version

`## [Unreleased]` becomes `## [X.Y.Z] - YYYY-MM-DD`; leave a fresh empty `## [Unreleased]` above it; set `version` in `package.json`. Plain, concrete, no AI-speak.

### 5. Fact-check (a fresh subagent, Sonnet)

Not the one that drafted it. Hand it the section and the repo; per claim it returns CONFIRMED, WRONG or IMPRECISE with file:line. It checks:

- every export, option, event and type the section names exists in `src/` with that name;
- each "now does" matches the code as it is, in the right direction;
- counts and overclaims ("every", "all", "nine connectors");
- new since the last tag: `git merge-base --is-ancestor <hash> <last-tag>`.

Fix what it flags before step 7.

### 6. Check what ships

```bash
bun run check && bun test
bun publish --dry-run                        # runs prepublishOnly; lists files, version, access, tag
```

The pack list must not hold `docs/handover.md`, `docs/publishing.md`, `private/`, `drafts/` or `.env`. Grep the packed files for IPs, MACs and KO's device names (AGENTS.md: never in the repo).

### 7. Show KO, and stop

The version and the one-line reason, the changelog section, the fact-check result, the dry run's numbers, and what the push sends. Nothing commits, tags, pushes or publishes without a yes.

### 8. Commit, tag, push, publish (after the yes)

```bash
git add CHANGELOG.md package.json && git commit -m "Release vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main --follow-tags           # main only: never --all, never pre-squash
bun publish                                  # KO answers the 2FA; --auth-type legacy for a terminal prompt
gh release create vX.Y.Z --repo khalido/home.ts --title "vX.Y.Z" --verify-tag --notes-file - <<'NOTES'
<the changelog section, without its heading>
NOTES
```

`bun publish` needs KO at the keyboard for the 2FA: if this session can't prompt him, stop after the push and hand him the two commands. Then check it landed: `npm view @khalido/home version`.

### 9. After

- Tell the consumers: chota-bot's and jaldi's sessions, with the version and what changed for them (the bump's reason first).
- Refresh `docs/project-map.html` with the `project-map` skill, if the repo has one.
- Rewrite `docs/handover.md`: the version out, what's next.

## First release only

- No tag yet, so the range is everything on `main`; the history before the squash stays local in `pre-squash` and is never pushed.
- The repo goes public before `bun publish`, or the npm page's links and `llms.txt`'s 404: Settings → Danger Zone → Change visibility.
- `check.yml` runs on GitHub for the first time on that push.
