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

## Containers

Two containers, **one image**, both mounting the same content clone.

| | web | sync |
|---|---|---|
| image | `bitcryptic/blog:<tag>` | same tag |
| command | `node scripts/check-secrets.mjs && node ./dist/server/entry.mjs` | `node scripts/sync.mjs` |
| port | 4321 | none |
| content mount | content clone → `/app/src/content/blog` | same clone, same path |
| status mount | shared dir → `/app/data` | same |
| secrets | `DEPLOY_SECRET_FILE=/run/secrets/deploy_secret` | `NTFY_TOKEN_FILE` (if the topic needs one) |

The sync container writes `/app/data/sync-status.json`; the web container reads
it for `/api/sync-status`. That directory must be shared between them.

Environment for the sync container: `CONTENT_DIR` (default
`/app/src/content/blog`), `SYNC_REMOTE`/`SYNC_BRANCH` (default `origin`/`main`),
`SYNC_INTERVAL_SECONDS` (60), `SYNC_STATUS_FILE`, `NTFY_URL` (full topic URL) and
`NTFY_TOKEN_FILE`. **No secret is ever logged**, and the loop refuses to start if
a configured secret file is missing or empty.

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
