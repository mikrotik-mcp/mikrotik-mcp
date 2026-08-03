/**
 * MikroTik MCP — Observability dashboard (React).
 *
 * A React 19 single-page app served by the dashboard server on localhost. Talks
 * to the same origin: REST for history/analytics (`/api/stats`, `/api/events`,
 * `/api/meta`, `/api/devices`, `/api/config`, `/api/event/:id`) and a live
 * stream — a Bun-native WebSocket (`/api/stream`) with an automatic SSE
 * fallback (`/api/sse`) — for the real-time feed of every tool call the LLM
 * makes. Charts are hand-rolled SVG (no chart library). A `?token=` in the URL
 * is forwarded to every API call and the live stream when the server requires it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { api, deleteEvents, postJson } from "./api";
import {
  BookOpen,
  Check,
  HelpCircle,
  Network,
  Pause,
  Pencil,
  Play,
  Radar,
  Search,
  Trash2,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button as UiButton, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Toaster, toast } from "@/components/ui/sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { HBars, Panel, StatCard } from "./atoms";
import { DEFAULT_FEED_LIMIT, FEED_LIMITS } from "./prefs";
import { ThemeToggle } from "./theme";
import { BackupsView } from "./backups";
import { AaaView } from "./aaa";
import { ChangePlanView } from "./change-plan";
import { ActivityChart, RiskDonut } from "./charts";
import { ClientsView } from "./clients";
import { ConfigHistoryPanel, FieldGuidePanel } from "./config-panels";
import { ConfigEditor } from "./config-editor";
import { ConnectivityGraph, DeviceCard } from "./connectivity";
import { DetailDrawer } from "./detail-drawer";
import { bytes, clock, FEED_CAP, ms, num, RISK_CLASS, RISK_COLOR, sval, WINDOWS } from "./format";
import { Button, Dot, Input, Note, Select, Spinner } from "./geist";
import { DeviceHealthCard } from "./health";
import { JsonView } from "./highlight";
import { useLiveStream, useReveals } from "./hooks";
import { DriftView } from "./drift";
import { TransactionsView } from "./transactions";
import { FlowsView } from "./flows";
import { PoliciesView } from "./policies";
import { SimulatorView } from "./simulator";
import { SchedulesView } from "./schedules";
import { ExplainView } from "./explain";
import { AttacksView } from "./attacks";
import { MemoryView } from "./memory";
import { AlertsView } from "./alerts";
import { ModulesView } from "./modules";
import { ReleasesView } from "./releases";
import { CapsmanView } from "./capsman";
import { PacketCapture } from "./packet-capture";
import { S3Manage } from "./s3";
import { Sheet } from "./sheet";
import { SnapshotsView } from "./snapshots";
import { TopologyMap } from "./topology";
import { SSHPoolPanel } from "./ssh-pool";
import { useWhatsNew, WhatsNewModal } from "./whats-new";
import type {
  CapabilitiesJson,
  CapabilitiesPayload,
  DevicesPayload,
  Filter,
  LiveMode,
  Meta,
  Risk,
  SSHPoolPayload,
  Stats,
  ToolEvent,
  TopologyPayload,
} from "./types";
import "./tailwind.css";

gsap.registerPlugin(ScrollTrigger);

// ── export helpers ───────────────────────────────────────────────────────────
function download(name: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── view navigation ─────────────────────────────────────────────────────────
type ViewId =
  | "overview"
  | "devices"
  | "clients"
  | "aaa"
  | "topology"
  | "packets"
  | "flows"
  | "snapshots"
  | "drift"
  | "policies"
  | "simulator"
  | "schedules"
  | "explain"
  | "attacks"
  | "txn"
  | "plan"
  | "s3"
  | "backups"
  | "modules"
  | "config"
  | "memory"
  | "alerts"
  | "releases"
  | "capsman"
  | "feed";
const VIEWS: { id: ViewId; label: string; sub: string }[] = [
  { id: "overview", label: "Overview", sub: "Calls, latency & risk at a glance" },
  { id: "devices", label: "Devices", sub: "Connectivity radar & system health" },
  { id: "clients", label: "Clients", sub: "Connected LAN devices — usage, block/allow, pin IP" },
  { id: "aaa", label: "RADIUS & UM", sub: "RADIUS client & User Manager RADIUS server" },
  { id: "topology", label: "Topology", sub: "Layer-2 neighbours via MNDP / CDP / LLDP" },
  { id: "packets", label: "Packets", sub: "Live TZSP capture & decode" },
  { id: "flows", label: "Flows", sub: "NetFlow/IPFIX top talkers, conversations & anomalies" },
  { id: "snapshots", label: "Snapshots", sub: "Config history & time-travel diff" },
  { id: "drift", label: "Drift Guard", sub: "Golden config baselines & live drift detection" },
  {
    id: "attacks",
    label: "Attacks",
    sub: "Live attack incidents, evidence and guarded blocking",
  },
  {
    id: "policies",
    label: "Policies",
    sub: "Your own compliance rules, linted against config",
  },
  {
    id: "explain",
    label: "Explain",
    sub: "Config → architecture document, diagram and consequence diffs",
  },
  {
    id: "simulator",
    label: "Simulator",
    sub: "Trace a hypothetical packet — no device touched",
  },
  {
    id: "schedules",
    label: "Schedules",
    sub: "Auditors on a cron — alerting only on what changed",
  },
  {
    id: "txn",
    label: "Transactions",
    sub: "Cross-device two-phase commit — prepare, verify, commit everywhere",
  },
  { id: "plan", label: "Change Plan", sub: "Dry-run intended RouterOS commands" },
  { id: "s3", label: "S3 Backups", sub: "List, download & delete S3 backup objects" },
  { id: "backups", label: "Backups", sub: "Local config vault — create, restore, manage" },
  { id: "modules", label: "Modules", sub: "Enable/disable tool modules — curate the surface" },
  { id: "config", label: "Config", sub: "Effective configuration & safe editor" },
  { id: "memory", label: "Memory", sub: "Knowledge graph — entities, relations & observations" },
  {
    id: "alerts",
    label: "Alerts",
    sub: "Rules that reach out — Slack, Discord, ntfy, webhook, MCP",
  },
  { id: "releases", label: "Releases", sub: "Update, downgrade & read every version's notes" },
  { id: "capsman", label: "CAPsMAN", sub: "Wi-Fi fabric: coverage, weak signal, load, FT & HA" },
  { id: "feed", label: "Live Feed", sub: "Every tool call, in real time" },
];
/** Valid view ids — used to validate a hash/stored route before trusting it. */
const VIEW_IDS = new Set<ViewId>(VIEWS.map((v) => v.id));
/** localStorage key remembering the last-visited page. */
const VIEW_STORE_KEY = "mt-view";

