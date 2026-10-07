# User Manager: last connection

**RADIUS & UM → Users → Last connection** shows the start of the latest retained
User Manager accounting session for each configured user, including closed and
active sessions. It is not the last accounting packet, disconnection time, profile
activation date, or a router administrator's login time.

The date and time are shown in two compact lines using **router-local wall-clock
time**, without shifting them into the browser's timezone. This is the `started`
property documented in [MikroTik User Manager sessions](https://help.mikrotik.com/docs/spaces/ROS/pages/2555940/User+Manager#UserManager-Sessions).

## Performance and unavailable data

- Traffic and uptime counters keep their existing five-second refresh.
- The latest-session summary refreshes separately in the background, with a
  30-second per-device cache and one in-flight request shared across viewers.
- An existing private report snapshot seeds the dates after a restart. Native
  RouterOS JSON reads fetch session IDs and missing records in 2,000-record pages;
  MCP compares normalized dates, rather than running a slow reduction on the router.
  Only identity, username and start time are retained in this summary, and only
  the latest date per user is sent to the table.
- Each poll removes deleted records and fetches new or unknown start dates. A full
  reconciliation every 15 minutes also handles restored databases and reused IDs.
  Dates are published atomically after all requested pages pass validation.
- Collection has a 180-second total deadline, a 60-second per-command deadline,
  a 100,000-session ceiling and a 2 MiB per-response limit. Cached dates remain
  visible during collection; its failure does not prevent counters loading.
- `Loading…` means the first summary is pending. `Unknown` means no valid retained
  start date is available; it does **not** assert that the user has never connected.
- A failed revalidation preserves the previous date with a `cached` marker. Missing
  permission/connectivity is reported independently of traffic counters.

Accounting must be enabled on the NAS. Purged sessions, missed accounting packets,
incorrect router clocks or unavailable User Manager data limit what can be reported.
No sessions are disconnected, and no RouterOS configuration is changed.

The summary checks `list_user_manager_sessions` read access before serving cached
history. Caches are isolated by device and discarded on configuration changes.
