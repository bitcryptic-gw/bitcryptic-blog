#!/bin/sh
# Hook + status tests, run INSIDE the image with a real content clone and a
# shared status dir mounted (so /api/deploy and /api/sync-status exercise the
# real code paths):
#
#   docker run --rm --platform linux/amd64 \
#     -v <content-clone>:/app/src/content/blog \
#     -v <status-dir>:/app/data \
#     bitcryptic/blog:<tag> sh tests/hook.test.sh
set -u

fail=0
pass() { echo "PASS  $1"; }
bad()  { echo "FAIL  $1"; fail=$((fail + 1)); }
port="${PORT:-4321}"
base="http://127.0.0.1:$port"

# A throwaway secret for this test only; never a real one.
secret=$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')
printf '%s\n' "$secret" > /tmp/hook-secret

post() {
  node -e "fetch('$base/api/deploy',{method:'POST',headers:$1}).then(async r=>console.log(r.status, await r.text()))" 2>/dev/null
}

BLOG_MODE=web DEPLOY_SECRET_FILE=/tmp/hook-secret sh scripts/start.sh >/tmp/hook.log 2>&1 &
pid=$!
up=0
i=0
while [ "$i" -lt 30 ]; do
  if wget -q -O /dev/null "$base/" 2>/dev/null; then up=1; break; fi
  sleep 1
  i=$((i + 1))
done
[ "$up" -eq 1 ] && pass "site serves with a valid secret configured" || bad "site serves with a valid secret configured"

out=$(post '{}')
case "$out" in
  401*) pass "hook rejects a request with no bearer token" ;;
  *) bad "hook rejects a request with no bearer token (got: $out)" ;;
esac

out=$(post '{"authorization":"Bearer wrong-value"}')
case "$out" in
  401*) pass "hook rejects a wrong bearer token" ;;
  *) bad "hook rejects a wrong bearer token (got: $out)" ;;
esac

out=$(post "{\"authorization\":\"Bearer $secret\"}")
case "$out" in
  200*) pass "hook accepts the correct bearer token" ;;
  *) bad "hook accepts the correct bearer token (got: $out)" ;;
esac
case "$out" in
  *no-change*|*updated*) pass "hook reports the sync result" ;;
  *) bad "hook reports the sync result (got: $out)" ;;
esac

# The sync loop writes this file; here it is whatever the caller mounted.
status=$(node -e "fetch('$base/api/sync-status').then(async r=>console.log(r.status, await r.text()))" 2>/dev/null)
case "$status" in
  200*) pass "/api/sync-status serves the shared status file" ;;
  *) bad "/api/sync-status serves the shared status file (got: $status)" ;;
esac

kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
unset secret

echo
if [ "$fail" -eq 0 ]; then echo "ALL HOOK TESTS PASSED"; exit 0; else echo "$fail HOOK TEST(S) FAILED"; exit 1; fi
