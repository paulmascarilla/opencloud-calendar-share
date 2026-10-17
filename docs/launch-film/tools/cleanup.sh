#!/usr/bin/env bash
# Removes the launch-film demo data created by tools/seed.sh (calendars, shares, invitations, users).
set -uo pipefail
OC=${OC:-https://localhost:9200}; NS=${NS:-opencloud}
HERE=$(cd "$(dirname "$0")" && pwd); TOKENS=$HERE/tokens.env
source <(sed 's/=\(.*\)/="\1"/' "$TOKENS")
oc() { kubectl -n "$NS" exec deploy/opencloud -c opencloud -- "$@"; }
ADMIN="admin:$(oc sh -c "opencloud auth-app create --user-name=admin --expiration=1h 2>/dev/null | sed -n 's/.*token: //p'")"
for u in camille noah ines; do
  t="$u"; idv="${u}_id"; id="${!idv}"
  # shares this user owns, then their collections (the agent removes guest copies on delete)
  curl -sk -u "$u:${!t}" "$OC/calshare/v1/shares" | python3 -c "import json,sys;[print(s['calendar'], s['user']['id']) for s in json.load(sys.stdin)]" |
    while read -r cal who; do curl -sk -u "$u:${!t}" -o /dev/null -X DELETE "$OC/calshare/v1/calendars/$cal/shares/$who"; done
  for c in def-calendar def-tasks def-addressbook; do curl -sk -u "$u:${!t}" -o /dev/null -X DELETE "$OC/caldav/$id/$c/"; done
done
sleep 3
for u in camille noah ines; do
  idv="${u}_id"; curl -sk -u "$ADMIN" -o /dev/null -w "delete user $u: %{http_code}\n" -X DELETE "$OC/graph/v1.0/users/${!idv}"
done
rm -f "$TOKENS"
