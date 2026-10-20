# Calendar app (OpenCloud Web extension)

`web-extension/` is an OpenCloud Web app: **Calendar** in the app menu, at `/calendar`. It follows OpenCloud's
language and light / dark theme. It uses the design system's components and color roles (`--oc-role-*`), and the
styling is in `src/calendar.css`.

## Calendar (`/calendar`)

- **Layout:** title and search; filter tabs (*All events / My calendars / Shared with me / Invitations*, with a
  badge counting pending invitations); then a card with a date badge, the month and range, ← Today →, a view
  selector and *New event*.
- **Views:** month / week / day / list. The sidebar shows or hides each calendar (own and shared, remembered per
  browser), creates calendars (*New calendar*: name + color) and links to sharing.
- **Editing:** click or drag over empty space to create an event; click an event to edit or delete it; drag and
  resize to move it, or move it to another calendar from the editor (including a calendar shared with write access).
- **Colors:** events are soft tints of their color (RFC 7986 `COLOR`, picked in the editor, else the calendar's color).
- **Guests:** add people in the editor (see [invitations](invitations.md)). Invitations carry a status mark before
  their title: ○ awaiting answer, ◐ maybe, ● accepted, red ○ declined.
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
