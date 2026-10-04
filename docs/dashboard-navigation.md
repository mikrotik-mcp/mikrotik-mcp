# Dashboard navigation

The sidebar groups pages by the task you want to complete. Each page belongs to
one category; pinned shortcuts are independent and keep their saved order.

| Category             | Pages                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| Monitoring           | Overview, Home Internet, Service Health, Flows, Live Feed, Alerts, Schedules                       |
| Network              | Devices, Interfaces, Topology, L2 Fabric, CAPsMAN, Service Routing                                 |
| Users & VPN          | Clients, OpenVPN, RADIUS & UM                                                                      |
| Diagnostics          | Investigations, Client Check, Round-trip Lab, Simulator, Packets, Flight Recorder, Support Bundles |
| Security             | Attacks, Vulnerabilities, Policies                                                                 |
| Router configuration | Explain, Change Plan, Transactions, Drift Guard                                                    |
| Backup & recovery    | Snapshots, Backups, S3 Backups, Router Migration, Recovery Lab                                     |
| MCP workspace        | Prompts, Memory, Modules, Access Scope, Config, Releases                                           |

## Finding a page

- The active page opens its category automatically. Category headings show item
  counts and can be expanded independently. Navigation scrolls its active link
  into view without moving the main page.
- **Find a page** searches page names, descriptions, categories and common terms.
  For example: `wifi` finds CAPsMAN, `user manager` finds RADIUS & UM,
  `mcp permissions` finds Access Scope, and `service probes` finds Config.
- Search is local to navigation; it does not query router data. All words must
  match, ignoring case. Clear the search to restore the normal category list.
- Use the pin beside any page to keep a shortcut above the categories.
- Existing hash links such as `#openvpn`, `#aaa` and `#capsman` are unchanged.

**Config** and **Access Scope** configure the MCP server and its permissions.
**Router configuration** contains tools for understanding, planning and auditing
changes on a router. **Simulator** belongs to Diagnostics because it traces a
hypothetical packet without applying router changes.

## Maintaining the menu

`ui/observability/navigation-sections.ts` owns the category order, membership and
search aliases. Page labels and route IDs remain in `navigation.ts`. The sidebar,
page breadcrumb and header category all use this same category metadata.

When adding a page, assign it to exactly one category and update the navigation
tests. Do not rename a route ID just to move its menu entry: bookmarks and saved
pins use those IDs.
