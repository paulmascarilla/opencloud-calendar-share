#!/usr/bin/env bash
# End-to-end test of event invitations (calshare agent + Radicale storage hook), through the OpenCloud proxy.
# usage: TOKENS_FILE=tokens.env OC=https://localhost:9200 test/invitations-e2e.sh   (tokens: admin=…, alice=…, bob=…)
set -u
# shellcheck source=/dev/null
source <(sed 's/=\(.*\)/="\1"/' "${TOKENS_FILE:-$(dirname "$0")/tokens.env}")
B=${OC:-https://localhost:9200}
c() { local who=$1; shift; local tok=${!who}; curl -sk -u "$who:$tok" "$@"; }
uid() { c "$1" $B/graph/v1.0/me | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4; }
ALICE=$(uid alice); BOB=$(uid bob); ADMIN=$(uid admin)
ok=0; ko=0
check() { if eval "$2"; then echo "  ok  $1"; ok=$((ok+1)); else echo "  KO  $1"; ko=$((ko+1)); fi; }
settle() { sleep 2; }
EV=inv-$(date +%s).ics
ICS() { printf 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\nBEGIN:VEVENT\r\nUID:%s\r\nDTSTAMP:20261016T120000Z\r\nDTSTART:20261028T130000Z\r\nDTEND:20261028T140000Z\r\nSUMMARY:%s\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nDESCRIPTION:rappel\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n' "$EV" "$1"; }
guests() { c alice "$B/calshare/v1/calendars/def-calendar/events/$EV/guests"; }
copy() { c "$1" "${@:3}" "$B/caldav/$2/def-calendar/$EV"; }
# iCalendar folds long lines: join continuation lines before grepping
unfolded() { copy "$@" | tr -d '\r' | sed ':a;N;$!ba;s/\n //g'; }

echo "### alice creates $EV and invites bob + admin (by username)"
c alice -o /dev/null -X PUT -H "Content-Type: text/calendar" --data-binary "$(ICS 'Comité projet')" "$B/caldav/$ALICE/def-calendar/$EV"
R=$(c alice -X PUT -H "Content-Type: application/json" -d '{"guests":["bob","admin"]}' "$B/calshare/v1/calendars/def-calendar/events/$EV/guests")
echo "  $R"
check "both guests pending" '[ "$(echo "$R" | grep -o "\"response\": \"pending\"" | wc -l)" = 2 ]'
settle
check "bob got a copy" 'unfolded bob $BOB | grep -q "^X-OC-SUMMARY:Comité projet$"'
check "pending copy is flagged for CalDAV clients" 'unfolded bob $BOB | grep -q "^SUMMARY:Comité projet$" && unfolded bob $BOB | grep -q "^STATUS:TENTATIVE" && unfolded bob $BOB | grep -q "^TRANSP:TRANSPARENT"'
check "copy has an Accept link to the web app" 'unfolded bob $BOB | grep -q "\(Accept\|Accepter\) : https://[^ ]*/calendar/respond?cal=def-calendar&event=$EV&response=accepted"'
check "admin got a copy" 'copy admin $ADMIN | tr -d "\r\n " | grep -q "X-OC-ORGANIZER-HREF:/$ALICE/def-calendar/$EV"'
check "organizer alarm not copied" '! copy bob $BOB | grep -q VALARM'

echo "### bob accepts (REST respond on his copy)"
c bob -o /dev/null -X POST -H "Content-Type: application/json" -d '{"response":"accepted"}' "$B/calshare/v1/calendars/def-calendar/events/$EV/respond"
settle
check "alice sees bob accepted" 'guests | grep -q "\"id\": \"$BOB\", \"displayName\": \"bob\", \"response\": \"accepted\""'
check "bob's copy is no longer flagged" 'unfolded bob $BOB | grep -q "^SUMMARY:Comité projet$" && ! unfolded bob $BOB | grep -q "^STATUS:TENTATIVE"'
check "admin's copy shows bob accepted" 'copy admin $ADMIN | tr -d "\r\n " | grep -q "PARTSTAT=ACCEPTED[^:]*X-OC-USERID=$BOB"'

echo "### alice renames and moves the event"
ETAG=$(c alice -sI "$B/caldav/$ALICE/def-calendar/$EV" | sed -n 's/^[Ee][Tt]ag: //p' | tr -d '\r')
c alice "$B/caldav/$ALICE/def-calendar/$EV" | sed 's/SUMMARY:Comité projet/SUMMARY:Comité projet (salle 2)/; s/DTSTART:20261028T130000Z/DTSTART:20261028T150000Z/; s/DTEND:20261028T140000Z/DTEND:20261028T160000Z/' > /tmp/inv-$$.ics
c alice -o /dev/null -w "  PUT %{http_code}\n" -X PUT -H "Content-Type: text/calendar" -H "If-Match: $ETAG" --data-binary @/tmp/inv-$$.ics "$B/caldav/$ALICE/def-calendar/$EV"; rm -f /tmp/inv-$$.ics
settle
check "bob's copy updated (title + time)" 'copy bob $BOB | grep -q "SUMMARY:Comité projet (salle 2)" && copy bob $BOB | grep -q "DTSTART:20261028T150000Z"'
check "bob's answer survived the update" 'guests | grep -q "\"id\": \"$BOB\", \"displayName\": \"bob\", \"response\": \"accepted\""'

echo "### bob edits his copy directly (not allowed: organizer wins on next change)"
check "bob cannot invite people himself" '[ "$(c bob -o /dev/null -w "%{http_code}" -X PUT -H "Content-Type: application/json" -d "{\"guests\":[\"alice\"]}" "$B/calshare/v1/calendars/def-calendar/events/$EV/guests")" = 403 ]'

echo "### admin deletes his copy (what Thunderbird does) -> declined, not pushed back"
c admin -o /dev/null -X DELETE "$B/caldav/$ADMIN/def-calendar/$EV"
settle
check "alice sees admin declined" 'guests | grep -q "\"id\": \"$ADMIN\", \"displayName\": \"Admin\", \"response\": \"declined\""'
check "admin's copy not recreated" '[ "$(copy admin $ADMIN -o /dev/null -w "%{http_code}")" = 404 ]'

echo "### alice removes bob from the guests"
c alice -o /dev/null -X PUT -H "Content-Type: application/json" -d '{"guests":["admin"]}' "$B/calshare/v1/calendars/def-calendar/events/$EV/guests"
settle
check "bob's copy removed" '[ "$(copy bob $BOB -o /dev/null -w "%{http_code}")" = 404 ]'

echo "### alice moves the event to another of her calendars (PUT new + DELETE old, like the web app)"
c alice -o /dev/null -X MKCALENDAR "$B/caldav/$ALICE/e2e-moves/"
c alice "$B/caldav/$ALICE/def-calendar/$EV" > /tmp/inv-$$.ics
c alice -o /dev/null -X PUT -H "Content-Type: text/calendar" -H "If-None-Match: *" --data-binary @/tmp/inv-$$.ics "$B/caldav/$ALICE/e2e-moves/$EV"; rm -f /tmp/inv-$$.ics
c alice -o /dev/null -X DELETE "$B/caldav/$ALICE/def-calendar/$EV"
settle
check "admin still has no copy (declined)" '[ "$(copy admin $ADMIN -o /dev/null -w "%{http_code}")" = 404 ]'
check "index follows the move" 'c alice "$B/calshare/v1/invitations" | grep -q "e2e-moves/$EV"'
c alice -o /dev/null -X PUT -H "Content-Type: text/calendar" --data-binary "$(c alice "$B/caldav/$ALICE/e2e-moves/$EV")" "$B/caldav/$ALICE/def-calendar/$EV"
c alice -o /dev/null -X DELETE "$B/caldav/$ALICE/e2e-moves/$EV"
c alice -o /dev/null -X DELETE "$B/caldav/$ALICE/e2e-moves/"
settle

echo "### alice re-invites bob, then deletes the event"
c alice -o /dev/null -X PUT -H "Content-Type: application/json" -d '{"guests":["admin","bob"]}' "$B/calshare/v1/calendars/def-calendar/events/$EV/guests"
settle
check "bob invited again" '[ "$(copy bob $BOB -o /dev/null -w "%{http_code}")" = 200 ]'
c alice -o /dev/null -X MKCALENDAR "$B/caldav/$ALICE/e2e-moves/"
c alice -o /dev/null -X PUT -H "Content-Type: text/calendar" -H "If-None-Match: *" --data-binary "$(c alice "$B/caldav/$ALICE/def-calendar/$EV")" "$B/caldav/$ALICE/e2e-moves/$EV"
c alice -o /dev/null -X DELETE "$B/caldav/$ALICE/def-calendar/$EV"
settle
check "bob keeps his copy when alice moves the event" 'copy bob $BOB | tr -d "\r\n " | grep -q "X-OC-ORGANIZER-HREF:/$ALICE/e2e-moves/$EV"'
c alice -o /dev/null -X PUT -H "Content-Type: text/calendar" --data-binary "$(c alice "$B/caldav/$ALICE/e2e-moves/$EV")" "$B/caldav/$ALICE/def-calendar/$EV"
c alice -o /dev/null -X DELETE "$B/caldav/$ALICE/e2e-moves/"
settle
check "and again when she moves it back" 'copy bob $BOB | tr -d "\r\n " | grep -q "X-OC-ORGANIZER-HREF:/$ALICE/def-calendar/$EV"'
c alice -o /dev/null -X DELETE "$B/caldav/$ALICE/def-calendar/$EV"
settle
check "bob's copy deleted with the event" '[ "$(copy bob $BOB -o /dev/null -w "%{http_code}")" = 404 ]'
check "event gone from the invitation index" '! c alice "$B/calshare/v1/invitations" | grep -q "$EV"'

echo "### event with a time zone (TZID + VTIMEZONE, as Thunderbird / phones write them)"
TZEV=tz-$(date +%s).ics
c alice -o /dev/null -X PUT -H "Content-Type: text/calendar" --data-binary $'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Paris\r\nBEGIN:STANDARD\r\nDTSTART:19701025T030000\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:19700329T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:'"$TZEV"$'\r\nDTSTAMP:20261016T120000Z\r\nDTSTART;TZID=Europe/Paris:20261029T100000\r\nDTEND;TZID=Europe/Paris:20261029T110000\r\nSUMMARY:Réunion fuseau\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n' "$B/caldav/$ALICE/def-calendar/$TZEV"
c alice -o /dev/null -X PUT -H "Content-Type: application/json" -d '{"guests":["bob"]}' "$B/calshare/v1/calendars/def-calendar/events/$TZEV/guests"
settle
check "copy delivered for a TZID event" '[ "$(c bob -o /dev/null -w "%{http_code}" "$B/caldav/$BOB/def-calendar/$TZEV")" = 200 ]'
c alice -o /dev/null -X DELETE "$B/caldav/$ALICE/def-calendar/$TZEV"

echo "### invitation created in a CalDAV client (Thunderbird style: guests as e-mail addresses)"
TB=tb-$(date +%s).ics
c alice -o /dev/null -X PUT -H "Content-Type: text/calendar" --data-binary $'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Mozilla.org/NONSGML Mozilla Calendar V1.1//EN\r\nBEGIN:VEVENT\r\nUID:'"$TB"$'\r\nDTSTAMP:20261016T120000Z\r\nDTSTART:20261030T090000Z\r\nDTEND:20261030T100000Z\r\nSUMMARY:Créé dans Thunderbird\r\nORGANIZER;CN=alice:mailto:alice@example.org\r\nATTENDEE;CN=alice;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:alice@example.org\r\nATTENDEE;RSVP=TRUE;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:mailto:bob@example.org\r\nATTENDEE;RSVP=TRUE;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:mailto:someone@external.test\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n' "$B/caldav/$ALICE/def-calendar/$TB"
sleep 3
tbcopy() { c bob "${@}" "$B/caldav/$BOB/def-calendar/$TB"; }
tbmaster() { c alice "$B/caldav/$ALICE/def-calendar/$TB" | tr -d '\r' | sed ':a;N;$!ba;s/\n //g'; }
check "e-mail guest resolved to the OpenCloud user" 'tbmaster | grep -q "^ATTENDEE.*X-OC-USERID=$BOB.*:mailto:bob@example.org$"'
check "organizer tagged" 'tbmaster | grep -q "^ORGANIZER.*X-OC-USERID=$ALICE"'
check "external address kept, untouched" 'tbmaster | grep -q "^ATTENDEE[^X]*:mailto:someone@external.test$"'
check "bob got a copy, his address still mailto (his client knows it is him)" 'tbcopy | tr -d "\r" | sed ":a;N;\$!ba;s/\n //g" | grep -q "^ATTENDEE.*PARTSTAT=NEEDS-ACTION.*:mailto:bob@example.org$"'
# bob accepts in his client: it rewrites his own PARTSTAT in his copy and PUTs it back
ETAG=$(tbcopy -sI | sed -n 's/^[Ee][Tt]ag: //p' | tr -d '\r')
tbcopy | tr -d '\r' | sed ':a;N;$!ba;s/\n //g' | sed '/mailto:bob@example.org$/s/PARTSTAT=NEEDS-ACTION/PARTSTAT=ACCEPTED/' | sed 's/$/\r/' > /tmp/tb-$$.ics
c bob -o /dev/null -w "  bob's client PUT %{http_code}\n" -X PUT -H "Content-Type: text/calendar" -H "If-Match: $ETAG" --data-binary @/tmp/tb-$$.ics "$B/caldav/$BOB/def-calendar/$TB"; rm -f /tmp/tb-$$.ics
settle
check "alice sees bob accepted (answered from his CalDAV client)" 'c alice "$B/calshare/v1/calendars/def-calendar/events/$TB/guests" | grep -q "\"id\": \"$BOB\", \"displayName\": \"[^\"]*\", \"response\": \"accepted\""'
echo "### bob's client rewrites his copy without our VCALENDAR marker (what Thunderbird does when editing)"
ETAG=$(tbcopy -sI | sed -n 's/^[Ee][Tt]ag: //p' | tr -d '\r')
tbcopy | tr -d '\r' | sed ':a;N;$!ba;s/\n //g' | sed '/^BEGIN:VEVENT/,$!{/^X-OC-ORGANIZER-HREF/d;/^X-OC-SYNC-HASH/d}' | sed '/^BEGIN:VEVENT/,/^END:VEVENT/{/^X-OC-ORGANIZER-HREF/d}' | sed 's/^SUMMARY:.*/SUMMARY:Titre changé par bob/; /mailto:bob@example.org$/s/PARTSTAT=[A-Z-]*/PARTSTAT=TENTATIVE/' | sed 's/$/\r/' > /tmp/tb2-$$.ics
c bob -o /dev/null -X PUT -H "Content-Type: text/calendar" -H "If-Match: $ETAG" --data-binary @/tmp/tb2-$$.ics "$B/caldav/$BOB/def-calendar/$TB"; rm -f /tmp/tb2-$$.ics
settle
check "his answer still reaches alice" 'c alice "$B/calshare/v1/calendars/def-calendar/events/$TB/guests" | grep -q "\"id\": \"$BOB\", \"displayName\": \"[^\"]*\", \"response\": \"tentative\""'
check "copy restored from the organizer (title + marker)" 'tbcopy | tr -d "\r" | grep -q "^SUMMARY:Créé dans Thunderbird" && tbcopy | grep -q "X-OC-ORGANIZER-HREF"'
c alice -o /dev/null -X DELETE "$B/caldav/$ALICE/def-calendar/$TB"
settle
check "bob's copy removed with the event" '[ "$(tbcopy -o /dev/null -w "%{http_code}")" = 404 ]'

echo; echo "$ok ok, $ko KO"; [ $ko = 0 ]