/** The bare view id in the URL hash (`#devices` / `#/devices` → `devices`). */
function viewFromHash(): ViewId | null {
  try {
    const id = location.hash.replace(/^#\/?/, "") as ViewId;
    return VIEW_IDS.has(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * The page to show on load: the URL hash wins (so a refresh, bookmark, or shared
 * link lands exactly where the user was), then the last-visited page persisted
 * in localStorage, then Overview.
 */
function initialView(): ViewId {
  const fromHash = viewFromHash();
  if (fromHash) return fromHash;
  try {
    const stored = localStorage.getItem(VIEW_STORE_KEY) as ViewId | null;
    if (stored && VIEW_IDS.has(stored)) return stored;
  } catch {
    /* storage unavailable — fall through to the default */
  }
  return "overview";
}

/**
 * Per-domain accent for each page. Drives the page's title gradient, the active
 * nav item, the help button, and assorted accents via the `--page-accent` /
 * `--page-accent-2` CSS variables set on `.main[data-view]`. Colour-coding the
 * pages makes the dashboard feel alive and helps orientation at a glance.
 */
// Monochrome chrome: every page uses the same foreground→muted accent, so the
// sidebar, title, nav, glow and focus rings carry zero colour (only functional
// status colours — error/ok — remain, elsewhere). These are token references,
// not literals, so the accent inverts with the light/dark theme.
const MONO_ACCENT: [string, string] = ["var(--foreground)", "var(--muted-foreground)"];
const VIEW_ACCENT: Record<ViewId, [string, string]> = {
  overview: MONO_ACCENT,
  devices: MONO_ACCENT,
  clients: MONO_ACCENT,
  aaa: MONO_ACCENT,
  topology: MONO_ACCENT,
  packets: MONO_ACCENT,
  flows: MONO_ACCENT,
  snapshots: MONO_ACCENT,
  drift: MONO_ACCENT,
  policies: MONO_ACCENT,
  simulator: MONO_ACCENT,
  schedules: MONO_ACCENT,
  explain: MONO_ACCENT,
  attacks: MONO_ACCENT,
  txn: MONO_ACCENT,
  plan: MONO_ACCENT,
  s3: MONO_ACCENT,
  backups: MONO_ACCENT,
  modules: MONO_ACCENT,
  config: MONO_ACCENT,
  memory: MONO_ACCENT,
  alerts: MONO_ACCENT,
  releases: MONO_ACCENT,
  capsman: MONO_ACCENT,
  feed: MONO_ACCENT,
};

/**
 * Per-page help content. Every page exposes a collapsible "About this page"
 * guide (toggled from the header) explaining what it does plus a few concrete
 * tips — so a newcomer is never lost. Kept terse and action-oriented.
 */
const HELP: Record<ViewId, { what: string; tips: string[] }> = {
  overview: {
    what: "A live pulse of all MCP tool activity: total calls, error rate, p50/p95 latency, the busiest tools, and a risk breakdown — over a time window you choose.",
    tips: [
      "Change the time window (top-right) to zoom from the last 5 minutes out to 24 hours.",
      "The risk donut splits calls by annotation: read · write · destructive · dangerous.",
      "A rising error line usually points at one device or one tool — jump to Live Feed to see which.",
    ],
  },
  devices: {
    what: "Every configured router with its live reachability (SSH or MAC-Telnet), latency, identity, and system health — CPU, memory and disk — refreshed continuously.",
    tips: [
      "Each device gets a stable colour so you can track it across the connectivity radar.",
      "Health (CPU/Mem/Disk) is probed periodically; MAC-Telnet devices are probed on a slower cadence.",
      "Latency tiers are colour-coded green → amber → red; a grey node is currently unreachable.",
      "The SSH Connection Pool panel shows persistent connections: green = idle/ready, blue = busy with inflight channels, red = reconnecting.",
    ],
  },
  clients: {
    what: "The LAN devices connected to a router — merged from its DHCP leases and ARP table — with live Download/Upload charts, and one-click controls to block/allow a device, pin (reserve) its IP, change that IP, or relabel it.",
    tips: [
      "Pick the router (top-right) to inspect its connected devices; filter by IP, MAC or name.",
      "Click a device to open its live ↓/↑ traffic chart — needs a simple queue targeting its IP.",
      "Block/allow is enforced by MAC, so it survives the device changing IP; “Pin IP” makes its lease static.",
    ],
  },
  aaa: {
    what: "Full management of the router's RADIUS client (`/radius`) and the built-in User Manager RADIUS server (`/user-manager`): RADIUS servers + incoming CoA, and User Manager users, service profiles, rate/quota limitations, NAS clients, profile assignments, accounting sessions, and global settings.",
    tips: [
      "Pick the router (top-right), then switch tabs across RADIUS, Users, Profiles, Limitations, NAS, Assignments, Sessions and Settings.",
      "Every tab is full CRUD: add, edit, enable/disable and remove — secrets are write-only and shown redacted.",
      "The Usage & Heatmap tab shows each user's 3-month download/upload and a GitHub-style connection heatmap, persisted locally.",
      "If a device lacks the user-manager package, the User Manager tabs explain how to install it; RADIUS-client tabs still work.",
    ],
  },
  topology: {
    what: "A Layer-2 map of neighbours each router discovers via MNDP / CDP / LLDP — the physical adjacency of your network, drawn live.",
    tips: [
      "Solid nodes are configured devices; faint nodes are discovered-but-unmanaged neighbours.",
      "Use “Add to config →” on an unmanaged neighbour to pre-fill it in the Config editor.",
      "Drag to pan; the layout settles automatically as new neighbours arrive.",
    ],
  },
  packets: {
    what: "Live packet capture streamed from a router over TZSP — decode headers in real time without leaving the dashboard.",
    tips: [
      "Pick a device and start the capture; packets decode as they arrive.",
      "Stop the capture when done — it frees the router-side sniffer.",
      "Great for debugging a protocol issue alongside the Live Feed of tool calls.",
    ],
  },
  snapshots: {
    what: "Point-in-time captures of a device’s full configuration (/export), stored locally so you can diff any two and see exactly what changed.",
    tips: [
      "Capture a snapshot before a risky change, then diff after to audit the delta.",
      "The diff is line-level: green added, red removed.",
      "Snapshots are device config exports — for the dashboard’s OWN config history see the Config page.",
    ],
  },
  drift: {
    what: "Detect when router configs drift from their golden baseline — with change attribution and one-click reconciliation.",
    tips: [
      "Set a baseline via MCP tools (config_set_baseline) or the Baseline Manager below.",
      "Click a device card to run a live drift check against its golden config.",
      "Promote accepted changes as the new baseline, or reconcile to roll back.",
    ],
  },
  flows: {
    what: "Continuous traffic analytics from NetFlow/IPFIX the router exports here — who is using the bandwidth, talking to what, on which application. Flow metadata only; no packet payload is carried or stored.",
    tips: [
      "Empty page? Read the collector strip first — 'templates pending' means v9/IPFIX data arrived before the layout that decodes it, and resolves on the next refresh.",
      "Set it up with the setup-traffic-flow prompt: start the collector, then point the router at this host.",
      "Flows are cheap and aggregate; use Packets (TZSP) when you need to see inside a specific conversation.",
    ],
  },
  attacks: {
    what: "Watches every device's log for brute force, credential spraying, a login that SUCCEEDED after failures, port scans and unexplained config changes, and correlates them into incidents with evidence.",
    tips: [
      "Detect-only is the default — the banner says whether anything would actually be blocked.",
      "Evidence is one click away on every incident: an incident that cannot show its work should not be acted on.",
      '"Detectors that could not run" matters most — a quiet result from a detector with no input is not a safe network.',
    ],
  },
  policies: {
    what: "Policy-as-code: your organisation's own compliance rules, written as YAML and evaluated against a config snapshot. Read-only — it never changes a device.",
    tips: [
      "A rule matching nothing is NOT-APPLICABLE, never a pass — that is what keeps the score honest.",
      '"Must not be yes" is none_of + equals; not_equals also requires the field to be present.',
      "Export as SARIF to lint a router's config in a pull request like source code.",
    ],
  },
  explain: {
    what: "Turns a router's configuration into the architecture document that should have been in the wiki: what the box is for, topology, addressing, firewall, and what is exposed to the internet.",
    tips: [
      "Exposure is shown first because it is the part people actually read.",
      '"What this document does not cover" lists the menus it did not analyse — that is where the surprises live.',
      "Compare mode explains the CONSEQUENCE of a change; Snapshots shows which lines moved.",
    ],
  },
  simulator: {
    what: 'Trace a hypothetical packet through NAT, routing and firewall against the config — offline, read-only. Answers "would this get through, and which rule decides?" before anything is changed.',
    tips: [
      "UNKNOWN is not a pass: the model met something it does not implement and declined to guess.",
      "Connection state is declared, not inferred — say `established` if that is what you mean.",
      "Reachability needs no packet: it shows which rules can never match.",
    ],
  },
  schedules: {
    what: "Runs the auditors on a cron with nobody in the loop, keeps every result, and reports only what CHANGED since the previous run — new, worsened, resolved.",
    tips: [
      "Unchanged findings are silent by design; an audit that reports 40 findings nightly gets muted.",
      "The first run is only a baseline — the useful output arrives on the second.",
      "Empty heat-calendar cells mean no run that day, which is not the same as a clean one.",
    ],
  },
  txn: {
    what: "Coordinate one change across several routers: each participant stages it in Safe Mode, the assertions run while nothing is committed, then every device commits — or none does.",
    tips: [
      "Green/amber/red cells show where a distributed operation actually is.",
      "PARTIAL is the case to act on: some devices committed, and the report names the snapshot to restore each from.",
      "Start one with begin_transaction; abort a live one from its detail panel.",
    ],
  },
  plan: {
    what: "Dry-run the exact RouterOS commands a change would run before it touches a device — a change plan you can review and trust.",
    tips: [
      "Paste or build intended commands to see them validated and ordered.",
      "Nothing is sent to the device from here — it’s a preview.",
      "Pair with Safe Mode (auto-revert) when you do apply for real.",
    ],
  },
  s3: {
    what: "Browse, download, and delete backup objects in your configured S3-compatible bucket — your off-box archive of device backups and exports.",
    tips: [
      "Filter by key prefix to find a device’s backups quickly.",
      "Download fetches the object through a presigned URL; delete is permanent.",
      "For host-side .rsc backups instead, use the Backups page.",
    ],
  },
  backups: {
    what: "A local config vault on the MCP server: capture a device’s /export as a timestamped .rsc file, then download, upload, rename, restore (via Safe Mode), or delete it.",
    tips: [
      "Restore offers a dry-run (applies then rolls back) before you commit for real.",
      "Edit the vault path inline in the header — it’s saved to your config.",
      "Filenames are stamped in the device’s local 24-hour clock.",
    ],
  },
  modules: {
    what: "Every tool module in the catalog with a live on/off switch. Toggling one writes your config file's `tools` block (disabledModules / enabledModules) and applies it immediately, so you can curate exactly which scopes the MCP server exposes.",
    tips: [
      "MCP clients search-rank tools and degrade past ~100; trim the surface below ~150–200 tools so every remaining tool is reliably findable.",
      "Disable adds the module to tools.disabledModules; enable removes it (or adds it to an active allow-list) — your config file is updated live on each toggle.",
      "Changes need an MCP client reconnect (or a server restart) to actually shrink/grow the visible tool list.",
    ],
  },
  config: {
    what: "View the effective configuration, edit it safely with schema-aware validation and auto-rollback, browse a full field guide, and travel through config version history.",
    tips: [
      "Every successful apply is auto-saved to the version timeline — restore any point in time.",
      "Save a named checkpoint before a big change for an easy, labelled rollback.",
      "The Field Guide documents every config option, its type, and default — straight from the schema.",
    ],
  },
  memory: {
    what: "A persistent knowledge graph the AI builds across sessions — entities (routers, subnets, users), relations between them, and free-text observations.",
    tips: [
      "Entities are created by the AI via MCP tools — you can browse and delete them here.",
      "The graph visualization shows entities as circles and relations as directed edges; click a node to inspect it.",
      "Change the database path to switch between different knowledge bases.",
    ],
  },
  alerts: {
    what: "Rules that watch this server and reach out when something changes — an error spike, a device going dark, a destructive call on a named router — delivered to Slack, Discord, ntfy, a webhook, or the MCP client itself.",
    tips: [
      "Firing alerts are pinned to the top with a Mute action — that is the only thing that matters when you open this page under pressure.",
      "`for` stops a two-second blip paging anyone; `cooldown` bounds re-fires. A link bouncing ten times inside the cooldown produces exactly one alert and one resolve.",
      "Test a channel before relying on it — a silently broken webhook is worse than none.",
      "Webhook URLs are never shown in full: the path is the credential, so only scheme and host are displayed.",
    ],
  },
  releases: {
    what: "Every published version of the server on a timeline, with its release notes. Upgrade to the latest, or install any specific version to upgrade or downgrade.",
    tips: [
      "The green dot marks the version you're running now; the brand dot marks the latest.",
      "Install runs `bun i -g @usex/mikrotik-mcp@<version>` on the server, then it self-restarts onto that version (the connection drops briefly).",
      "Click a version to expand its release notes; the latest is expanded by default.",
    ],
  },
  capsman: {
    what: "The CAPsMAN Wi-Fi fabric for this controller: managed APs grouped by floor with per-radio health (client load, CPU, co-channel conflicts), weak-signal clients with the recommended neighbor AP to steer toward, and a roaming (802.11r FT) + HA redundancy audit.",
    tips: [
      "Radio cards are colored by health; a red 'co-ch' badge means an adjacent radio shares its channel — the proposed channel is shown as →N.",
      "Floors come from the AP identity/comment tag (e.g. AP-F3-E); unfloored APs are grouped by inferred signal adjacency.",
      "This page is read-only in this release — steering, channel-plan apply, FT enable and HA setup arrive in later phases.",
    ],
  },
  feed: {
    what: "Every tool call as it happens — tool, device, risk, duration, and success/error — with full request/response detail on click.",
    tips: [
      "Filter by status to isolate failures, or by tool/device to follow one thread.",
      "Click any row to open the full (secret-redacted) request and response.",
      "Pause the stream when you want to inspect without rows shifting under you.",
    ],
  },
};

/** Collapsible "About this page" guide shown under each page header. */
/** The `.feed-empty` pattern: a centred icon, a headline and a hint. */
function EmptyState({
  icon,
  title,
  sub,
  body,
  className,
}: {
  icon?: ReactNode;
  title: string;
  sub?: string;
  body?: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <div
      className={cn(
        "text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-14 text-center",
        className,
      )}
    >
      {icon}
      <p className="text-foreground text-sm font-medium">{title}</p>
      {sub != null && <p className="max-w-md text-xs">{sub}</p>}
      {body}
    </div>
  );
}

function HelpPanel({ view }: { view: ViewId }): ReactNode {
  const h = HELP[view];
  return (
    <div
      className="bg-card reveal flex gap-3 rounded-lg border p-4"
      role="region"
      aria-label="Page help"
    >
      <HelpCircle className="text-brand mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-sm">{h.what}</p>
        <ul className="text-muted-foreground list-disc space-y-1 pl-4 text-xs">
          {h.tips.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

interface ReloadResponse {
  ok?: boolean;
  mode?: string;
  count?: number;
  note?: string;
  error?: string;
}

/** Circular-arrow refresh glyph. */
function RefreshIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-3.5">
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v6h-6" />
      </g>
    </svg>
  );
}

/**
 * Sidebar control to reload the MCP server, as a two-button group:
 *   • **Reload Server** — soft reload (`POST /api/reload {}`): the server re-reads
 *     its config from disk and applies it live with zero downtime, so a device
 *     added here (or edited in the file) takes effect immediately.
 *   • **Restart** — hard restart (`{hard:true}`): the process self-relaunches and
 *     rebinds in ~1.5s, dropping the connection — so it is confirmed in an
 *     AlertDialog first.
 * Outcomes surface as Sonner toasts.
 */
function ReloadServerButton(): ReactNode {
  const [busy, setBusy] = useState(false);

  async function run(hard: boolean): Promise<void> {
    setBusy(true);
    const id = toast.loading(hard ? "Restarting server…" : "Reloading config…");
    try {
      const r = await postJson<ReloadResponse>("/api/reload", { hard });
      if (r?.ok) {
        if (hard) {
          toast.success("Restarting — reconnect shortly", { id, description: r.note });
        } else {
          toast.success(`Config reloaded · ${r.count ?? "?"} device${r.count === 1 ? "" : "s"}`, {
            id,
          });
        }
      } else {
        toast.error(r?.error ?? (hard ? "Restart failed" : "Reload failed"), { id });
      }
    } catch {
      toast.error(`${hard ? "Restart" : "Reload"} failed (server unreachable)`, { id });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-flex w-fit -space-x-px" role="group" aria-label="Reload server">
      <UiButton
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void run(false)}
        title="Re-read the config from disk and apply it live (no downtime)"
        className="rounded-r-none focus-visible:z-10"
      >
        <RefreshIcon />
        Reload Server
      </UiButton>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <UiButton
            variant="outline"
            size="sm"
            disabled={busy}
            title="Fully restart the server process (relaunches itself, drops the connection briefly)"
            className="rounded-l-none px-2 focus-visible:z-10"
          >
            Restart
          </UiButton>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart the MCP server?</AlertDialogTitle>
            <AlertDialogDescription>
              The server relaunches itself and rebinds the same port(s) in ~1.5s — no external
              supervisor needed. The current connection drops briefly; reconnect after. To pick up a
              newly added device without downtime, use <b>Reload Server</b> instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => void run(true)}
            >
              Restart
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Inline stroke icons for the sidebar — no icon-font dependency. */
function NavIcon({ name }: { name: ViewId }): ReactNode {
  const paths: Record<ViewId, ReactNode> = {
    overview: (
      <>
        <rect x="3" y="3" width="8" height="8" rx="1.6" />
        <rect x="13" y="3" width="8" height="5" rx="1.6" />
        <rect x="13" y="10" width="8" height="11" rx="1.6" />
        <rect x="3" y="13" width="8" height="8" rx="1.6" />
      </>
    ),
    devices: (
      <>
        <rect x="3" y="4" width="18" height="7" rx="2" />
        <rect x="3" y="13" width="18" height="7" rx="2" />
        <path d="M7 7.5h.01M7 16.5h.01" />
      </>
    ),
    clients: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
        <path d="M16 7.5a2.5 2.5 0 0 1 0 5M17.5 19a4.5 4.5 0 0 0-2-3.6" />
      </>
    ),
    aaa: (
      <>
        <path d="M12 3 4 6v5c0 4.4 3.2 7.6 8 9 4.8-1.4 8-4.6 8-9V6l-8-3Z" />
        <path d="M9.5 11.5 11 13l3.5-3.5" />
      </>
    ),
    topology: (
      <>
        <circle cx="12" cy="5" r="2.4" />
        <circle cx="5" cy="19" r="2.4" />
        <circle cx="19" cy="19" r="2.4" />
        <path d="M12 7.4 6.4 16.6M12 7.4 17.6 16.6" />
      </>
    ),
    packets: <path d="M3 12h4l2-7 4 14 2-7h6" />,
    flows: (
      <>
        <path d="M3 6h7a4 4 0 0 1 4 4v4a4 4 0 0 0 4 4h3" />
        <path d="M3 18h5" />
        <path d="m18 5 3 3-3 3" />
      </>
    ),
    snapshots: (
      <>
        <path d="M12 3 3 7.5 12 12 21 7.5 12 3Z" />
        <path d="M3 12 12 16.5 21 12" />
        <path d="M3 16.5 12 21 21 16.5" />
      </>
    ),
    drift: (
      <>
        <path d="M12 22c5.5 0 10-4.5 10-10S17.5 2 12 2 2 6.5 2 12s4.5 10 10 10Z" />
        <path d="M9 12l2 2 4-4" />
        <path d="M12 6v2M12 16v2M6 12h2M16 12h2" />
      </>
    ),
    simulator: (
      <>
        <path d="M4 6h6" />
        <path d="M4 12h10" />
        <path d="M4 18h4" />
        <path d="m14 15 3 3 5-6" />
      </>
    ),
    attacks: (
      <>
        <path d="M12 3 4 6v6c0 4.4 3.4 7.9 8 9 4.6-1.1 8-4.6 8-9V6Z" />
        <path d="m9.5 12 2 2 3.5-4" />
      </>
    ),
    explain: (
      <>
        <path d="M4 5h11a2 2 0 0 1 2 2v13" />
        <path d="M4 5v13a2 2 0 0 0 2 2h11" />
        <path d="M8 9h6" />
        <path d="M8 13h4" />
      </>
    ),
    schedules: (
      <>
        <circle cx="12" cy="13" r="8" />
        <path d="M12 9v4l2.5 2" />
        <path d="M5 3 2.5 5.5" />
        <path d="m19 3 2.5 2.5" />
      </>
    ),
    policies: (
      <>
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
        <path d="M14 3v5h5" />
        <path d="m9 14 2 2 4-4" />
      </>
    ),
    txn: (
      <>
        <rect x="3" y="4" width="7" height="6" rx="1.5" />
        <rect x="14" y="14" width="7" height="6" rx="1.5" />
        <path d="M10 7h4a3 3 0 0 1 3 3v4" />
        <path d="M14 17h-4a3 3 0 0 1-3-3v-4" />
      </>
    ),
    plan: (
      <>
        <circle cx="6" cy="6" r="2.3" />
        <circle cx="6" cy="18" r="2.3" />
        <circle cx="18" cy="8" r="2.3" />
        <path d="M6 8.3v7.4M8.3 6H13a3 3 0 0 1 3 3v0" />
      </>
    ),
    s3: (
      <>
        <ellipse cx="12" cy="6" rx="7" ry="2.6" />
        <path d="M5 6v12c0 1.5 3.1 2.6 7 2.6s7-1.1 7-2.6V6" />
        <path d="M5 12c0 1.5 3.1 2.6 7 2.6s7-1.1 7-2.6" />
      </>
    ),
    backups: (
      <>
        <path d="M3 6.5 5 3.5h14l2 3" />
        <rect x="3" y="6.5" width="18" height="14" rx="2" />
        <path d="M9.5 12h5" />
      </>
    ),
    modules: (
      <>
        <rect x="3" y="5" width="18" height="6" rx="3" />
        <circle cx="8" cy="8" r="1.5" />
        <rect x="3" y="13" width="18" height="6" rx="3" />
        <circle cx="16" cy="16" r="1.5" />
      </>
    ),
    config: (
      <>
        <path d="M4 7h8M16 7h4M4 17h4M12 17h8" />
        <circle cx="14" cy="7" r="2.2" />
        <circle cx="10" cy="17" r="2.2" />
      </>
    ),
    memory: (
      <>
        <circle cx="12" cy="6" r="2" />
        <circle cx="6" cy="14" r="2" />
        <circle cx="18" cy="14" r="2" />
        <circle cx="12" cy="20" r="2" />
        <path d="M12 8v-0.5M12 8 7.2 12.5M12 8 16.8 12.5M6 16 10.5 18.5M18 16 13.5 18.5" />
      </>
    ),
    alerts: (
      <>
        <path d="M12 4a5 5 0 0 0-5 5v3.5L5.5 15h13L17 12.5V9a5 5 0 0 0-5-5z" />
        <path d="M10 18a2 2 0 0 0 4 0" />
      </>
    ),
    releases: (
      <>
        <path d="M12 3v12" />
        <path d="M8 11l4 4 4-4" />
        <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      </>
    ),
    capsman: (
      <>
        <path d="M5 12a7 7 0 0 1 14 0" />
        <path d="M8.5 12a3.5 3.5 0 0 1 7 0" />
        <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
        <path d="M12 13.4V20" />
      </>
    ),
    feed: <path d="M4 6h16M4 12h16M4 18h10" />,
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

// ── app ──────────────────────────────────────────────────────────────────────
function App(): ReactNode {
  const [stats, setStats] = useState<Stats | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [devices, setDevices] = useState<DevicesPayload | null>(null);
  const [sshPool, setSshPool] = useState<SSHPoolPayload | null>(null);
  const whatsNew = useWhatsNew(meta?.version);
  const [topology, setTopology] = useState<TopologyPayload | null>(null);
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [editingConfig, setEditingConfig] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  // A device entry seeded from the topology map's "Add to config →" action.
  const [seed, setSeed] = useState<{ name: string; body: Record<string, unknown> } | null>(null);
  const [feed, setFeed] = useState<ToolEvent[]>([]);
  const [windowMs, setWindowMs] = useState(3_600_000);
  // The Live Feed row limit is a real config value (`dashboard.feedLimit`), so it
  // shows in the effective config and the config editor and is shared by every
  // viewer. Derive it from the loaded config; the Config-page control persists a
  // change through the same apply endpoint the editor uses.
  const feedLimit =
    Number((config?.dashboard as Record<string, unknown> | undefined)?.feedLimit) ||
    DEFAULT_FEED_LIMIT;
  const setFeedLimit = useCallback(
    async (n: number): Promise<void> => {
      if (!config) return;
      const dashboard = { ...(config.dashboard as Record<string, unknown>), feedLimit: n };
      // rollbackMs: 0 → apply + persist immediately, no rollback countdown; the
      // server merges back any redacted secrets. Refetch so the JSON view, the
      // editor and the feed table all pick up the new value.
      await postJson("/api/config", { config: { ...config, dashboard }, rollbackMs: 0 }).catch(() =>
        toast.error("Could not save the feed limit"),
      );
      await api<Record<string, unknown>>("/api/config")
        .then(setConfig)
        .catch(() => {});
    },
    [config],
  );
  const [paused, setPaused] = useState(false);
  const [liveMode, setLiveMode] = useState<LiveMode>("off");
  const [selected, setSelected] = useState<ToolEvent | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // Per-device counter bumped on each live event — feeds the connectivity graph's
  // round-trip "burst" so a new tool call visibly travels out and back.
  const [pulses, setPulses] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<Filter>({
    tool: "",
    risk: "",
    device: "",
    status: "",
    q: "",
  });
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const rootRef = useRef<HTMLDivElement | null>(null);
  useReveals(rootRef);
  // The active page is mirrored in the URL hash + localStorage so it survives a
  // refresh and follows browser back/forward (see initialView / setView below).
  const [view, setViewState] = useState<ViewId>(initialView);
  const setView = useCallback((next: ViewId): void => {
    setViewState(next);
    // The Field Guide sheet only renders under the Config view; without this it
    // would silently stay "open" and pop back the next time you navigate there.
    setGuideOpen(false);
    try {
      if (viewFromHash() !== next) location.hash = next;
      localStorage.setItem(VIEW_STORE_KEY, next);
    } catch {
      /* storage/url unavailable — in-memory navigation still works */
    }
  }, []);
  useEffect(() => {
    // Normalise the URL on first load (e.g. when the view came from storage) and
    // track back/forward + manual hash edits.
    if (viewFromHash() !== view) {
      try {
        location.hash = view;
      } catch {
        /* ignore */
      }
    }
    const onHashChange = (): void => {
      const id = viewFromHash();
      if (id) setView(id);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
    // Run once on mount: setView is stable and `view` is only read here for the
    // initial URL normalisation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Per-page "About this page" help, remembered per view across reloads.
  const [helpOpen, setHelpOpen] = useState<Set<ViewId>>(() => {
    try {
      const raw = localStorage.getItem("mt-help-open");
      return new Set(raw ? (JSON.parse(raw) as ViewId[]) : []);
    } catch {
      return new Set();
    }
  });
  const toggleHelp = (v: ViewId): void =>
    setHelpOpen((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      try {
        localStorage.setItem("mt-help-open", JSON.stringify([...next]));
      } catch {
        /* storage unavailable — help just won't persist */
      }
      return next;
    });
  // Devices page: search + status filter so a large fleet stays navigable.
  const [deviceQuery, setDeviceQuery] = useState("");
  const [deviceFilter, setDeviceFilter] = useState<"all" | "online" | "offline">("all");
  const deviceCounts = useMemo(() => {
    const list = devices?.devices ?? [];
    return {
      online: list.filter((d) => d.status.reachable === true).length,
      offline: list.filter((d) => d.status.reachable === false).length,
      total: list.length,
    };
  }, [devices]);
  const shownDevices = useMemo(() => {
    const list = devices?.devices ?? [];
    const q = deviceQuery.trim().toLowerCase();
    return list.filter((d) => {
      if (deviceFilter === "online" && d.status.reachable !== true) return false;
      if (deviceFilter === "offline" && d.status.reachable !== false) return false;
      if (
        q &&
        !d.name.toLowerCase().includes(q) &&
        !(d.address ?? d.host ?? "").toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [devices, deviceQuery, deviceFilter]);

  // Live stream → prepend to feed (unless paused) and pulse the device's link.
  useLiveStream(
    useCallback((e: ToolEvent) => {
      if (pausedRef.current) return;
      setFeed((f) => [e, ...f].slice(0, FEED_CAP));
      const dev = e.device;
      if (dev) setPulses((p) => ({ ...p, [dev]: (p[dev] ?? 0) + 1 }));
    }, []),
    useCallback((m: LiveMode) => setLiveMode(m), []),
  );

  // Pull as many events as the live feed can hold (`FEED_CAP`) so the depth
  // matches the in-memory feed — not a smaller slice that makes the count appear
  // to shrink. Used both on mount and when the tab regains focus.
  const loadBacklog = useCallback(() => {
    if (pausedRef.current) return;
    void api<{ events: ToolEvent[] }>(`/api/events?limit=${FEED_CAP}`)
      .then((r) => setFeed(r.events))
      .catch(() => {});
  }, []);

  // Initial load.
  useEffect(() => {
    loadBacklog();
  }, [loadBacklog]);

  // Returning to the tab after a while: the live socket revives itself (see
  // useLiveStream), but events that arrived while we were away were never pushed —
  // refetch the backlog so the feed catches up immediately instead of resuming
  // from a stale point.
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === "visible") loadBacklog();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadBacklog]);

  // Analytics + devices polling.
  const refreshStats = useCallback(() => {
    void api<Stats>(`/api/stats?window=${windowMs}&buckets=60`)
      .then(setStats)
      .catch(() => {});
  }, [windowMs]);
  useEffect(() => {
    refreshStats();
    const fetchAll = (): void => {
      refreshStats();
      void api<Meta>("/api/meta")
        .then(setMeta)
        .catch(() => {});
      void api<DevicesPayload>("/api/devices")
        .then(setDevices)
        .catch(() => {});
      void api<SSHPoolPayload>("/api/ssh-pool")
        .then(setSshPool)
        .catch(() => {});
      void api<TopologyPayload>("/api/topology")
        .then(setTopology)
        .catch(() => {});
    };
    fetchAll();
    const t = setInterval(() => {
      if (!pausedRef.current) fetchAll();
    }, 4000);
    return () => clearInterval(t);
  }, [refreshStats]);
  useEffect(() => {
    const load = (): void =>
      void api<Record<string, unknown>>("/api/config")
        .then(setConfig)
        .catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  // Toggle a device enabled/disabled and refresh the device list.
  const toggleDevice = useCallback((name: string, disabled: boolean): void => {
    void postJson<DevicesPayload>("/api/devices/toggle", { device: name, disabled })
      .then((r) => {
        setDevices(r);
        toast.success(`Device ${name} ${disabled ? "disabled" : "enabled"}`);
      })
      .catch(() => toast.error(`Could not ${disabled ? "disable" : "enable"} ${name}`));
  }, []);

  // Probe a device now / drop-and-reconnect its pooled SSH connection. Both hit
  // the server, which refreshes the cached health and returns the full device
  // payload, so the card reflects the result immediately.
  const probeAction = useCallback(
    async (kind: "test" | "reconnect", name: string): Promise<void> => {
      try {
        const r = await postJson<DevicesPayload & { status?: { reachable?: boolean | null } }>(
          `/api/devices/${kind}`,
          { device: name },
        );
        setDevices(r);
        const reachable = r.status?.reachable;
        const verb = kind === "reconnect" ? "Reconnected to" : "Tested";
        if (reachable === false) toast.error(`${name} is unreachable`);
        else toast.success(`${verb} ${name}`);
      } catch {
        toast.error(`Could not ${kind === "reconnect" ? "reconnect to" : "test"} ${name}`);
      }
    },
    [],
  );
  const testDevice = useCallback((name: string) => probeAction("test", name), [probeAction]);
  const reconnectDevice = useCallback(
    (name: string) => probeAction("reconnect", name),
    [probeAction],
  );

  // Capabilities. `GET /api/capabilities` is deliberately non-probing — it
  // reports only what has already been learned, so loading this page cannot fan
  // a probe out to every configured router. The Probe button does the real work.
  const [capabilities, setCapabilities] = useState<Record<string, CapabilitiesJson | null>>({});
  const loadCapabilities = useCallback(async () => {
    try {
      const res = await api<CapabilitiesPayload>("/api/capabilities");
      setCapabilities(Object.fromEntries(res.devices.map((d) => [d.device, d.capabilities])));
    } catch {
      /* capabilities are supplementary — never break the devices view */
    }
  }, []);
  useEffect(() => {
    void loadCapabilities();
  }, [loadCapabilities]);

  // Firing-alert count for the nav badge. Polled rather than streamed: alerts
  // change on the order of minutes, and a dedicated socket message type for a
  // single integer is not worth the protocol surface.
  const [firingCount, setFiringCount] = useState(0);
  useEffect(() => {
    let live = true;
    const poll = async (): Promise<void> => {
      try {
        const res = await api<{ active?: unknown[] }>("/api/alerts");
        if (live) setFiringCount(res.active?.length ?? 0);
      } catch {
        /* alerting may not be configured — the badge simply stays hidden */
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  const probeCapabilities = useCallback(async (name: string) => {
    const res = await postJson<{
      device?: string;
      capabilities?: CapabilitiesJson;
      error?: string;
    }>("/api/capabilities/refresh", { device: name });
    if (res.error) {
      toast.error(`Capability probe failed: ${res.error}`);
      return;
    }
    if (res.capabilities) {
      setCapabilities((prev) => ({ ...prev, [name]: res.capabilities as CapabilitiesJson }));
      toast.success(`Probed ${name}`);
    }
  }, []);

  // Esc closes the drawer (the What's New modal handles its own Escape key).
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const visible = useMemo(() => {
    const q = filter.q.trim().toLowerCase();
    return feed
      .filter((e) => {
        if (filter.tool && e.tool !== filter.tool) return false;
        if (filter.risk && e.risk !== filter.risk) return false;
        if (filter.device && e.device !== filter.device) return false;
        if (filter.status === "ok" && e.isError) return false;
        if (filter.status === "error" && !e.isError) return false;
        if (
          q &&
          !e.tool.toLowerCase().includes(q) &&
          !e.input.toLowerCase().includes(q) &&
          !e.output.toLowerCase().includes(q) &&
          !(e.error ?? "").toLowerCase().includes(q)
        )
          return false;
        return true;
      })
      .sort((a, b) => b.ts - a.ts); // newest first
  }, [feed, filter]);
  const hasFilters = Boolean(
    filter.tool || filter.risk || filter.device || filter.status || filter.q,
  );

  // Errors + ok/error split derived from the live `feed` (the same data the
  // table shows), so the panels never disagree with the table. The windowed
  // `/api/stats` only counts events inside its time window, which is why a
  // table error older than the window used to leave "Recent errors" empty.
  const feedErrors = useMemo(() => feed.filter((e) => e.isError), [feed]);
  const feedStatus = useMemo(
    () => ({ ok: feed.length - feedErrors.length, error: feedErrors.length }),
    [feed, feedErrors],
  );

  const openDetail = useCallback(async (e: ToolEvent) => {
    try {
      setSelected(await api<ToolEvent>(`/api/event/${encodeURIComponent(e.id)}`));
    } catch {
      setSelected(e);
    }
  }, []);

  // The rows actually rendered (the table caps at `feedLimit`) — selection and
  // "select all" operate over exactly these, so the header checkbox always
  // matches what is on screen rather than the whole buffer.
  const shownRows = useMemo(() => visible.slice(0, feedLimit), [visible, feedLimit]);
  const shownIds = useMemo(() => shownRows.map((e) => e.id), [shownRows]);
  const allShownSelected = shownIds.length > 0 && shownIds.every((id) => selectedIds.has(id));
  const someShownSelected = !allShownSelected && shownIds.some((id) => selectedIds.has(id));

  // Range selection: the last row toggled is the "anchor". Holding Shift while
  // toggling another row selects every row between the anchor and it (inclusive).
  // The anchor is tracked by id (not index) so it survives new events prepending
  // to the feed between the two clicks. `shiftHeldRef` is set on the checkbox's
  // pointer-down because Radix's onCheckedChange doesn't carry the mouse event.
  const anchorIdRef = useRef<string | null>(null);
  const shiftHeldRef = useRef(false);
  const selectRow = useCallback(
    (id: string) => {
      const shift = shiftHeldRef.current;
      shiftHeldRef.current = false;
      setSelectedIds((prev) => {
        const next = new Set(prev);
        const anchor = anchorIdRef.current;
        if (shift && anchor && anchor !== id) {
          const a = shownIds.indexOf(anchor);
          const b = shownIds.indexOf(id);
          if (a !== -1 && b !== -1) {
            for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(shownIds[i]);
            return next;
          }
        }
        if (next.has(id)) next.delete(id);
        else next.add(id);
        anchorIdRef.current = id;
        return next;
      });
    },
    [shownIds],
  );

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const everyShownSelected = shownIds.length > 0 && shownIds.every((id) => next.has(id));
      if (everyShownSelected) for (const id of shownIds) next.delete(id);
      else for (const id of shownIds) next.add(id);
      return next;
    });
  }, [shownIds]);

  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const deleteSelected = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    try {
      await deleteEvents({ ids });
      const removed = new Set(ids);
      setFeed((f) => f.filter((e) => !removed.has(e.id)));
      setSelectedIds(new Set());
      toast.success(`Deleted ${ids.length} event${ids.length === 1 ? "" : "s"}`);
    } catch {
      // network/permission error — leave selection intact for a retry
      toast.error("Could not delete the selected events");
    } finally {
      setConfirmingDelete(false);
    }
  }, [selectedIds]);

  // Export the SELECTED rows when any are checked, otherwise every visible row.
  const exportRows = (kind: "csv" | "json"): void => {
    const rows = selectedIds.size ? visible.filter((e) => selectedIds.has(e.id)) : visible;
    if (kind === "json") {
      download("mcp-events.json", JSON.stringify(rows, null, 2), "application/json");
      return;
    }
    const cols = ["ts", "tool", "risk", "device", "durationMs", "isError", "error", "reason"];
    const esc = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const body = rows
      .map((e) =>
        [
          new Date(e.ts).toISOString(),
          e.tool,
          e.risk,
          e.device ?? "",
          String(e.durationMs),
          String(e.isError),
          e.error ?? "",
          e.reason ?? "",
        ]
          .map(esc)
          .join(","),
      )
      .join("\n");
    download("mcp-events.csv", `${cols.join(",")}\n${body}\n`, "text/csv");
  };

  // Tones the error-rate figure. `is-good` was a near-neutral zinc, so it stays
  // the default foreground rather than turning green.
  const errCls = stats
    ? stats.errorRate >= 0.2
      ? "text-destructive"
      : stats.errorRate >= 0.05
        ? "text-warning"
        : ""
    : "";
  const mcp = (config?.mcp ?? {}) as Record<string, unknown>;
  const dash = (config?.dashboard ?? {}) as Record<string, unknown>;
  const ssh = (config?.ssh ?? {}) as Record<string, unknown>;
  const attacks = (config?.attacks ?? {}) as Record<string, unknown>;
  const schedules = (config?.schedules ?? {}) as Record<string, unknown>;
  const flows = (config?.flows ?? {}) as Record<string, unknown>;
  // `""` means "no filter"; the Select wrapper maps it onto a Radix-safe sentinel.
  const sel = (key: keyof Filter, label: string, opts: string[]): ReactNode => (
    <Select
      size="sm"
      aria-label={label}
      value={filter[key]}
      onValueChange={(v) => setFilter((f) => ({ ...f, [key]: v }))}
      options={[{ value: "", label }, ...opts.map((o) => ({ value: o, label: o }))]}
    />
  );

  const cur = VIEWS.find((v) => v.id === view) ?? VIEWS[0];

  return (
    <div
      className="bg-background text-foreground grid min-h-screen grid-cols-[240px_1fr]"
      ref={rootRef}
      data-view={view}
      style={
        {
          "--page-accent": VIEW_ACCENT[view][0],
          "--page-accent-2": VIEW_ACCENT[view][1],
        } as CSSProperties
      }
    >
      {/* sidebar nav */}
      <aside className="bg-card sticky top-0 flex h-screen flex-col gap-4 border-r p-4">
        <div className="flex items-center gap-3">
          <div className="bg-foreground text-background grid size-9 shrink-0 place-items-center rounded-md">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-5">
              <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 12 L4 5 M12 12 L20 5 M12 12 L12 20" />
                <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
                <circle cx="4" cy="5" r="1.9" fill="currentColor" stroke="none" />
                <circle cx="20" cy="5" r="1.9" fill="currentColor" stroke="none" />
                <circle cx="12" cy="20" r="1.9" fill="currentColor" stroke="none" />
              </g>
            </svg>
          </div>
          <div className="flex min-w-0 flex-col leading-tight">
            <b className="truncate text-sm">MikroTik MCP</b>
            <small
              className={cn(
                "text-muted-foreground inline-flex items-center gap-1 text-[11px]",
                whatsNew.release && "hover:text-foreground cursor-pointer",
              )}
              title={whatsNew.release ? "View release notes" : undefined}
              onClick={whatsNew.release ? () => whatsNew.openModal() : undefined}
            >
              {meta?.version ? `v${meta.version}` : "Observability"}
              {whatsNew.showIndicator && (
                <span
                  className="bg-brand inline-block size-1.5 rounded-full"
                  title={`v${whatsNew.release?.version} available`}
                />
              )}
            </small>
          </div>
          <span className="flex-1" />
          <ThemeToggle />
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors",
                "[&_svg]:size-4 [&_svg]:shrink-0",
                view === v.id
                  ? "bg-accent text-accent-foreground font-medium"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
              onClick={() => setView(v.id)}
            >
              <NavIcon name={v.id} />
              <span className="truncate">{v.label}</span>
              {v.id === "alerts" &&
                firingCount > 0 && (
                  // Visible from every page, not just the Alerts one — an alert
                  // nobody navigates to is an alert nobody sees.
                  <span
                    key={firingCount}
                    className="bg-destructive text-background animate-in zoom-in-50 ml-auto rounded-full px-1.5 py-0.5 text-[10px] tabular-nums"
                    title={`${firingCount} alert${firingCount === 1 ? "" : "s"} firing`}
                  >
                    {firingCount}
                  </span>
                )}
              {v.id === "feed" &&
                feed.length > 0 && (
                  // `key={feed.length}` remounts the badge on every change so the
                  // pop animation replays each time a new event arrives.
                  <span
                    key={feed.length}
                    className="bg-brand text-brand-foreground animate-in zoom-in-50 ml-auto rounded-full px-1.5 py-0.5 text-[10px] tabular-nums"
                  >
                    {feed.length > 999 ? "999+" : feed.length}
                  </span>
                )}
            </button>
          ))}
        </nav>
        <div className="flex flex-col gap-1.5 border-t pt-3">
          <ReloadServerButton />
          <span
            className="inline-flex items-center gap-2 text-[11px]"
            title="Live transport: WebSocket (preferred) or SSE fallback"
          >
            <Dot type={liveMode === "off" ? "secondary" : "success"} pulse={liveMode !== "off"} />
            {liveMode === "off" ? "offline" : `live · ${liveMode}`}
          </span>
          <small className="text-muted-foreground text-[11px]">
            {meta ? `${num(meta.total)} events · ${meta.transport}` : "connecting…"}
          </small>
        </div>
      </aside>

      {/* main content */}
      <main className="flex min-w-0 flex-col gap-5 p-6" data-view={view}>
        <header className="reveal flex flex-wrap items-center gap-3">
          <div className="flex min-w-0 flex-col">
            <h1 className="truncate text-xl font-semibold">{cur.label}</h1>
            <small className="text-muted-foreground text-xs">{cur.sub}</small>
          </div>
          <span className="flex-1" />
          {view === "overview" && (
            <Select
              size="sm"
              aria-label="Stats time window"
              value={String(windowMs)}
              onValueChange={(v) => setWindowMs(Number(v))}
              options={WINDOWS.map(([label, val]) => ({
                value: String(val),
                label: `window: ${label}`,
              }))}
            />
          )}
          <Button
            size="sm"
            ghost
            type={helpOpen.has(view) ? "accent" : "default"}
            onClick={() => toggleHelp(view)}
            aria-expanded={helpOpen.has(view)}
            title="About this page"
            icon={<HelpCircle />}
          >
            Help
          </Button>
        </header>

        {helpOpen.has(view) && <HelpPanel view={view} />}

        {/* ── Overview ── */}
        {view === "overview" && (
          <section className="grid content-start gap-[18px]">
            <div className="reveal grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3">
              {stats ? (
                <>
                  <StatCard k="Calls (window)" v={num(stats.total)} />
                  <StatCard k="Calls / min" v={stats.callsPerMin.toFixed(1)} />
                  <StatCard
                    k="Error rate"
                    v={`${(stats.errorRate * 100).toFixed(1)}%`}
                    sub={`${stats.errors} err`}
                    cls={errCls}
                  />
                  <StatCard k="Avg latency" v={ms(stats.latency.avg)} />
                  <StatCard k="p95 latency" v={ms(stats.latency.p95)} />
                  <StatCard k="p99 latency" v={ms(stats.latency.p99)} />
                  <StatCard k="Distinct tools" v={num(stats.distinctTools)} />
                  <StatCard k="Output volume" v={bytes(stats.outputBytes)} />
                </>
              ) : (
                <StatCard k="Loading…" v="—" />
              )}
            </div>

            <div className="reveal grid grid-cols-1 gap-4 xl:grid-cols-3">
              <Panel title="Calls over time" className="xl:col-span-2">
                {stats ? (
                  <ActivityChart series={stats.series} />
                ) : (
                  <div className="text-muted-foreground text-[11px]">no data</div>
                )}
              </Panel>
              {stats && (
                <>
                  <Panel title="By risk">
                    <RiskDonut
                      segments={(Object.keys(stats.byRisk) as Risk[]).map((r) => ({
                        label: r,
                        value: stats.byRisk[r],
                        color: RISK_COLOR[r],
                      }))}
                    />
                  </Panel>
                  <Panel title="Top tools" className="xl:col-span-2">
                    <HBars
                      rows={stats.byTool.map((t) => ({
                        label: t.tool,
                        value: t.count,
                        sub: `${t.count}× · ${ms(t.p95Ms)} p95${t.errors ? ` · ${t.errors} err` : ""}`,
                        color: t.errors ? "var(--destructive)" : undefined,
                      }))}
                    />
                  </Panel>
                  <Panel title="Status">
                    <RiskDonut
                      centerLabel="calls"
                      segments={[
                        { label: "ok", value: feedStatus.ok, color: "var(--muted-foreground)" },
                        { label: "error", value: feedStatus.error, color: "var(--destructive)" },
                      ]}
                    />
                  </Panel>
                  <Panel title="By device">
                    {stats.byDevice.length ? (
                      <HBars
                        rows={stats.byDevice.map((d) => ({ label: d.device, value: d.count }))}
                      />
                    ) : (
                      <div className="text-muted-foreground text-[11px]">single device</div>
                    )}
                  </Panel>
                  <Panel title="Recent errors">
                    {feedErrors.length ? (
                      <div className="flex flex-col gap-2">
                        {feedErrors.slice(0, 8).map((e) => (
                          <div
                            className="hover:bg-accent/50 grid cursor-pointer grid-cols-[auto_1fr] items-center gap-3 rounded-md px-1 py-0.5"
                            key={e.id}
                            onClick={() => void openDetail(e)}
                          >
                            <span className="text-muted-foreground text-[11px]">{clock(e.ts)}</span>
                            <span
                              className="text-destructive min-w-0 truncate text-xs"
                              title={e.error ?? e.output}
                            >
                              {e.tool}: {e.error ?? e.output ?? "error"}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-muted-foreground text-[11px]">no errors 🎉</div>
                    )}
                  </Panel>
                </>
              )}
            </div>
          </section>
        )}

        {/* ── Devices ── */}
        {view === "devices" &&
          (devices && devices.devices.length > 0 ? (
            <section className="grid content-start gap-[18px]">
              {/* search + status filter — keeps a large fleet navigable */}
              <div className="reveal flex flex-wrap items-center gap-2">
                <Input
                  className="min-w-[180px] flex-1"
                  type="search"
                  placeholder="Search devices by name or address…"
                  value={deviceQuery}
                  onChange={(e) => setDeviceQuery(e.target.value)}
                />
                <div className="bg-muted flex gap-0.5 rounded-md p-0.5">
                  {(["all", "online", "offline"] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      className={cn(
                        "rounded-sm px-2.5 py-1 text-xs transition-colors",
                        deviceFilter === f
                          ? "bg-background text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => setDeviceFilter(f)}
                    >
                      {f === "all"
                        ? `All ${deviceCounts.total}`
                        : f === "online"
                          ? `Online ${deviceCounts.online}`
                          : `Offline ${deviceCounts.offline}`}
                    </button>
                  ))}
                </div>
                <span className="text-muted-foreground text-[11px]">
                  {shownDevices.length}/{deviceCounts.total} shown
                </span>
              </div>

              {/* connectivity radar — collapsible so it doesn't dominate a big fleet */}
              <details
                className="bg-card reveal rounded-lg border p-4"
                open={deviceCounts.total <= 8}
              >
                <summary className="cursor-pointer text-sm font-medium">
                  Connectivity radar
                  <span className="text-muted-foreground text-[11px]">
                    {" "}
                    · {deviceCounts.online} online · {deviceCounts.offline} offline ·{" "}
                    {deviceCounts.total} total
                  </span>
                </summary>
                <ConnectivityGraph payload={devices} pulses={pulses} />
              </details>

              {/* SSH connection pool panel */}
              <SSHPoolPanel devices={shownDevices} poolPayload={sshPool} />

              {/* responsive device grid (filtered) */}
              {shownDevices.length === 0 ? (
                <EmptyState
                  className="reveal"
                  icon={<Search className="size-6" />}
                  title="No devices match"
                  sub="Try a different search or status filter."
                />
              ) : (
                <div className="reveal grid grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] gap-4">
                  {shownDevices.map((d) => (
                    <DeviceCard
                      key={d.name}
                      d={d}
                      allNames={devices.devices.map((x) => x.name)}
                      capabilities={capabilities[d.name] ?? null}
                      onToggle={toggleDevice}
                      onTest={testDevice}
                      onReconnect={reconnectDevice}
                      onProbeCapabilities={probeCapabilities}
                    />
                  ))}
                </div>
              )}

              {/* system health (filtered) */}
              {shownDevices.length > 0 && (
                <Panel
                  title="Device system health"
                  className="reveal"
                  extra={
                    <span className="text-muted-foreground text-[11px]">
                      CPU · memory · disk · latency · live probe
                    </span>
                  }
                >
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(22rem,1fr))] gap-3">
                    {shownDevices.map((d) => (
                      <DeviceHealthCard key={d.name} d={d} />
                    ))}
                  </div>
                </Panel>
              )}
            </section>
          ) : (
            <EmptyState
              icon={<Network className="size-6" />}
              title="No devices configured"
              body={
                <Note type="secondary" label="Tip">
                  Add a device to your config to see connectivity and system health here.
                </Note>
              }
            />
          ))}

        {/* ── Clients ── */}
        {view === "clients" && <ClientsView />}

        {/* ── RADIUS & User Manager ── */}
        {view === "aaa" && <AaaView />}

        {/* ── Topology ── */}
        {view === "topology" &&
          (topology && topology.nodes.length > 0 ? (
            // The map brings its own toolbar, HUD and inspector, so it gets the
            // page rather than sitting inside a Panel's second frame.
            <section className="reveal grid content-start gap-[18px]">
              <TopologyMap
                topo={topology}
                onOnboard={(name, body) => {
                  setSeed({ name, body });
                  setEditingConfig(true);
                  setView("config");
                }}
              />
            </section>
          ) : (
            <EmptyState
              icon={<Radar className="size-6" />}
              title="No neighbours discovered yet"
              sub="Layer-2 neighbours (MNDP / CDP / LLDP) appear here as the device reports them."
            />
          ))}

        {/* ── Packets ── */}
        {view === "packets" && (
          <section className="grid content-start gap-[18px]">
            <Panel
              title="Packet capture"
              className="reveal"
              extra={
                <span className="text-muted-foreground text-[11px]">
                  live TZSP decode · /tool sniffer streaming
                </span>
              }
            >
              <PacketCapture />
            </Panel>
          </section>
        )}

        {/* ── Snapshots ── */}
        {view === "snapshots" && <SnapshotsView />}

        {/* ── Drift Guard ── */}
        {view === "drift" && <DriftView />}

        {/* ── Policies ── */}
        {view === "policies" && <PoliciesView />}

        {/* ── Simulator ── */}
        {view === "simulator" && <SimulatorView />}

        {/* ── Scheduled audits ── */}
        {view === "schedules" && <SchedulesView />}

        {/* ── Config narrative ── */}
        {view === "explain" && <ExplainView />}

        {/* ── Attack detection ── */}
        {view === "attacks" && <AttacksView />}

        {/* ── Flows ── */}
        {view === "flows" && <FlowsView />}
        {view === "txn" && <TransactionsView />}

        {/* ── Change Plan ── */}
        {view === "plan" && <ChangePlanView />}

        {/* ── S3 Backups ── */}
        {view === "s3" && <S3Manage />}

        {/* ── Local Backups ── */}
        {view === "backups" && <BackupsView />}

        {/* ── Tool Modules ── */}
        {view === "modules" && <ModulesView />}

        {/* ── Config ── */}
        {view === "config" &&
          (config ? (
            <section className="grid content-start gap-[18px]">
              <Panel
                title="Configuration"
                className="reveal"
                extra={
                  <span className="flex items-center gap-1.5">
                    <Button
                      size="sm"
                      ghost
                      onClick={() => setGuideOpen(true)}
                      title="Every config option, documented from the schema"
                      icon={<BookOpen />}
                    >
                      Field guide
                    </Button>
                    <Button
                      size="sm"
                      ghost
                      onClick={() => setEditingConfig((v) => !v)}
                      title="Edit the config JSON with autocomplete, validation and safe-apply"
                      icon={editingConfig ? undefined : <Pencil />}
                    >
                      {editingConfig ? "View" : "Edit config"}
                    </Button>
                  </span>
                }
              >
                {editingConfig ? (
                  <ConfigEditor
                    key={seed ? `seed-${seed.name}` : "config"}
                    initial={
                      seed
                        ? {
                            ...config,
                            devices: {
                              ...(config.devices as Record<string, unknown>),
                              [seed.name]: seed.body,
                            },
                          }
                        : config
                    }
                    onClose={() => {
                      setEditingConfig(false);
                      setSeed(null);
                    }}
                    onReload={() => {
                      setSeed(null);
                      void api<Record<string, unknown>>("/api/config")
                        .then(setConfig)
                        .catch(() => {});
                    }}
                  />
                ) : (
                  <>
                    <div className="text-muted-foreground mb-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                      <span>transport: {sval(mcp.transport)}</span>
                      <span>read-only: {config.readOnly ? "yes" : "no"}</span>
                      <span>
                        dashboard: {sval(dash.host)}:{sval(dash.port)}
                      </span>
                      <span>capture: {dash.captureBody ? "on" : "off"}</span>
                      <span>s3: {config.s3 ? "configured" : "off"}</span>
                      <span>ssh pool: {ssh.keepAlive !== false ? "on" : "off"}</span>
                      <span>alerts: {config.alerts ? "on" : "off"}</span>
                      <span>attacks: {attacks.enabled ? sval(attacks.mode) : "off"}</span>
                      <span>schedules: {schedules.enabled ? "on" : "off"}</span>
                      <span>flows: {flows.enabled ? `udp/${sval(flows.port)}` : "off"}</span>
                    </div>
                    <details>
                      <summary className="cursor-pointer text-sm">
                        Full effective configuration (secrets redacted)
                      </summary>
                      <JsonView value={config} maxHeight={340} />
                    </details>
                  </>
                )}
              </Panel>

              <Panel
                title="Dashboard preferences"
                className="reveal"
                extra={
                  <span className="text-muted-foreground text-[11px]">
                    saved to <code>dashboard.feedLimit</code> in the config
                  </span>
                }
              >
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex min-w-0 flex-col">
                    {/* The Select carries its own aria-label; this is a caption. */}
                    <Label className="text-[12.5px]">Live Feed rows</Label>
                    <span className="text-muted-foreground text-[11px]">
                      How many matching calls the feed table renders. Up to {num(FEED_CAP)} are kept
                      in memory regardless; this only bounds what is drawn.
                    </span>
                  </div>
                  <span className="flex-1" />
                  <Select
                    size="sm"
                    aria-label="Live Feed rows"
                    value={String(feedLimit)}
                    onValueChange={(v) => void setFeedLimit(Number(v))}
                    options={FEED_LIMITS.map((n) => ({
                      value: String(n),
                      label: `${num(n)} rows${n === DEFAULT_FEED_LIMIT ? " (default)" : ""}`,
                    }))}
                  />
                </div>
              </Panel>

              <Panel
                title="Version history"
                className="reveal"
                extra={
                  <span className="text-muted-foreground text-[11px]">
                    point-in-time snapshots · diff &amp; restore
                  </span>
                }
              >
                <ConfigHistoryPanel
                  onRestored={() =>
                    void api<Record<string, unknown>>("/api/config")
                      .then(setConfig)
                      .catch(() => {})
                  }
                />
              </Panel>

              {guideOpen && (
                <Sheet
                  title="📖 Field guide"
                  subtitle="Every config option, documented from the schema"
                  onClose={() => setGuideOpen(false)}
                >
                  <FieldGuidePanel />
                </Sheet>
              )}
            </section>
          ) : (
            <EmptyState icon={<Spinner />} title="Loading configuration…" />
          ))}

        {/* ── Memory ── */}
        {view === "memory" && <MemoryView />}
        {view === "alerts" && <AlertsView />}

        {/* ── Releases & Updates ── */}
        {view === "releases" && <ReleasesView />}

        {/* ── CAPsMAN Wi-Fi fabric ── */}
        {view === "capsman" && <CapsmanView />}

        {/* ── Live Feed ── */}
        {view === "feed" && (
          <Panel
            className="reveal"
            title="Live tool calls"
            extra={
              <span className="text-muted-foreground text-[11px]">
                {num(shownRows.length)} shown
                {visible.length > shownRows.length && ` of ${num(visible.length)} matching`} ·{" "}
                {num(feed.length)} buffered
              </span>
            }
          >
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Input
                className="min-w-[180px] flex-1"
                type="search"
                placeholder="Search tool / input / output / error…"
                value={filter.q}
                onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
              />
              {sel("tool", "all tools", meta?.tools ?? [])}
              {sel("risk", "all risk", [
                "READ",
                "WRITE",
                "WRITE_IDEMPOTENT",
                "DESTRUCTIVE",
                "DANGEROUS",
              ])}
              {sel("device", "all devices", meta?.devices ?? [])}
              {sel("status", "all status", ["ok", "error"])}
              {/* time window selector lives in the Overview header */}
              <Button
                size="sm"
                ghost
                type={paused ? "accent" : "default"}
                onClick={() => setPaused((p) => !p)}
                icon={paused ? <Play /> : <Pause />}
              >
                {paused ? "Resume" : "Pause"}
              </Button>
              <Button
                size="sm"
                ghost
                onClick={() => exportRows("csv")}
                title={
                  selectedIds.size
                    ? `Export ${selectedIds.size} selected row${selectedIds.size === 1 ? "" : "s"} as CSV`
                    : "Export all visible rows as CSV"
                }
              >
                CSV{selectedIds.size ? ` (${selectedIds.size})` : ""}
              </Button>
              <Button
                size="sm"
                ghost
                onClick={() => exportRows("json")}
                title={
                  selectedIds.size
                    ? `Export ${selectedIds.size} selected row${selectedIds.size === 1 ? "" : "s"} as JSON`
                    : "Export all visible rows as JSON"
                }
              >
                JSON{selectedIds.size ? ` (${selectedIds.size})` : ""}
              </Button>
              <Button
                size="sm"
                ghost
                onClick={() => setFilter({ tool: "", risk: "", device: "", status: "", q: "" })}
              >
                Clear
              </Button>
              {confirmingDelete && selectedIds.size > 0 ? (
                <>
                  <Button
                    size="sm"
                    type="error"
                    onClick={() => void deleteSelected()}
                    icon={<Check />}
                  >
                    Confirm delete ({selectedIds.size})
                  </Button>
                  <Button size="sm" ghost onClick={() => setConfirmingDelete(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  ghost
                  disabled={selectedIds.size === 0}
                  onClick={() => setConfirmingDelete(true)}
                  title="Delete the selected rows"
                  icon={<Trash2 />}
                >
                  Delete{selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}
                </Button>
              )}
            </div>
            {visible.length === 0 ? (
              hasFilters ? (
                <EmptyState
                  icon={<Search className="size-6" />}
                  title="No calls match your filters"
                  sub={`${feed.length} call${feed.length === 1 ? "" : "s"} buffered — try widening the search or the risk / device / status filters.`}
                  body={
                    <Button
                      size="sm"
                      ghost
                      className="mt-2"
                      onClick={() =>
                        setFilter({ tool: "", risk: "", device: "", status: "", q: "" })
                      }
                    >
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={
                    <Dot
                      type={liveMode === "off" ? "secondary" : "success"}
                      pulse={liveMode !== "off"}
                      className="size-3"
                    />
                  }
                  title={liveMode === "off" ? "Not connected" : "Listening for tool calls…"}
                  sub={
                    liveMode === "off"
                      ? "The live stream is offline — it will reconnect automatically."
                      : "Tool calls the LLM makes against this server stream in here in real time."
                  }
                />
              )
            ) : (
              <div className="max-h-[60vh] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-7">
                        <Checkbox
                          aria-label="Select all shown rows"
                          // Radix models the tri-state directly, so the old
                          // `ref.indeterminate` DOM poke is no longer needed.
                          checked={
                            allShownSelected ? true : someShownSelected ? "indeterminate" : false
                          }
                          onCheckedChange={toggleSelectAll}
                        />
                      </TableHead>
                      <TableHead>time</TableHead>
                      <TableHead>tool</TableHead>
                      <TableHead>risk</TableHead>
                      <TableHead>device</TableHead>
                      <TableHead className="text-right">dur</TableHead>
                      <TableHead>status</TableHead>
                      <TableHead>output</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shownRows.map((e) => (
                      <TableRow
                        key={e.id}
                        data-state={selectedIds.has(e.id) ? "selected" : undefined}
                        className={cn("cursor-pointer", e.isError && "bg-destructive/8")}
                        onClick={() => void openDetail(e)}
                      >
                        <TableCell onClick={(ev) => ev.stopPropagation()}>
                          <Checkbox
                            aria-label="Select row (Shift-click to select a range)"
                            checked={selectedIds.has(e.id)}
                            onPointerDown={(ev) => {
                              shiftHeldRef.current = ev.shiftKey;
                            }}
                            onCheckedChange={() => selectRow(e.id)}
                          />
                        </TableCell>
                        <TableCell className="tabular-nums">{clock(e.ts)}</TableCell>
                        <TableCell>{e.tool}</TableCell>
                        <TableCell>
                          <span
                            className={cn(
                              "rounded-full border px-1.5 py-0.5 text-[10px]",
                              RISK_CLASS[e.risk],
                            )}
                          >
                            {e.risk.replace("WRITE_IDEMPOTENT", "WRITE·I")}
                          </span>
                        </TableCell>
                        <TableCell>{e.device ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {ms(e.durationMs)}
                        </TableCell>
                        <TableCell>
                          <span
                            className={e.isError ? "text-destructive" : "text-muted-foreground"}
                          >
                            {e.isError ? "error" : "ok"}
                          </span>
                        </TableCell>
                        <TableCell className="text-muted-foreground max-w-[24rem] truncate">
                          {e.isError ? (
                            (e.error ?? "error")
                          ) : e.reason ? (
                            <span className="italic">{e.reason}</span>
                          ) : (
                            e.output || "—"
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
        )}
      </main>

      {whatsNew.showModal && whatsNew.release && (
        <WhatsNewModal release={whatsNew.release} onDismiss={whatsNew.dismissRelease} />
      )}
      {selected && <DetailDrawer event={selected} onClose={() => setSelected(null)} />}
      <Toaster />
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);
