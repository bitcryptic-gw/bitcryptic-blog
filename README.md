# bitcryptic-blog

The Astro app behind [blog.bitcryptic.com](https://blog.bitcryptic.com) — and, since
2026-11-21, the one **site image** that also serves markdownfirst.com. Posts and pages
live in a separate repo per site, mounted into the container as a git clone at
`/app/src/content/blog`.

Two sites, one image, no fork. What differs between them is the content repo and its
`site.json`; everything hardened here — publish-on-merge, validation before publish,
markdown negotiation, real 404s, free-only MDF, `/llms.txt`, tini and the git reaping
fix, fetch alerting, the timing-safe deploy hook — is shared.

## One image, more than one site

### `site.json`, in the root of the content repo

Optional, and a **missing file means exactly blog.bitcryptic.com**, field for field, so
the blog kept working while its content repo caught up. It holds only what differs
between sites:

| field | what it sets |
| --- | --- |
| `name`, `shortName`, `titleTemplate` | document titles, `og:site_name`, `/llms.txt` heading |
| `origin` | the canonical origin: `<link rel="canonical">`, sitemap, feed, `/mdf.json` |
| `theme` | one of the themes bundled in the image (`blog`, `markdownfirst`) |
| `content` | `{ "posts": true/false, "pages": true/false }` |
| `nav` | `label`, `path` (`/…`, `#…` or `https://…`), `order`, optional `style: button` |
| `description` | the default meta description |
| `umami` | `{ "websiteId", "scriptUrl" }`, or `null` to load no analytics |
| `footer` | the two footer spans |
| `mdf` | `/mdf.json` name and contact |
| `llms` | `/llms.txt` description, intro lines, site links (`{origin}` is substituted), topics |
| `notFound` | the 404 wording, in HTML and in markdown |

Infrastructure stays in environment variables and file mounts, never in the content
repo: `BLOG_MODE`, `CONTENT_DIR`, `SYNC_STATUS_FILE`, the secret files.

Validation is strict — **an unknown key is an error**, because a typo that is silently
ignored is a config change that silently does nothing — and a bad `site.json` is held
back by the sync loop exactly like a bad post. `mdf.pricing` is refused outright: this
image serves free-only MDF 0.3.1 by design.

### Pages, in `pages/`

Undated markdown files, next to the posts (which stay at the repo root):

```
pages/index.md          slug ""      ->  /
pages/how-it-works.md   slug how-it-works ->  /how-it-works/
```

Frontmatter: `title`, `slug`, `description`, `order`, an optional `nav` label, an
optional `layout`, and `status`. Pages never appear in the feed. Every page
**negotiates**: its markdown body is what an agent gets at the same URL, which is why a
page on a custom layout still needs a real body — the validator refuses a placeholder.
The sitemap and `/llms.txt` list pages and posts.

### Themes, in `src/themes/`

`blog` is the default and is the blog as it has always looked. `markdownfirst` is
direction E: graph paper, hand-drawn boxes, self-hosted Gaegu and Nunito, a `home`
layout for the designed home page and a plain `page` layout for everything else.

A theme supplies `Base.astro`, `Post.astro`, `NotFound.astro`, `Index.astro` (a post
index) and a `.astro` file per entry in its `pageLayouts` (`Page.astro`, `Home.astro`).
Adding a theme means adding the directory, a line in `src/lib/themes.mjs`, and one
branch in each of `src/site/*.astro`.

The markdownfirst theme adds **no dependencies**: its fonts (Gaegu and Nunito, latin
subsets, woff2, SIL OFL 1.1 with the licence text alongside) are vendored into
`src/themes/markdownfirst/fonts/`, because Gary's standing preference is that a site
serve its own fonts rather than call a Google Fonts CDN — and vendoring five files is
lighter than a package that ships ten megabytes of subsets nobody loads. The
illustrations are inline SVG in the theme, the layout is plain CSS, and the home page's
copy is content, not code.

Those `src/site/*.astro` dispatchers are literal `{condition ? <A/> : <B/>}` branches on
purpose: Astro works out a route's stylesheets at build time by walking the components
the route statically renders. Choose a component through a variable and it falls back to
one merged stylesheet, which changes the blog's `<link>` tags — and the blog's HTML is
checked byte for byte by `tests/byte-identity.test.mjs`.

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
every route, and by CI. `validateCheckout(dir)` checks `site.json`, the posts and
`pages/` together; `validateContent()` is the post-only half.

- `site.json` parses and validates (see the table above), if there is one;
- frontmatter parses at all (a `---` file that yields no keys is a failure);
- `title`, `slug`, `date`, `description`, `status` present and typed;
- `date` parses; `status` is `draft` or `published`;
- `slug` is URL-safe and unique across the directory;
- `superseded_by`, if set, names an existing **published** slug;
- the file name matches the slug (`a-post.md` ↔ `a-post`). Legacy file names are
  allow-listed in `LEGACY_FILE_STEMS`; new posts must match.
- pages: the same shape minus `date`, `layout` must be one a theme actually has, the
  slug is not a reserved route, and a page on a custom layout carries a real body;
- files with no frontmatter (the content repo's own `README.md`) are ignored, not
  failed.

```
node --test tests/*.test.mjs        # the test suite
node scripts/validate-content.mjs <dir> [--strict-names]
```

Exit code 0 = publishable, 1 = errors, 2 = the directory could not be read.

## Serving markdown to agents (MDF)

The blog is an MDF (Markdown First) site, free tier only. A browser gets HTML;
an agent that asks for markdown gets markdown at the same URL:

```sh
curl -H 'Accept: text/markdown' https://blog.bitcryptic.com/blog/mdf-0-3-whats-changed/
```

- **The rule** (`src/lib/negotiate.js`): markdown is served only when
  `text/markdown` is listed explicitly with `q > 0` and its `q` is at least the
  `q` of `text/html`. `*/*`, `text/*`, a missing `Accept` and markdown at `q=0`
  all get HTML.
- **Routes that negotiate:** `/`, `/blog/<slug>/` (published posts only), and
  every 404. RSS, the sitemap and `/api/*` do not.
- **Markdown body:** YAML frontmatter, `# Title`, the superseded banner as a
  blockquote when there is one, then the post as stored — corrections stay as
  `~~old~~ new`. Only site-relative link targets are rewritten to absolute URLs.
- **Headers:** `Content-Type: text/markdown; charset=utf-8`, `Vary: Accept`,
  `Link: <html-url>; rel="canonical"`, `X-MDF-Version: 1`, and an `ETag` computed
  from the bytes served. HTML on the same routes carries `Vary: Accept`,
  `X-MDF-Version` and its own ETag, so one representation's tag can never 304
  the other. `HEAD` mirrors `GET`.
- **Logging:** one line per markdown response on stdout
  (`[mdf] <iso> path=<path> status=<n> ua="<first 200 chars>"`). No IPs, no
  query strings.
- **Discovery:** `/llms.txt` and `/mdf.json` are runtime routes built from the
  published posts. `/mdf.json` is a free-only MDF 0.3.1 capability document:
  `pricing.default.rails` is empty, there are no priced sections and no auth
  endpoint.

A missing or draft slug is a real **404 at its own URL** — no redirect to
`/404` — with the not-found page as HTML or a short markdown "Not found" when
markdown was negotiated.

Validate a running instance (or the live site) with
[`mdf-validator`](https://github.com/bitcryptic-gw/mdf-validator):

```sh
mdf-validate --check-headers https://blog.bitcryptic.com
```

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
  "last_alerted_sha": null,
  "interval_seconds": 60,
  "consecutive_failures": 0,
  "failing_since": null,
  "last_error": null,
  "last_alert_at": null,
  "alert_streak": false,
  "child_processes": 0
}
```

`503 {"status":"unknown"}` before the loop has written one. Healthy means
`last_checked` is recent, `last_result` is `no-change` or `updated`, and
`consecutive_failures` is 0; a monitor should also alarm on `rejected` or
`error`, and on `child_processes` above 0 (see below).

The alerting fields (`consecutive_failures`, `failing_since`, `last_error`,
`last_alert_at`, `alert_streak`) are the persisted state of the fetch-failure
alerting rule, so you can read them to see whether the loop is having a blip or
a real outage. `last_error` is git's stderr, trimmed to 500 characters, with any
userinfo stripped from URL-like text.

### `child_processes`

The number of children the sync process still has — live or zombie — sampled
after each cycle. It should be **0**. A zombie is invisible to `docker top` and
to `cgroup.procs` but still counts against the container's `pids.max`, so this
field (and `/sys/fs/cgroup/pids.current`) is how a leak is caught before
`fork()` starts failing with EAGAIN. Web Hosting #65 was exactly that: about
2,000 zombies — git's detached post-fetch maintenance, reparented to a node
process that was PID 1 — filled a 2,048-pid budget. `null` where `/proc` is
unavailable (e.g. a macOS dev machine).

### Alerts

- **Validation rejection:** one alert per bad SHA, as before.
- **Operational failure** (fetch, staging, reset, dirty clone): nothing for the
  first two in a row, one alert on the third, then at most one reminder an hour
  while it keeps failing, and one recovery notice when a fetch succeeds again.
  The state lives in the status file, so restarting the container neither
  re-alerts nor forgets a streak.

## Containers and modes

Two containers, **one image**, both mounting the same content clone. The image
decides what it is from **`BLOG_MODE`** — never from a template command field.
Both modes run under `tini` as PID 1 (see `scripts/start.sh`), so a git child
that outlives its parent is reaped instead of becoming a permanent zombie.

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
`origin`/`main`), `SYNC_INTERVAL_SECONDS` (60), `SYNC_GIT_TIMEOUT_MS` (60000,
the per-git-call timeout), `SYNC_STATUS_FILE`, `NTFY_URL`
(full topic URL) and `NTFY_TOKEN_FILE`. **No secret is ever logged**, and the
loop refuses to start if a configured secret file is missing or empty.

## Tests

```sh
npm test                                   # unit + HTTP tests, incl. the leak probes

# in-image: mode selection, and the hook/status routes with a real clone mounted
docker run --rm --platform linux/amd64 <image> sh tests/modes.test.sh
docker run --rm --platform linux/amd64 \
  -v <content-clone>:/app/src/content/blog -v <status-dir>:/app/data \
  <image> sh tests/hook.test.sh
```

`tests/zombie-leak.test.mjs` drives 200 real sync cycles and 200 `/api/deploy`
requests, mixing successes, rejecting merges, fetch failures and forced
timeouts (`tests/helpers/fake-git` hangs on `fetch` while a marker file
exists), then asserts the process that did the work has no children left — live
or zombie.

### Running the leak probes

`npm test` covers the direct-child paths. Two shapes matter beyond that, and
both are one command in the image:

```sh
# the probe itself as PID 1, i.e. the shape of a node process with no init:
docker run --rm --platform linux/amd64 --entrypoint node <image> \
  tests/helpers/zombie-probe.mjs

# the production shape, tini as PID 1 reaping anything git daemonises:
docker run --rm --platform linux/amd64 --entrypoint tini <image> -g -- \
  node tests/helpers/zombie-probe.mjs
```

Both print one JSON line; `childrenAtEnd`, `zombiesAtEnd` and
`orphanZombiesDelta` must all be 0, and `--clean` (only cycles that can succeed)
is the shape to look at. The second is the one that matters: it is how the
container actually runs. `orphanZombiesDelta` counts zombies reparented to PID 1,
so it is only meaningful when that PID 1 is an init — in the first shape they
are the probe's own children, in the second tini reaps them.

The pre-#65 image fails both: 60 leftover `git` children after 60 cycles with no
init, and one zombie per successful fetch at PID 1. Append `/api/deploy`'s
equivalent with `tests/helpers/deploy-zombie-probe.mjs` (it needs `dist/`, so use
the image).

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
- A dirty live content clone is **never** reset over: the loop alerts (after
  three consecutive cycles) and skips until it is clean.

## Known gaps

- Branch protection on the content repo is not yet enabled; merges are currently
  not enforced as the approval step (tracked in Web Hosting Fleet #63, with the
  bot-identity proposal).
