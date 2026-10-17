# Event invitations

Share one event with several people. The organizer adds guests, and each guest gets the event in their own
calendar and answers it: accept, maybe or decline. Radicale has no CalDAV scheduling (RFC 6638), so the
invitations agent in the sidecar (`sidecar/invitations.go`) does that job.

## Behavior

- **The organizer's version wins.** Every change to the organizer's event (title, time, guests' answers) is
  pushed to the guests' copies.
- **A guest answers** in the web app, with the links in the event, through the REST API, or in any CalDAV client.
  The answer goes back into the organizer's event and then to the other guests.
- **Removing a guest** deletes their copy, and deleting the event deletes all copies. **A guest deleting their
  copy** declines the invitation, and the copy is not pushed back.
- **Moving the event** to another calendar keeps the copies.

## In CalDAV clients

A copy awaiting an answer is `STATUS:TENTATIVE` (drawn as tentative by Thunderbird and Apple) and
`TRANSP:TRANSPARENT` (not busy) until accepted. Titles are left untouched.

The description ends with **Accept / Maybe / Decline** links. They are plain text, plus HTML buttons (`ALTREP` /
`X-ALT-DESC`) for clients that render HTML descriptions. The links open `calshare.publicUrl/calendar/respond?…` in
OpenCloud, which:
1. logs the user in if needed;
2. checks the invitation is theirs;
3. records the answer.

The tab then closes itself after a 3 s countdown ("Keep open" cancels it). Browsers allow this only for a tab
opened directly on the link, the usual case when already logged in. After a login redirect, the page says the tab
can be closed instead.

The links are not bearer tokens: someone who sees the description through a shared calendar cannot answer for
the guest. The texts follow `calshare.language`.

## Invitations created in CalDAV clients

Thunderbird, DAVx⁵ / Android and other clients save guests as e-mail addresses (`ATTENDEE:mailto:bob@…`). The
agent looks each address up in OpenCloud (Graph `$search`). When the address belongs to an OpenCloud user, the
agent tags the organizer's event with `X-OC-USERID` (written back as the calendar owner) and delivers the copy as
usual.

- The `mailto:` value is kept, so the guest's own client recognizes the invitation as theirs and shows its native
  accept / decline bar.
- Unknown or external addresses are left untouched, with no copy. Their client may still e-mail them itself.
- Lookups are cached: 24 h for users found, 1 h for unknown addresses.
- This needs the [service account](installation.md#service-account). Without it, guests must be added from the web
  app or the REST API.
- iOS only offers "Invitees" on servers that implement CalDAV scheduling, which Radicale does not. iOS users can
  receive and answer invitations, but cannot create them.

## REST API

All endpoints are under `https://<opencloud>/calshare` and act as the caller.

| Method | Path | |
|---|---|---|
| GET | `/v1/calendars/{cal}/events/{event}/guests` | organizer + guests with their answers |
| PUT | `/v1/calendars/{cal}/events/{event}/guests` | `{"guests": ["bob", "carol@example.org", "<id>"]}` replaces the guest list (organizer, or owner of the calendar) |
| POST | `/v1/calendars/{cal}/events/{event}/respond` | `{"response": "accepted"\|"tentative"\|"declined"}` on your copy |
| GET | `/v1/invitations` | events you organize / copies you received |
| GET | `/v1/invitations/pending` | upcoming invitations awaiting your answer |

`{cal}` is the calendar id in your home (`def-calendar`, or a shared-calendar mount); `{event}` is the file name.

## Internals

```
organizer PUT/DELETE ──▶ Radicale ──storage hook (wget, localhost)──▶ calshare /internal/storage-changed
                                                                         │ queue → 1 worker thread
          guest copies ◀── PUT/DELETE as each guest ◀─────────────────────┘
```

- Guests are `ATTENDEE;X-OC-USERID=<OpenCloud id>` on the organizer's event (the *master*). Each guest gets a
  *copy* in their main calendar, with the same file name.
- Copies are marked with `X-OC-ORGANIZER-HREF`, at the VCALENDAR level and in each VEVENT (Thunderbird drops
  unknown VCALENDAR properties when it rewrites an event), and with `X-OC-SYNC-HASH`. A file is also recognized as
  a copy through the index, or because it sits in a guest's calendar with the master's UID.
- The original title and description are kept in `X-OC-SUMMARY` / `X-OC-DESCRIPTION`.
- The storage hook runs inside Radicale's write lock, so it only notifies the sidecar (1 s timeout). All writes
  happen afterwards, in a single worker thread.
- The index (`/var/lib/radicale/calshare/invitations.json`) remembers copies after the master is gone.
- A full scan, at startup and every 10 min, catches up on changes missed while the sidecar was down and removes
  orphan copies.
- Changing `PUBLIC_URL` or `INVITE_LANGUAGE`, or bumping `COPY_FORMAT` in the code, rewrites all copies.
