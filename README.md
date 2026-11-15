# bitcryptic-blog

The Astro app behind [blog.bitcryptic.com](https://blog.bitcryptic.com). Posts live
in a separate repo, [`bitcryptic-blog-content`](https://github.com/bitcryptic-gw/bitcryptic-blog-content),
which is **public** and is mounted into the container as a git clone at
`/app/src/content/blog`.

## Publishing: merge, and it is live within a minute

**Merging to `main` in the content repo is the only approval step.** Nothing pushes
to the server, there is no webhook, no token and no terminal step.

```
content repo main  ──fetch──▶  sync container ──validate──▶  live clone ──▶  Astro
                                    (60s loop)
```

The sync container (`scripts/sync.mjs`, same image, different command) fetches
`origin/main` every 60 s over anonymous HTTPS — the content repo is public, so
there is no key to hold. When `main` moves it checks the new commit out into a
staging worktree, runs `scripts/validate-content.mjs` there, and only then
`git reset --hard`s the live clone. **A commit that fails validation is never
published**: the live content stays where it was and one ntfy alert names the
files and the errors.

The website is resilient independently of that: `/`, `/blog/[slug]`, `/rss.xml`
and `/sitemap.xml` all skip and log a post that fails validation, so a bad file
can never 500 the site even if it somehow reaches the clone.

### What the validator enforces

`scripts/validate-content.mjs` — one implementation, used by the sync loop, by
every route, and by CI.

- frontmatter parses at all (a `---` file that yields no keys is a failure);
- `title`, `slug`, `date`, `description`, `status` present and typed;
- `date` parses; `status` is `draft` or `published`;
- `slug` is URL-safe and unique across the directory;
- `superseded_by`, if set, names an existing **published** slug;
- the file name matches the slug (`a-post.md` ↔ `a-post`). Legacy file names are
  allow-listed in `LEGACY_FILE_STEMS`; new posts must match.
- files with no frontmatter (the content repo's own `README.md`) are ignored, not
  failed.

```
node --test tests/*.test.mjs        # the test suite
node scripts/validate-content.mjs <dir> [--strict-names]
```

Exit code 0 = publishable, 1 = errors, 2 = the directory could not be read.

## The manual hook: `POST /api/deploy`

The sync loop is the normal path. The hook exists for "I want it now".

- **Tailnet only.** Caddy on `caddy-linode` serves `blog.bitcryptic.com` and
  blocks `/api/*` before it proxies to the container, so the hook is unreachable
  from the internet. Call it from a tailnet device against the container's
  tailnet address, not the public hostname.
- **Auth:** `Authorization: Bearer <secret>`, where the secret is read from the
  file named by `DEPLOY_SECRET_FILE`. It is never read from the environment —
  an env var would be visible in `docker inspect`.
- The secret is compared with `crypto.timingSafeEqual` after a length check, the
  request body is limited to 1 KiB, and the work it does is exactly the sync
  loop's validate-then-reset path.
- If `DEPLOY_SECRET_FILE` is set but the file is missing or empty, the container
  **refuses to start** (`scripts/check-secrets.mjs` runs first in the container
  command).

```sh
# from a tailnet device, never from the public internet
curl -sS -X POST \
  -H "Authorization: Bearer $(cat ~/.config/bitcryptic-blog/deploy-secret)" \
  http://bitcryptic-blog-syd.pygmy-bramble.ts.net:4321/api/deploy
```

Response: `{"status":"ok","action":"updated|no-change|rejected","from":"<sha>","to":"<sha>"}`.
`rejected` means the commit failed validation and live content was left alone;
`500` is returned for `error`/`rejected` so a scripted caller notices.

## Sync status: `GET /api/sync-status`

Read-only JSON, also tailnet-only by the same proxy rule, for Kuma:

```json
{
  "status": "ok",
  "last_checked": "2026-11-15T19:00:04.212Z",
  "live_sha": "d8e561d…",
  "target_sha": "d8e561d…",
  "last_result": "updated",
  "message": "published d8e561d…",
  "errors": [],
  "interval_seconds": 60
}
```

`503 {"status":"unknown"}` before the loop has written one. Healthy means
`last_checked` is recent and `last_result` is `no-change` or `updated`; a monitor
should also alarm on `rejected` or `error`.

## Containers and modes

Two containers, **one image**, both mounting the same content clone. The image
decides what it is from **`BLOG_MODE`** — never from a template command field.

| | web | sync |
|---|---|---|
| image | `bitcryptic/blog:<tag>` | same tag |
| image command | *(default — leave Command and Post Arguments EMPTY)* | same |
| `BLOG_MODE` | `web` (or unset) | `sync` |
| port | 4321 | none |
| content mount | content clone → `/app/src/content/blog` | same clone, same path |
| status mount | shared dir → `/app/data` | same |
| secrets | `DEPLOY_SECRET_FILE=/run/secrets/deploy_secret` | `NTFY_TOKEN_FILE` (if the topic needs one) |

### Why mode lives in the image, not in the template

The Unraid Tailscale hook runs the image's **ENTRYPOINT + the image's own CMD +
the template's Post Arguments**, as plain argv with **no shell**. It ignores the
template's Command field completely, so a command written there does nothing —
and if it is put in Post Arguments it is *appended as arguments* to the default
command, which is worse than nothing (it once turned a sync container into a
second web server).

So the image ships `scripts/start.sh` as its CMD, and that script switches on
`BLOG_MODE`:

```
BLOG_MODE=web   (default)  secrets check, then exec node ./dist/server/entry.mjs
BLOG_MODE=sync             secrets check, then exec node scripts/sync.mjs
anything else              exit 2 with a message — never falls back to web
```

Extra argv is ignored and reported. `exec` keeps node as PID 1, so `docker stop`
signals the right process.

**Leave the Unraid Command and Post Arguments fields empty for both containers.**

### Failing closed

Three layers, all keyed on environment variables only:

1. `scripts/start.sh` checks the secrets the selected mode uses, before starting.
2. The image sets `NODE_OPTIONS=--import=/app/scripts/assert-secrets.mjs`, so
   *any* node process in the container — including a hand-run
   `node dist/server/entry.mjs` — exits non-zero if `DEPLOY_SECRET_FILE` or
   `NTFY_TOKEN_FILE` is set but missing, unreadable or empty.
3. If `DEPLOY_SECRET_FILE` is **unset**, the site serves normally and
   `/api/deploy` is disabled: it answers **503** with
   "manual sync hook is not configured" (not 404 — the route exists, the feature
   is off).

### Pulling a new image

Templates **pin an explicit tag** (`bitcryptic/blog:2026-11-16`). Changing that
tag in the template and hitting Apply is what pulls a new image; a template that
points at `:latest` with Apply does not necessarily re-pull, and it also lets a
rollout happen without anyone choosing it. Bump the tag deliberately, keep both
containers on the same tag, and keep `:latest` pointing at the same digest for
findability.

Once applied, confirm each container's mode from the host:

```sh
docker exec bitcryptic-blog      ps -o pid,args   # node ./dist/server/entry.mjs
docker exec bitcryptic-blog-sync ps -o pid,args   # node scripts/sync.mjs
```

The sync container writes `/app/data/sync-status.json`; the web container reads
it for `/api/sync-status`. That directory must be shared between them.

Environment for the sync container: `BLOG_MODE=sync` plus `CONTENT_DIR`
(default `/app/src/content/blog`), `SYNC_REMOTE`/`SYNC_BRANCH` (default
`origin`/`main`), `SYNC_INTERVAL_SECONDS` (60), `SYNC_STATUS_FILE`, `NTFY_URL`
(full topic URL) and `NTFY_TOKEN_FILE`. **No secret is ever logged**, and the
loop refuses to start if a configured secret file is missing or empty.

## Tests

```sh
npm test                                   # 26 unit tests: validator, loader, sync decisions, secrets

# in-image: mode selection, and the hook/status routes with a real clone mounted
docker run --rm --platform linux/amd64 <image> sh tests/modes.test.sh
docker run --rm --platform linux/amd64 \
  -v <content-clone>:/app/src/content/blog -v <status-dir>:/app/data \
  <image> sh tests/hook.test.sh
```

`tests/modes.test.sh` starts each mode and reads `/proc/<pid>/cmdline` to prove
which process was selected, including with a stray argv appended (the shape the
Unraid Post Arguments field produces), and proves a bad secret stops the
container before it listens.

## Rollback

- Content: revert the merge in the content repo and push. The sync loop picks it
  up within a minute (a force-push/rewind is applied and logged as
  non-fast-forward).
- App: redeploy the previous image tag. Tags are dated (`:2026-11-15`); the
  previous `latest` digest is recorded in the libby record for each release.
- A dirty live content clone is **never** reset over: the loop alerts and skips
  until it is clean.

## Known gaps

- Branch protection on the content repo is not yet enabled; merges are currently
  not enforced as the approval step (tracked in Web Hosting Fleet #63, with the
  bot-identity proposal).
- `bc-gold` / `bc-gold-dim` are used in the templates but are not defined in
  `tailwind.config.mjs`, so those classes render unstyled.
