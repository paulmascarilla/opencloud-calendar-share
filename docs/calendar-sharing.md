# Calendar sharing

Radicale (≥ 3.6) does the actual sharing with its native `[sharing]` map mode. The owner's calendar is mounted
as a virtual collection in the recipient's home (`/<recipient-id>/<cal>-<owner[:8]>/`). Any CalDAV client
discovers it automatically, and Radicale enforces the permissions. The calshare sidecar adds:

- recipients by **username, e-mail or id**, resolved via the OpenCloud Graph API with the caller's own credentials
- **auto-accept** (`calshare.autoAccept`): the share appears right away for the recipient
- a display name such as `Calendar (alice)`, so it does not clash with the recipient's own calendar

In the web app, sharing is managed on the **Manage sharing** page (`/calendar/sharing`).

## REST API

All endpoints are under `https://<opencloud>/calshare` and need normal OpenCloud authentication (session or app token).

| Method | Path | |
|---|---|---|
| GET | `/v1/calendars` | caller's own calendars |
| GET | `/v1/calendars/{cal}/shares` | who has access to `{cal}` |
| PUT | `/v1/calendars/{cal}/shares/{user}` | share or update, body `{"permission":"read"\|"write", "displayName"?}`; 201 when created, 200 when updated |
| DELETE | `/v1/calendars/{cal}/shares/{user}` | revoke (204) |
| GET | `/v1/shares` | every share the caller owns |
| GET | `/v1/shared-with-me` | shares received |
| POST | `/v1/shared-with-me/{mount}/accept` / `decline` | show or hide a received share in CalDAV clients |

```sh
curl -u alice:$TOKEN -X PUT -H 'Content-Type: application/json' \
     -d '{"permission":"write"}' https://cloud.example.com/calshare/v1/calendars/def-calendar/shares/bob
```
