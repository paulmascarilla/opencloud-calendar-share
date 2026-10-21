# Calendar app (OpenCloud Web extension)

`web-extension/` is an OpenCloud Web app: **Calendar** in the app menu, at `/calendar`. It follows OpenCloud's
language and light / dark theme. It uses the design system's components and color roles (`--oc-role-*`), and the
styling is in `src/calendar.css`.

## Calendar (`/calendar`)

- **Layout:** title and search; filter tabs (*All events / My calendars / Shared with me / Invitations*, with a
  badge counting every invitation awaiting an answer, the same list as the bell); then a card with a date badge, the month and range, ← Today →, a view
  selector and *New event*.
- **Views:** month / week / day / list. The sidebar shows or hides each calendar (own and shared, remembered per
  browser), creates calendars (*New calendar*: name + color) and links to sharing.
- **Editing:** click or drag over empty space to create an event; click an event to edit or delete it; drag and
  resize to move it, or move it to another calendar from the editor (including a calendar shared with write access).
  New events go to the calendar used last, else to the default calendar.
- **Shared calendars:** an event you are invited to shows once, as your own copy, even when you also see the
  organizer's calendar.
- **Colors:** events are soft tints of their color (RFC 7986 `COLOR`, picked in the editor, else the calendar's color).
- **Proposals:** a guest proposes another time from their invitation; the organizer accepts or declines it in the
  event (dotted frame while one is pending). See [proposing another time](invitations.md#proposing-another-time).
- **Guests:** add people in the editor (see [invitations](invitations.md)). Invitations carry a status mark before
  their title: ○ awaiting answer, ◐ maybe, ● accepted, red ○ declined. The editor then shows when everyone is
  busy (see [availability](#availability)).
- **Busy / free:** *Show me as* in the editor (`TRANSP`). Timed events are busy and all-day events free by default,
  as in Google Calendar and Outlook: a vacation is marked *Busy*, a birthday stays free.
- **Visibility:** *Private* (default) or *Public* in the editor. People who see your availability see a public
  event's title and place instead of just *Busy* (never its description or guests). Stored as
  `X-OC-VISIBILITY:PUBLIC`, not `CLASS:PUBLIC`, which some CalDAV clients write on every event.
- **Read-only cases:** shared calendars without write access open in a read-only dialog. Recurring events are
  shown expanded; their text is edited for the whole series, and their dates are changed in a CalDAV client. An
  occurrence changed on its own in a CalDAV client is edited alone; renaming the series also renames the changed
  occurrences that still had the series' title.
- **Concurrent edits:** saving or dragging an event writes only the fields you changed, on top of the latest stored
  version, so changes made elsewhere in the meantime are kept. Deletes use `If-Match` ETags: a change made elsewhere
  is reported and the view reloads.
- **Auto refresh:** every 15 s while the tab is visible, and as soon as it comes back, one PROPFIND reads each
  calendar's `getctag`. Only calendars whose ctag changed are re-fetched. Events are cached per calendar and
  range, so search and tabs filter without network. The toolbar shows the last sync and backs off after failures.

## Availability

People see when others are busy, not what they are doing: only times and *busy* / *maybe* leave the server, plus the
title and place of events their owner made public.

- **In the editor**, once an event has guests: one row per person (you first) on a 7:00–21:00 line of the event's
  day, the event drawn across the rows, its conflicts in red. The verdict names who is busy, and *Next time
  everyone is free* moves the event to the first quarter hour, in working hours (8:00–19:00, weekdays) of the next
  two weeks, where nobody is busy or maybe. Clicking the line moves the event there; ‹ › change the day.
- **In the calendar**, *Add a person* in the sidebar picks a colleague and their color (up to 10, remembered per
  browser): their busy times are drawn next to your events, in their color, with a solid edge (dashed and hatched
  for *maybe*). They are never shown twice: events you are part of and calendars shared with you are left out, since you already see them
  in full. They refresh every minute.
- **What counts:** an event is busy unless marked free (`TRANSP:TRANSPARENT`), cancelled or declined; all-day
  events only when marked busy. Tentative events, *maybe* answers and unanswered invitations are *maybe*.
  Overlapping and adjacent events are merged into one block. Only a person's own calendars count, not those
  shared with them.

`GET /calshare/v1/freebusy?users=<id>,…&start=<RFC 3339>&end=<RFC 3339>` answers for up to 20 people and 100 days,
from Radicale's expansion of recurring events (`except=<UID>` leaves out the event being edited, if you are part of
it; `omit=known` what you already see). Turn it off with `calshare.freeBusy: false` (Helm) or
`CALENDAR_FREEBUSY=false` (Compose): the app then hides availability.

## Invitations bell

The bell sits in OpenCloud's top bar (extension point `app.runtime.header.right`, next to the notification bell),
on every page and not only in the calendar. It appears when invitations await an answer:
- a red badge with their number;
- a dropdown to accept, answer maybe or decline each one directly.

New invitations also raise an OpenCloud toast and, if allowed, a desktop notification. The bell polls
`GET /calshare/v1/invitations/pending` every 30 s while the tab is visible. OpenCloud's own bell (the userlog
service) only accepts its built-in event types, so it cannot carry calendar invitations.

## Other pages

- `/calendar/sharing`: share management (people search, *Can view* / *Can edit*, shared with me, CalDAV address).
- `/calendar/respond?cal=…&event=…&response=…`: target of the answer links put in invitations.

## How it talks to the server

The browser speaks CalDAV to Radicale through the OpenCloud proxy, with the user's session: PROPFIND, REPORT with
server-side `expand`, PUT and DELETE on `/caldav/`. The iCalendar logic is in `src/ical.ts` (ical.js). Sharing and
invitations go through `/calshare/v1`, and people search through the Graph API.

FullCalendar is driven directly (`@fullcalendar/core`), not through its Vue wrapper: the wrapper deep-watches its
options, which overflows the stack inside OpenCloud Web.
