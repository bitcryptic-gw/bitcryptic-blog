#!/bin/sh
# Container entrypoint.
#
# Why this exists: the Unraid Tailscale hook runs the image's ENTRYPOINT + the
# image's *own* CMD + the template's Post Arguments, as plain argv with no
# shell, and it ignores the template's Command field entirely. A template-level
# command override therefore either does nothing or (worse) gets appended as
# arguments to the default command. So everything that decides what this
# container does has to live in the image and hang off environment variables.
#
#   BLOG_MODE=web   (default) validate the deploy-hook secret, then run the site
#   BLOG_MODE=sync            validate the sync secrets, then run the sync loop
#
# Any other value is a hard failure. There is no fallback to web: a container
# that was meant to sync must never quietly serve instead.
#
# Extra argv is ignored on purpose. The Unraid template's Post Arguments field
# ends up here, and a stray argument must not be able to change the mode.
set -eu

MODE="${BLOG_MODE:-web}"

if [ "$#" -gt 0 ]; then
  echo "[start] ignoring extra arguments: $*" >&2
fi

case "$MODE" in
  web|sync) ;;
  *)
    echo "[start] FATAL: unknown BLOG_MODE='$MODE' — expected 'web' or 'sync'; refusing to start" >&2
    exit 2
    ;;
esac

echo "[start] mode=$MODE"

# Exits non-zero if a secret this mode uses is configured but missing, unreadable
# or empty. Never prints a secret value.
node scripts/check-secrets.mjs "$MODE"

# tini, not node, is PID 1.
#
# Web Hosting #65: git daemonises some of its work (post-fetch maintenance) and,
# on a failed fetch, exits while its transport helper is still finishing. Node
# cannot reap a child it did not spawn, so as PID 1 it accumulated those as
# zombies charged to the container's pids.max until fork() failed. tini reaps
# them. `-g` also forwards SIGTERM to the process group, so a hung git dies with
# the container instead of keeping node waiting for its timeout.
#
# scripts/sync.mjs separately stops git from forking the maintenance daemon at
# all; both layers are deliberate.
case "$MODE" in
  web)  exec tini -g -- node ./dist/server/entry.mjs ;;
  sync) exec tini -g -- node scripts/sync.mjs ;;
esac
