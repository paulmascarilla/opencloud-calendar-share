#!/usr/bin/env bash
# Fictional demo data for the launch film: 3 users, a week of events (19–25 Oct 2026), a shared calendar
# and invitations. Remove everything with tools/cleanup.sh.
# usage: OC=https://localhost:9200 NS=opencloud tools/seed.sh   (writes tools/tokens.env, git-ignored)
set -euo pipefail
OC=${OC:-https://localhost:9200}; NS=${NS:-opencloud}
HERE=$(cd "$(dirname "$0")" && pwd); TOKENS=$HERE/tokens.env
oc() { kubectl -n "$NS" exec deploy/opencloud -c opencloud -- "$@"; }
apptoken() { oc sh -c "opencloud auth-app create --user-name=$1 --expiration=6h 2>/dev/null | sed -n 's/.*token: //p'"; }

ADMIN="admin:$(apptoken admin)"
declare -A NAME=([camille]="Camille Durand" [noah]="Noah Bernard" [ines]="Inès Moreau")
: > "$TOKENS"
for u in camille noah ines; do
  mail="$u@example.org"
  curl -sk -u "$ADMIN" -o /dev/null -w "user $u: %{http_code}\n" -H "Content-Type: application/json" "$OC/graph/v1.0/users" \
    -d "{\"onPremisesSamAccountName\":\"$u\",\"displayName\":\"${NAME[$u]}\",\"mail\":\"$mail\",\"preferredLanguage\":\"en\",\"passwordProfile\":{\"password\":\"Demo-$u-2026!\"}}"
  id=$(curl -sk -u "$ADMIN" -G --data-urlencode "\$search=\"$u\"" "$OC/graph/v1.0/users" | python3 -c "import json,sys;print(next(x['id'] for x in json.load(sys.stdin)['value'] if x.get('onPremisesSamAccountName')=='$u'))")
  echo "$u=$(apptoken "$u")" >> "$TOKENS"
  echo "${u}_id=$id" >> "$TOKENS"
done
source <(sed 's/=\(.*\)/="\1"/' "$TOKENS")
auth() { local t="$1"; echo "$t:${!t}"; }
idof() { local v="${1}_id"; echo "${!v}"; }

for u in camille noah ines; do
  # the language given at creation is ignored: set it as the user
  curl -sk -u "$(auth $u)" -o /dev/null -X PATCH -H "Content-Type: application/json" -d '{"preferredLanguage":"en"}' "$OC/graph/v1.0/me"
  home="$OC/caldav/$(idof $u)/"
  curl -sk -u "$(auth $u)" -o /dev/null -X PROPFIND -H "Depth: 1" "$home"          # provisions the collections
  for c in "def-calendar:Calendar" "def-tasks:Tasks"; do                            # English names
    curl -sk -u "$(auth $u)" -o /dev/null -X PROPPATCH -H "Content-Type: application/xml" "$home${c%%:*}/" \
      --data "<D:propertyupdate xmlns:D=\"DAV:\"><D:set><D:prop><D:displayname>${c#*:}</D:displayname></D:prop></D:set></D:propertyupdate>"
  done
done

# event <user> <uid> <start YYYYMMDDTHHMM00> <end> <summary> <color> [location] [rrule]
event() {
  local u=$1 uid=$2 s=$3 e=$4 sum=$5 col=$6 loc=${7:-} rr=${8:-} extra=""
  [ -n "$loc" ] && extra+=$'LOCATION:'"$loc"$'\r\n'
  [ -n "$rr" ] && extra+=$'RRULE:'"$rr"$'\r\n'
  curl -sk -u "$(auth $u)" -o /dev/null -w "  $uid %{http_code}\n" -X PUT -H "Content-Type: text/calendar" \
    --data-binary $'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//launch-film//EN\r\nBEGIN:VEVENT\r\nUID:'"$uid"$'\r\nDTSTAMP:20261017T080000Z\r\nDTSTART;TZID=Europe/Paris:'"$s"$'\r\nDTEND;TZID=Europe/Paris:'"$e"$'\r\nSUMMARY:'"$sum"$'\r\nCOLOR:'"$col"$'\r\n'"$extra"$'END:VEVENT\r\nEND:VCALENDAR\r\n' \
    "$OC/caldav/$(idof $u)/def-calendar/$uid.ics"
}
echo "events"
event camille film-standup  20261019T090000 20261019T093000 "Team stand-up"       slategray "" "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=5"
event camille film-sprint   20261019T100000 20261019T113000 "Sprint planning"     royalblue "Room 2"
event camille film-one2one  20261020T110000 20261020T120000 "1:1 with Noah"       mediumpurple
event camille film-roadmap  20261020T140000 20261020T153000 "Roadmap workshop"    teal "Room 4"
event camille film-focus    20261021T100000 20261021T113000 "Focus time"          seagreen
event camille film-lunch    20261022T121500 20261022T131500 "Lunch with Inès"     goldenrod "Le Comptoir"
event camille film-release  20261022T150000 20261022T160000 "Release check"       crimson
event camille film-onboard  20261023T110000 20261023T123000 "Customer onboarding" orchid
event camille film-weekly   20261023T160000 20261023T170000 "Weekly review"       darkorange
event ines    film-office   20261020T163000 20261020T173000 "Office hours"        teal
event ines    film-partner  20261024T100000 20261024T110000 "Partner call"        royalblue
event ines    film-demo     20261023T140000 20261023T150000 "Customer demo"       crimson "Room 1"
event noah    film-coffee   20261022T100000 20261022T103000 "Coffee chat"         darkorange

cs() { local u=$1; shift; curl -sk -u "$(auth $u)" -o /dev/null -w "  $* %{http_code}\n" -H "Content-Type: application/json" "$@"; }
echo "sharing & invitations"
cs ines -X PUT -d '{"permission":"read"}' "$OC/calshare/v1/calendars/def-calendar/shares/camille"
cs noah -X PUT -d '{"guests":["camille"]}' "$OC/calshare/v1/calendars/def-calendar/events/film-coffee.ics/guests"
cs ines -X PUT -d '{"guests":["camille","noah"]}' "$OC/calshare/v1/calendars/def-calendar/events/film-demo.ics/guests"
sleep 3
cs camille -X POST -d '{"response":"accepted"}' "$OC/calshare/v1/calendars/def-calendar/events/film-coffee.ics/respond"
cs noah -X POST -d '{"response":"accepted"}' "$OC/calshare/v1/calendars/def-calendar/events/film-demo.ics/respond"
echo "done: Camille has a pending invitation (Customer demo) and Inès's calendar shared with her"

echo "files for Camille (backdrop of the Files app)"
dav="$OC/remote.php/webdav"
for d in "Team photos" "Customer demo" "Design"; do
  curl -sk -u "$(auth camille)" -o /dev/null -w "  $d %{http_code}\n" -X MKCOL "$dav/$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$d")"
done
for f in "Meeting notes.md" "Roadmap Q4.md" "Sprint 43 goals.md" "Onboarding checklist.md"; do
  printf '# %s\n\nDemo content.\n' "${f%.md}" | curl -sk -u "$(auth camille)" -o /dev/null -w "  $f %{http_code}\n" -X PUT --data-binary @- \
    "$dav/$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$f")"
done
