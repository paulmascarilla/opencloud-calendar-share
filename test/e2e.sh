#!/usr/bin/env bash
# End-to-end test of calshare through the OpenCloud proxy.
set -u
# shellcheck source=/dev/null
source <(sed 's/=\(.*\)/="\1"/' "${TOKENS_FILE:-$(dirname "$0")/tokens.env}")
B=${OC:-https://localhost:9200}
c() { local who=$1; shift; local tok=${!who}; curl -sk -u "$who:$tok" "$@"; echo; }
uid() { c "$1" $B/graph/v1.0/me | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4; }
ALICE_ID=$(uid alice); BOB_ID=$(uid bob); SHARED=def-calendar-${ALICE_ID:0:8}
step() { echo; echo "### $*"; }

step "cleanup from previous run"
c alice -o /dev/null -w "%{http_code} " -X DELETE $B/calshare/v1/calendars/def-calendar/shares/bob
for e in e2e-1 e2e-2; do c alice -o /dev/null -w "%{http_code} " -X DELETE $B/caldav/$ALICE_ID/def-calendar/$e.ics; done

step "provision CalDAV homes (first login)"
c alice -o /dev/null -w "%{http_code}" -X PROPFIND -H "Depth: 1" $B/caldav/$ALICE_ID/
c bob   -o /dev/null -w "%{http_code}" -X PROPFIND -H "Depth: 1" $B/caldav/$BOB_ID/

step "alice: list own calendars"
c alice $B/calshare/v1/calendars
step "alice: share def-calendar with bob (read, by username)"
c alice -w " [%{http_code}]" -X PUT -H "Content-Type: application/json" -d '{"permission":"read"}' $B/calshare/v1/calendars/def-calendar/shares/bob
step "alice: outgoing shares"
c alice $B/calshare/v1/shares
step "bob: shared-with-me"
c bob $B/calshare/v1/shared-with-me
step "bob: CalDAV home listing shows the share"
c bob -X PROPFIND -H "Depth: 1" $B/caldav/$BOB_ID/ | grep -o "$SHARED/</href>\|Agenda (alice)"

step "alice: create event"
c alice -o /dev/null -w "%{http_code}" -X PUT -H "Content-Type: text/calendar" --data-binary $'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\nBEGIN:VEVENT\r\nUID:e2e-1\r\nDTSTAMP:20261016T120000Z\r\nDTSTART:20261020T090000Z\r\nDTEND:20261020T100000Z\r\nSUMMARY:Reunion Alice\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n' $B/caldav/$ALICE_ID/def-calendar/e2e-1.ics
step "bob: read alice's event through his mount"
c bob $B/caldav/$BOB_ID/$SHARED/e2e-1.ics | grep SUMMARY
step "bob: write attempt with read permission (expect 403)"
c bob -o /dev/null -w "%{http_code}" -X PUT -H "Content-Type: text/calendar" --data-binary $'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\nBEGIN:VEVENT\r\nUID:e2e-2\r\nDTSTAMP:20261016T120000Z\r\nDTSTART:20261021T090000Z\r\nSUMMARY:Bob\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n' $B/caldav/$BOB_ID/$SHARED/e2e-2.ics

step "alice: upgrade bob to write (by e-mail)"
c alice -w " [%{http_code}]" -X PUT -H "Content-Type: application/json" -d '{"permission":"write"}' $B/calshare/v1/calendars/def-calendar/shares/bob@example.org
step "bob: write attempt (expect 201)"
c bob -o /dev/null -w "%{http_code}" -X PUT -H "Content-Type: text/calendar" --data-binary $'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\nBEGIN:VEVENT\r\nUID:e2e-2\r\nDTSTAMP:20261016T120000Z\r\nDTSTART:20261021T090000Z\r\nSUMMARY:Bob\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n' $B/caldav/$BOB_ID/$SHARED/e2e-2.ics
step "alice: sees bob's event in her own calendar"
c alice $B/caldav/$ALICE_ID/def-calendar/e2e-2.ics | grep SUMMARY

step "negative: bob shares alice's calendar (expect 404)"
c bob -w " [%{http_code}]" -X PUT -H "Content-Type: application/json" -d '{}' $B/calshare/v1/calendars/$SHARED/shares/admin
step "negative: unknown user (expect 404)"
c alice -w " [%{http_code}]" -X PUT -H "Content-Type: application/json" -d '{}' $B/calshare/v1/calendars/def-calendar/shares/nobody
step "negative: bob reads alice's home directly (expect 403)"
c bob -o /dev/null -w "%{http_code}" -X PROPFIND -H "Depth: 1" $B/caldav/$ALICE_ID/
step "negative: unauthenticated (expect 401)"
curl -sk -o /dev/null -w "%{http_code}\n" $B/calshare/v1/shares

step "bob: decline then accept"
c bob -X POST $B/calshare/v1/shared-with-me/$SHARED/decline
echo -n "listing matches after decline (expect 0): "
c bob -X PROPFIND -H "Depth: 1" $B/caldav/$BOB_ID/ | grep -c $SHARED
c bob -X POST $B/calshare/v1/shared-with-me/$SHARED/accept
echo -n "listing matches after accept (expect 1): "; c bob -X PROPFIND -H "Depth: 1" $B/caldav/$BOB_ID/ | grep -c $SHARED

step "alice: revoke"
c alice -w "[%{http_code}]" -X DELETE $B/calshare/v1/calendars/def-calendar/shares/bob
step "bob: mount gone (expect 0 matches, then 403/404 on read)"
c bob -X PROPFIND -H "Depth: 1" $B/caldav/$BOB_ID/ | grep -c $SHARED
c bob -o /dev/null -w "%{http_code}" $B/caldav/$BOB_ID/$SHARED/e2e-1.ics
