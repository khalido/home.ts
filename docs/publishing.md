# Publishing to npm

A release of home.ts: run `/release`. It tags, pushes and creates a GitHub release. The release starts `publish.yml`, which stages the version on npm. I approve it with 2FA and it goes live.

The rest is how to set this up, for the next package too. Checked 2026-11-09: npm CLI 11.20.0, Bun 1.4.4, Node 26.11.1.

## A new package, in order

1. **Turn on 2FA** on the npm account (npmjs.com → Account). Without it, npm answers 403.
2. **Set up `package.json`:**
   - `name`, `version`, `license`, and `repository.url` matching the GitHub repo. Provenance checks that URL.
   - `publishConfig: { "access": "public" }` for a scoped package.
   - `files`: an allow-list. Exclude private docs with `!docs/handover.md`.
   - `bin` paths without a leading `./`. With one, npm warns "script name … was invalid and removed", though it only drops the `./`.
   - `prepublishOnly`: `bun run check && bun test && bun run build`. It runs on `bun publish` and `npm stage publish`.
3. **Make the repo public** before the first publish. If it's private, the npm page's links 404.
4. **Tag and push.** Then make a worktree at the tag, so the package matches the tag even when `main` has moved on:

   ```bash
   git worktree add ../pkg-0.1.0 v0.1.0 && cd ../pkg-0.1.0 && bun install
   ```

5. **Check what ships.** Read the file list for anything private.

   ```bash
   bun publish --dry-run
   ```

6. **Publish by hand.** The first version has to be manual, because trusted publishing is configured on a package page that doesn't exist yet.

   ```bash
   bunx npm login
   bun publish --auth-type legacy
   ```

   It asks for a one-time code in the terminal, or gives a link for a security key.

7. **Wait.** See [the first publish](#the-first-publish).
8. **Check a clean install** in an empty folder. `--no-cache` matters: Bun can hold on to the placeholder.

   ```bash
   bun add @scope/name --no-cache
   ```

9. **Add the workflow,** `.github/workflows/publish.yml`, and push it. npm says the file must exist before the next step.
10. **Add the trusted publisher** when a release is ready. See [the settings](#trusted-publisher).
11. **Release through the workflow,** and approve it within 2 days.
12. **Lock it down** after one release has gone through: package Settings → Publishing access → "Require two-factor authentication and disallow tokens".

## The first publish

`bun publish` printed `+ @khalido/home@0.1.0`, but the package wasn't installable for several minutes:

| When                     | npm showed                                                                          |
| :----------------------- | :---------------------------------------------------------------------------------- |
| Just after the upload    | The page shows `0.0.0-stage`, "Temporary Holding Version"; the registry answers 404 |
| About 5 minutes later    | 0.1.0 is `latest`; `npm view` works; the tarball is still 404                       |
| A few minutes after that | The tarball downloads; `bun add` works                                              |

I didn't have to approve anything. `npm stage list` stayed empty throughout. The placeholder stays in the version list for good.

Don't run `bun add` until the tarball answers 200:

```bash
curl -sI https://registry.npmjs.org/@scope/name/-/name-0.1.0.tgz | head -1
```

## Trusted publisher

No token to create or store. GitHub issues a short-lived one on each run, because the workflow has `id-token: write`. Provenance is automatic for a public repo and package.

On npmjs.com → the package → Settings → Trusted Publisher:

| Field                | Value          |
| :------------------- | :------------- |
| Publisher            | GitHub Actions |
| Organization or user | `khalido`      |
| Repository           | `home.ts`      |
| Workflow filename    | `publish.yml`  |
| Environment name     | blank          |
| Allow `npm publish`  | off            |
| Allow `npm dist-tag` | off            |

- **Stage-only.** With both boxes off, the workflow can only stage. A version needs my 2FA to go live, so someone who gets into the GitHub account or the workflow can't ship one alone.
- **2 days.** A new publisher must complete a first publish within 2 days or it expires. npm doesn't say whether staging alone counts, so approve within the 2 days. To fix an expired one, delete it and create it again.
- **Fixed fields.** To change the provider, repo or filename, delete the connection and create a new one.

For home.ts this is still to do when 0.1.1 is ready, and the workflow hasn't run yet.

## The workflow

`publish.yml` runs when a GitHub release is published. Releases made with `gh` as me trigger it. Ones made by a workflow's `GITHUB_TOKEN` don't.

- Set up Bun first, because `npm stage publish` runs `prepublishOnly`.
- Use `npm`, not `bun publish`, for this step. Bun has no OIDC, provenance or staging.
- Use Node 26, which ships npm 11.20. Staging needs npm 11.15 and Node 22.14 or later.
- The job checks the tag against `package.json`.

To approve, use Staged Packages on npmjs.com, or:

```bash
npm stage list @khalido/home
```

```bash
npm stage approve <stage-id>
```

If the run fails on auth, fix the publisher and run `gh run rerun <id>`. If it fails on the code, fix it and release a new patch version, because a rerun builds the same tag.

## Versions

- A published number can never be reused, even after an unpublish. A mistake is the next patch.
- `bun add @khalido/home` takes `latest` and saves `^0.1.0`. No need to name a version.
- At 0.x the caret stays inside the minor: `^0.1.0` takes 0.1.2, never 0.2.0. A consumer moves up with `bun add @khalido/home@latest`.
- A `minimumReleaseAge` in a consumer's `bunfig.toml` hides a fresh version until it's that old.

## If it goes wrong

| What you see                                                | What it means                                                      |
| :---------------------------------------------------------- | :----------------------------------------------------------------- |
| 403, "Two-factor authentication … is required"              | 2FA is off on the account                                          |
| "You cannot publish over the previously published versions" | That version exists. Bump it                                       |
| `bun add` installs `0.0.0-stage`                            | npm is still processing, or Bun's cache is stale. Use `--no-cache` |
| "No version matching … (but package exists)"                | Same                                                               |
| Tarball 404 while `npm view` works                          | Still processing. Wait a few minutes                               |
| `E_STAGE_REQUIRED`                                          | The credential can only stage. Use `npm stage publish`             |

## Tokens, if ever needed

Trusted publishing replaces them. For reference (read 2026-10-13):

- npm removed classic tokens in late 2025. [Granular tokens](https://docs.npmjs.com/about-access-tokens) last at most 90 days for writes, and direct publishing with them is due to end in January 2027.
- `npm login` gives a two-hour session token.
- If I ever need one: stage-only, limited to the package, bypass 2FA off, 90 days, kept in `~/.npmrc` as `${NPM_TOKEN}` from the Keychain, never in a repo.

## Sources

[Trusted publishing](https://docs.npmjs.com/trusted-publishers), [staged publishing](https://docs.npmjs.com/staged-publishing), [`bun publish`](https://bun.com/docs/pm/cli/publish), [new packages can be staged](https://github.blog/changelog/2026-10-02-npm-staged-publishing-now-supports-creating-new-packages).
