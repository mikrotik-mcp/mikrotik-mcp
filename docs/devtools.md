# Dashboard developer tools

Run the MCP dashboard backend on localhost port 9091, then run:

```sh
bun run dev:tools
```

Open `http://127.0.0.1:9191/`. The DevFrame dock appears over the real dashboard.
Click it and authorize using the one-time code printed in the development terminal.
If 9191 is occupied, use `bun run dev:tools --port 9194`.
The backend is separate; DevTools does not launch it or load a device configuration.

## Included

- **Data Inspector:** query the public MCP tool catalog, risk annotations and input
  schemas; inspect dashboard navigation, the configuration schema, and App View /
  dashboard build sizes and timestamps. Suggested Jora queries, saved queries,
  tree/table exploration, and optional auto-refresh are provided by DevFrame.
- **Inspector:** inspect DevFrame RPC declarations, shared state and call history
  via **Settings → Advanced → Show Devframe Inspector**. In **Functions**, filter
  by `mikrotik:` to find 13 read-only project queries. It does not record or execute
  router calls. Use the existing Live Feed for those.
- **Accessibility:** axe-based audits of the current dashboard page, violation
  details and page highlights. Open the page you want to audit before running a scan.
- **Shared Hub:** dock navigation, command palette, messages and appearance settings.

Run `bun run gen:schemas` after catalog/schema changes. Data queries reread those
generated public files; restart the dev server after navigation source changes.
Run `bun run build:ui` to populate the build-artifact source. These are local
development inputs, not measurements from a running router.

## MCP inspection

The Data Inspector and Functions panel share these sources:

- Capability overview and all module groups, always-on modules and risk counts.
- Workflow prompts with arguments and public instruction text.
- Effective App View bindings, automatic bindings and tools without views.
- RouterOS version, package, wireless, board and device-mode requirements.
- Package/catalog/MCPB version consistency and missing built views.
- Live backend version, counters and enabled module surface, fetched only from
  `/api/meta` and `/api/modules` on localhost:9091. Authentication failures and an
  offline backend are shown explicitly; no config credentials are forwarded.
- Existing tool catalog, navigation, configuration schema and build inventory.

`mikrotik:search-tools` accepts one filter object, for example:

```json
{ "query": "wireguard", "risk": "read", "hasAppView": true, "limit": 20, "offset": 0 }
```

Additional filters are `module`, `group` and `serverOnly`. Results include the total
match count; pages are limited to 100 tools. `mikrotik:describe-tool` accepts one
exact tool name and returns its schema, annotations, module, requirements and view.
Neither function invokes the tool. Declared capabilities and enabled modules are
not a guarantee that access policy or a specific router permits a call.

The public `schemas/devtools-manifest.json` is generated alongside the catalog by
`bun run gen:schemas`. View bindings use the same resolver as MCP registration;
Vite does not import tool handlers or the Bun-only server runtime.

## Boundaries

Enabled only with Vite's `devtools` mode while serving. Normal `dev:dashboard`, all
production builds (including `--mode devtools`), MCP bundles and published App Views
do not embed the Hub. DevFrame dependencies and its pinned local UI assets are dev-only.

Loopback binding is enforced even when `--host` is overridden. Interactive OTP
authentication and DevFrame's origin checks remain enabled. The extra MCP endpoint
is disabled. Data sources are read-only JSON; device configs, credentials, process
environment, event payloads and RouterOS execution handlers are never registered.
Jora is a trusted developer query engine, not a sandbox for untrusted code.
Local UI preferences and saved queries live in ignored `.cache/devtools/`.

Intentionally excluded: terminal/Code Server, file upload/edit/delete and Git write
controls (unnecessary host access); Open Graph preview (no public social pages in
the dashboard); static Hub publishing (would distribute development data and UI).
Existing Shiki diff highlighting and MCP/App View transports remain unchanged.

See [DevFrame add-ons](https://devfra.me/add-ons) and
[Vite integration](https://devfra.me/frameworks/vite).
