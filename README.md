# Pure Barre Boulder -> Google Calendar sync

Weekly Vercel cron that mirrors the Pure Barre Boulder schedule (today through `SYNC_DAYS` out) into the "Pure Barre Boulder" Google Calendar. Inserts new classes, patches changed ones, deletes cancelled future ones. Only touches events it created (marked `pbSource=pb-sync`).

## Routes
- `GET /api/sync` - runs the sync. `?dryRun=1` returns the planned diff without writing.
- `GET /api/probe?mode=source|range|calendar` - build order checks: source reachability, 30-day single request vs 7-day chunks, calendar auth.

Both require `Authorization: Bearer $CRON_SECRET` (Vercel cron sends this) or `?secret=$CRON_SECRET` for manual runs.

## Env vars
| Var | Value |
| --- | --- |
| `CRON_SECRET` | random string |
| `PB_CALENDAR_ID` | `c_bf34a209...@group.calendar.google.com` |
| `PB_LOCATION_SLUG` | `purebarre-boulder-co` |
| `SYNC_DAYS` | `30` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | full service account key JSON |

OAuth fallback if Workspace blocks sharing to the service account: set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` instead (scope `https://www.googleapis.com/auth/calendar.events`).

## Google setup
1. Google Cloud project -> enable Google Calendar API.
2. IAM -> Service accounts -> create one -> Keys -> add JSON key. Paste the whole file into `GOOGLE_SERVICE_ACCOUNT_JSON`.
3. Google Calendar -> "Pure Barre Boulder" settings -> Share with specific people -> add the service account email with "Make changes to events".

## Behavior
- Source is fetched in 7-day chunks (overlapping by a day, deduped by `id`), clipped to the Denver-local window.
- Events are matched by `pbId`; a hash of summary/start/end/location/description decides whether to patch.
- Deletes only events starting in the future. Duplicate `pbId`s are cleaned up.
- Safety valve: if the source returns 0 entries, or fewer than 30% of the existing synced events, the run aborts with no writes and returns 500.
- Events are transparent (free), with no reminders, and created with `sendUpdates=none`.

## Local
`npm install && npm test` runs the sync against in-memory fakes of both APIs.
