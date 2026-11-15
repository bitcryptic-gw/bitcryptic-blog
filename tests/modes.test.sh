#!/bin/sh
# Mode-selection tests. These run INSIDE the built image, against the real
# entrypoint, because the thing under test is how the image behaves when a
# template/hook invokes it:
#
#   docker run --rm --platform linux/amd64 bitcryptic/blog:<tag> sh tests/modes.test.sh
#
# It covers the Unraid Tailscale hook's actual invocation shape: the image
# ENTRYPOINT (docker-entrypoint.sh) + the image CMD (sh scripts/start.sh) + any
# appended argv. No shell is involved in the hook, so nothing here may rely on
# one either.
set -u

fail=0
pass() { echo "PASS  $1"; }
bad()  { echo "FAIL  $1"; fail=$((fail + 1)); }

# argv of a backgrounded start.sh child, read from /proc (busybox ps -o is not
# reliable in Alpine). exec keeps the PID, so this shows the final process.
argv_of() {
  pid=$1
  sleep 2
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null
}

# Start a mode in the background; leave the process running for the caller.
start_bg() {
  sh scripts/start.sh "$@" >/tmp/mode.log 2>&1 &
  echo $!
}

# --- 1. default (BLOG_MODE unset) is web -------------------------------------
pid=$(start_bg)
args=$(argv_of "$pid")
kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
case "$args" in
  *dist/server/entry.mjs*) pass "default mode runs the web server" ;;
  *) bad "default mode runs the web server (got: $args)" ;;
esac

# --- 2. BLOG_MODE=web, with a stray appended argv ---------------------------
# This is the shape the Unraid Post Arguments field produces.
BLOG_MODE=web sh scripts/start.sh node scripts/check-secrets.mjs >/tmp/web.log 2>&1 &
pid=$!
args=$(argv_of "$pid")
kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
case "$args" in
  *dist/server/entry.mjs*) pass "web mode ignores an appended argv" ;;
  *) bad "web mode ignores an appended argv (got: $args)" ;;
esac
grep -q 'ignoring extra arguments' /tmp/web.log && pass "stray argv is reported, not silently dropped" \
  || bad "stray argv is reported, not silently dropped"

# --- 3. BLOG_MODE=sync runs the loop, not the server ------------------------
BLOG_MODE=sync sh scripts/start.sh >/tmp/sync.log 2>&1 &
pid=$!
args=$(argv_of "$pid")
kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
case "$args" in
  *scripts/sync.mjs*) pass "sync mode runs sync.mjs" ;;
  *) bad "sync mode runs sync.mjs (got: $args)" ;;
esac
case "$args" in
  *dist/server/entry.mjs*) bad "sync mode must not start a web server" ;;
  *) pass "sync mode does not start a web server" ;;
esac

# --- 4. sync mode also ignores a stray argv --------------------------------
BLOG_MODE=sync sh scripts/start.sh extra-argument >/tmp/sync2.log 2>&1 &
pid=$!
args=$(argv_of "$pid")
kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
case "$args" in
  *scripts/sync.mjs*) pass "sync mode ignores an appended argv" ;;
  *) bad "sync mode ignores an appended argv (got: $args)" ;;
esac

# --- 5. unknown mode exits non-zero and never falls back to web ------------
out=$(BLOG_MODE=bogus timeout 15 sh scripts/start.sh 2>&1)
rc=$?
[ "$rc" -ne 0 ] && pass "unknown mode exits non-zero (rc=$rc)" || bad "unknown mode exits non-zero (rc=$rc)"
echo "$out" | grep -q 'unknown BLOG_MODE' && pass "unknown mode explains itself" || bad "unknown mode explains itself"
echo "$out" | grep -q 'dist/server/entry.mjs' && bad "unknown mode fell back to the web server" || pass "unknown mode does not fall back to web"

# --- 6. web mode with a configured-but-missing secret fails closed ---------
out=$(BLOG_MODE=web DEPLOY_SECRET_FILE=/tmp/this-file-does-not-exist timeout 15 sh scripts/start.sh 2>&1)
rc=$?
[ "$rc" -ne 0 ] && pass "missing secret file exits non-zero (rc=$rc)" || bad "missing secret file exits non-zero (rc=$rc)"
echo "$out" | grep -q 'Server listening' && bad "server listened despite a bad secret" || pass "server never listened with a bad secret"
echo "$out" | grep -q 'refusing to start' && pass "missing secret file says why" || bad "missing secret file says why"

# --- 6b. same, but starting the server directly (belt and braces) ----------
out=$(DEPLOY_SECRET_FILE=/tmp/this-file-does-not-exist timeout 15 node ./dist/server/entry.mjs 2>&1)
rc=$?
[ "$rc" -ne 0 ] && pass "direct entry.mjs exits non-zero on a bad secret (rc=$rc)" || bad "direct entry.mjs exits non-zero on a bad secret (rc=$rc)"
echo "$out" | grep -q 'Server listening' && bad "direct entry.mjs listened despite a bad secret" || pass "direct entry.mjs never listened with a bad secret"

# --- 7. web mode with no secret configured serves the site, hook disabled --
sh scripts/start.sh >/tmp/serve.log 2>&1 &
pid=$!
up=0
i=0
while [ "$i" -lt 30 ]; do
  if wget -q -O /tmp/index.html "http://127.0.0.1:${PORT:-4321}/" 2>/dev/null; then up=1; break; fi
  sleep 1
  i=$((i + 1))
done
if [ "$up" -eq 1 ]; then pass "web mode serves with no secret configured"; else bad "web mode serves with no secret configured"; fi
# busybox wget discards the body on a non-2xx, so ask node for status + body.
hook=$(node -e "fetch('http://127.0.0.1:${PORT:-4321}/api/deploy',{method:'POST'}).then(async r=>console.log(r.status, await r.text()))" 2>/dev/null)
case "$hook" in
  503*) pass "hook is disabled (503) when no secret is configured" ;;
  *) bad "hook is disabled (503) when no secret is configured (got: $hook)" ;;
esac
case "$hook" in
  *'not configured'*) pass "disabled hook says it is not configured" ;;
  *) bad "disabled hook says it is not configured (got: $hook)" ;;
esac
kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null

echo
if [ "$fail" -eq 0 ]; then echo "ALL MODE TESTS PASSED"; exit 0; else echo "$fail MODE TEST(S) FAILED"; exit 1; fi
