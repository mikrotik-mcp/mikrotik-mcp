/**
 * Interactive, schema-driven config form. Renders `CONFIG_SECTIONS` as cards; each
 * section card shows a summary + an active/deactivate toggle and opens an edit
 * Sheet with its fields. Devices are sub-cards with add/edit sheets. Everything
 * mutates ONE `cfg` object (lifted to `config-editor.tsx`), so the JSON view and
 * the safe-apply pipeline stay in sync automatically.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, ChevronUp, GripVertical, Plus } from "lucide-react";
import { Reorder, useDragControls, useReducedMotion } from "motion/react";
import {
  addDevice as createDeviceDraft,
  duplicateDevice,
  reorderDevices,
  setDraftField as setIn,
} from "../../src/config-device-draft";
import type { DeviceTest } from "./config-editor";
import { api } from "./api";
import { Badge, Button, Card, Input, Note, Select } from "./geist";
import { Sheet } from "./sheet";
import { DeviceEditor } from "./device-editor";
import { ServiceProbesEditor } from "./service-probes-editor";
import { CONFIG_SECTIONS, DEVICE_FIELDS } from "./config-spec";
import type { CfgField, CfgSection } from "./config-spec";
import {
  MonitorButton,
  MonitorEmpty,
  MonitorSelect,
  MonitorSwitch,
  StatusDot,
} from "./monitoring-ui";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type Cfg = Record<string, unknown>;
const REDACTED = "«redacted»";

const asObj = (v: unknown): Cfg =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Cfg) : {};
const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
const uniq = (a: string[]): string[] => [...new Set(a)];
/** Safe stringify of an untyped config value (never "[object Object]"). */
const str = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return JSON.stringify(v) ?? "";
};

/** Read a possibly-dotted key (`channels.slack.url`) off an object. */
const getIn = (o: Cfg, key: string): unknown =>
  key.split(".").reduce<unknown>((acc, k) => asObj(acc)[k], o);

function sectionObj(cfg: Cfg, s: CfgSection): Cfg {
  return s.path ? asObj(cfg[s.path]) : cfg;
}
function setField(cfg: Cfg, s: CfgSection, key: string, val: unknown): Cfg {
  if (s.path) return { ...cfg, [s.path]: setIn(asObj(cfg[s.path]), key, val) };
  return setIn(cfg, key, val);
}
function isActive(cfg: Cfg, s: CfgSection): boolean {
  if (!s.enable) return true;
  if (s.enable.presence) return cfg[s.path ?? ""] !== undefined;
  const obj = sectionObj(cfg, s);
  return obj[s.enable.key ?? "enabled"] !== false;
}

// ── one field control ────────────────────────────────────────────────────────

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: CfgField;
  value: unknown;
  onChange: (v: unknown) => void;
}): ReactNode {
  const id = `f_${field.key.replace(/\./g, "_")}`;
  const isBool = field.type === "bool";
  let control: ReactNode;
  if (field.type === "list") {
    control = (
      <Input
        id={id}
        placeholder={field.placeholder}
        value={arr(value).join(", ")}
        onChange={(e) => {
          const items = e.target.value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          onChange(items.length ? items : undefined);
        }}
      />
    );
  } else if (field.type === "bool") {
    control = <Switch checked={value === true} onCheckedChange={onChange} />;
  } else if (field.type === "select") {
    control = (
      <Select
        value={str(value ?? field.options?.[0] ?? "")}
        onValueChange={onChange}
        options={(field.options ?? []).map((o) => ({ value: o, label: o }))}
      />
    );
  } else if (field.type === "number") {
    control = (
      <Input
        id={id}
        type="number"
        placeholder={field.placeholder}
        value={value == null ? "" : str(value)}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      />
    );
  } else {
    control = (
      <Input
        id={id}
        type={field.type === "password" ? "password" : "text"}
        placeholder={field.secret && value === REDACTED ? "•••• unchanged" : field.placeholder}
        value={value == null ? "" : str(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <div
      className={cn(
        "flex min-w-0",
        isBool ? "flex-row items-center justify-between gap-2.5" : "flex-col gap-1.5",
      )}
    >
      <Label htmlFor={id} className="text-muted-foreground text-xs font-semibold">
        {field.label}
        {field.secret && (
          <span className="text-warning text-[10px] font-semibold tracking-[0.04em] uppercase">
            secret
          </span>
        )}
      </Label>
      {control}
      {field.help && (
        <span className="text-muted-foreground text-[11px] leading-[1.4]">{field.help}</span>
      )}
    </div>
  );
}

function FieldForm({
  fields,
  value,
  onField,
}: {
  fields: CfgField[];
  value: Cfg;
  onField: (key: string, v: unknown) => void;
}): ReactNode {
  const [showAdv, setShowAdv] = useState(false);
  const basic = fields.filter((f) => !f.advanced);
  const adv = fields.filter((f) => f.advanced);
  return (
    <div className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-4 gap-y-3">
      {basic.map((f) => (
        <FieldRow
          key={f.key}
          field={f}
          value={getIn(value, f.key)}
          onChange={(v) => onField(f.key, v)}
        />
      ))}
      {adv.length > 0 && (
        <>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground col-span-full flex cursor-pointer items-center gap-1 border-0 bg-transparent py-1 text-left text-xs font-semibold"
            onClick={() => setShowAdv((s) => !s)}
          >
            {showAdv ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}{" "}
            Advanced ({adv.length})
          </button>
          {showAdv &&
            adv.map((f) => (
              <FieldRow
                key={f.key}
                field={f}
                value={getIn(value, f.key)}
                onChange={(v) => onField(f.key, v)}
              />
            ))}
        </>
      )}
    </div>
  );
}

// ── object section card + edit sheet ─────────────────────────────────────────

/** Seed object for a presence-toggled section switched on with nothing stashed. */
const SECTION_DEFAULTS: Record<string, Cfg> = {
  s3: { prefix: "", presignExpiresIn: 3600 },
  alerts: { enabled: true, rules: [], channels: {} },
};

function sectionSummary(cfg: Cfg, s: CfgSection): string {
  const o = sectionObj(cfg, s);
  const pick = (k: string): string => (o[k] != null && o[k] !== "" ? str(o[k]) : "");
  const addr = pick("host") ? `${pick("host")}:${pick("port")}` : "";
  if (s.id === "mcp") return [pick("transport"), addr].filter(Boolean).join(" · ");
  if (s.id === "dashboard")
    return [addr, o.token ? "token set" : "open"].filter(Boolean).join(" · ");
  if (s.id === "ssh")
    return `interval ${pick("keepAliveInterval") || "?"}ms · idle ${pick("idleTimeout") || "?"}ms`;
  if (s.id === "s3")
    return isActive(cfg, s)
      ? [pick("bucket"), pick("region"), pick("endpoint")].filter(Boolean).join(" · ") ||
          "not configured"
      : "";
  if (s.id === "memory") return pick("dbPath");
  if (s.id === "alerts") {
    if (!isActive(cfg, s)) return "";
    const chans = Object.keys(asObj(o.channels));
    return [
      chans.length ? chans.join(" · ") : "no channels",
      `${arr(o.rules).length} rule${arr(o.rules).length === 1 ? "" : "s"}`,
    ].join(" · ");
  }
  if (s.id === "attacks")
    return `${pick("mode") || "detect"} · every ${pick("pollSeconds") || "?"}s · block ${pick("blockTimeout") || "?"}`;
  if (s.id === "schedules")
    return `${arr(o.jobs).length} job${arr(o.jobs).length === 1 ? "" : "s"} · ${pick("concurrency") || "?"} at once`;
  if (s.id === "flows")
    return `udp/${pick("port") || "?"} · raw ${pick("retentionHours") || "?"}h · rollups ${pick("rollupDays") || "?"}d`;
  if (s.id === "policy")
    return `${arr(o.paths).length} path${arr(o.paths).length === 1 ? "" : "s"}${o.includeStarterPack === false ? "" : " · starter pack"}`;
  if (s.id === "general")
    return `${cfg.readOnly ? "read-only" : "read-write"}${cfg.disableUpdateCheck ? " · no update check" : ""}`;
  return "";
}

function ObjectCard({
  cfg,
  onChange,
  section,
}: {
  cfg: Cfg;
  onChange: (c: Cfg) => void;
  section: CfgSection;
}): ReactNode {
  const [editing, setEditing] = useState(false);
  const stash = useRef<Cfg | null>(null);
  const active = isActive(cfg, section);

  const toggle = (on: boolean): void => {
    if (section.enable?.presence) {
      if (on)
        onChange({
          ...cfg,
          [section.path!]: stash.current ?? SECTION_DEFAULTS[section.id] ?? {},
        });
      else {
        stash.current = asObj(cfg[section.path!]);
        const next = { ...cfg };
        delete next[section.path!];
        onChange(next);
        setEditing(false);
      }
      return;
    }
    onChange(setField(cfg, section, section.enable!.key ?? "enabled", on));
  };

  const summary = sectionSummary(cfg, section);

  return (
    <Card className={cn("px-4 py-3.5 transition-opacity", !active && "opacity-50")}>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-lg leading-none" aria-hidden="true">
          {section.icon}
        </span>
        <div className="min-w-0">
          <div className="text-foreground flex items-center gap-2 text-sm font-bold">
            {section.title}
            {section.enable && (
              <Badge type={active ? "success" : "secondary"}>{active ? "active" : "off"}</Badge>
            )}
          </div>
          <div className="text-muted-foreground mt-0.5 max-w-[520px] truncate font-mono text-xs">
            {summary || section.blurb}
          </div>
        </div>
        <span className="flex-1" />
        {section.enable && (
          <Switch
            checked={active}
            onCheckedChange={toggle}
            title={`${active ? "Deactivate" : "Activate"} ${section.enable.label ?? section.title}`}
          />
        )}
        <Button
          size="sm"
          ghost
          onClick={() => setEditing(true)}
          disabled={section.enable?.presence && !active}
        >
          Edit
        </Button>
      </div>

      {editing && (
        <Sheet
          title={`${section.icon} ${section.title}`}
          subtitle={section.blurb}
          onClose={() => setEditing(false)}
        >
          {section.enable && (
            <label className="border-border bg-muted text-foreground flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-[13px] font-semibold">
              <Switch checked={active} onCheckedChange={toggle} />
              {active ? "Active" : `Inactive — enable ${section.enable.label ?? section.title}`}
            </label>
          )}
          {active ? (
            <FieldForm
              fields={section.fields}
              value={sectionObj(cfg, section)}
              onField={(k, v) => onChange(setField(cfg, section, k, v))}
            />
          ) : (
            <Note type="secondary" label={false}>
              This section is turned off. Toggle it on to edit its settings.
            </Note>
          )}
        </Sheet>
      )}
    </Card>
  );
}

// ── devices ──────────────────────────────────────────────────────────────────

type DeviceControls = { tests: Record<string, DeviceTest>; onTest: (name: string) => void };

function SortableDevice({
  name,
  index,
  total,
  onMove,
  children,
}: {
  name: string;
  index: number;
  total: number;
  onMove: (offset: number) => void;
  children: (handle: ReactNode) => ReactNode;
}) {
  const controls = useDragControls();
  const reduced = useReducedMotion();
  const handle = (
    <span className="text-faint flex items-center gap-0.5">
      <button
        type="button"
        aria-label={`Drag to reorder ${name}`}
        title="Drag, or use the up and down arrow keys"
        onPointerDown={(event) => controls.start(event)}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            onMove(event.key === "ArrowUp" ? -1 : 1);
          }
        }}
        className="dv-grip"
      >
        <GripVertical aria-hidden="true" />
      </button>
      <span className="flex flex-col">
        <MonitorButton
          size="sm"
          variant="ghost"
          className="dv-move"
          aria-label={`Move ${name} up`}
          disabled={index === 0}
          onClick={() => onMove(-1)}
          icon={<ChevronUp aria-hidden="true" />}
        />
        <MonitorButton
          size="sm"
          variant="ghost"
          className="dv-move"
          aria-label={`Move ${name} down`}
          disabled={index === total - 1}
          onClick={() => onMove(1)}
          icon={<ChevronDown aria-hidden="true" />}
        />
      </span>
    </span>
  );
  return (
    <Reorder.Item
      as="li"
      value={name}
      dragListener={false}
      dragControls={controls}
      transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 35 }}
      whileDrag={{ zIndex: 10, scale: reduced ? 1 : 1.01 }}
      className="dv-entry"
    >
      {children(handle)}
    </Reorder.Item>
  );
}

/** "admin · SSH key", "admin · password". */
function loginLine(d: Cfg): string {
  const user = str(d.username) || "admin";
  if (d.mac) return `${user} · password`;
  return `${user} · ${d.keyFilename || d.privateKey ? "SSH key" : "password"}`;
}

/** "SSH :22", "SSH :22 via core-router-01", "MAC-Telnet", "REST :443, SSH fallback". */
function transportText(d: Cfg): string {
  if (d.mac) return "MAC-Telnet";
  const jump = d.jumpVia
    ? str(d.jumpVia)
    : d.jumpHost
      ? str(asObj(d.jumpHost).host) || "a bastion"
      : "";
  const ssh = `SSH :${str(d.port) || "22"}${jump ? ` via ${jump}` : ""}`;
  return d.api ? `REST :${str(d.apiPort) || "443"}, ${ssh.replace("SSH", "SSH fallback")}` : ssh;
}

export function DevicesForm({
  cfg,
  onChange,
  tests,
  onTest,
  onSave,
  saveNotice,
  initialSelection,
  onCancelStandalone,
}: {
  cfg: Cfg;
  onChange: (c: Cfg) => void;
  onSave: (c: Cfg) => Promise<boolean>;
  saveNotice: string;
  initialSelection?: { name: string; isNew: boolean };
  onCancelStandalone?: () => void;
} & DeviceControls): ReactNode {
  const [sheet, setSheet] = useState(initialSelection ?? null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const devices = asObj(cfg.devices);
  const names = Object.keys(devices);
  const defaultDevice = str(cfg.defaultDevice);
  const reorder = (order: string[]) => {
    onChange(reorderDevices(cfg, order));
    setAnnouncement(`Router order: ${order.join(", ")}. Save to apply.`);
  };
  const move = (name: string, offset: number) => {
    const index = names.indexOf(name);
    if (index + offset < 0 || index + offset >= names.length) return;
    const order = [...names];
    [order[index], order[index + offset]] = [order[index + offset], order[index]];
    reorder(order);
  };
  const duplicate = (source: string) => {
    const result = duplicateDevice(cfg, source);
    onChange(result.config);
    setSheet({ name: result.name, isNew: true });
    setAnnouncement(`Copied ${source} to ${result.name}. Review and save to apply.`);
  };

  const addDevice = (): void => {
    const result = createDeviceDraft(cfg);
    onChange(result.config);
    setSheet({ name: result.name, isNew: true });
  };
  const toggleDisabled = (n: string, disabled: boolean): void => {
    onChange({ ...cfg, devices: { ...devices, [n]: { ...asObj(devices[n]), disabled } } });
  };
  const removeDevice = (n: string): void => {
    const nd = { ...devices };
    delete nd[n];
    const next: Cfg = { ...cfg, devices: nd };
    if (defaultDevice === n) next.defaultDevice = Object.keys(nd)[0] ?? "";
    onChange(next);
    setConfirmDel(null);
  };

  const editor = sheet && (
    <DeviceEditor
      cfg={cfg}
      name={sheet.name}
      isNew={sheet.isNew}
      saveNotice={saveNotice}
      onSave={async (next) => {
        const saved = await onSave(next);
        if (saved) setSheet(null);
        return saved;
      }}
      onApply={(next) => {
        onChange(next);
        setSheet(null);
      }}
      onCancel={() => {
        if (onCancelStandalone) {
          onCancelStandalone();
          return;
        }
        if (sheet.isNew) removeDevice(sheet.name);
        setSheet(null);
      }}
      advanced={(value, onField, transport) => (
        <FieldForm
          fields={DEVICE_FIELDS.filter(
            (field) =>
              field.key === "timeoutMs" ||
              (transport === "mac"
                ? ["sourceMac", "macHost", "macPort"].includes(field.key)
                : transport === "rest" && ["apiPort", "apiInsecureTls"].includes(field.key)),
          ).map((field) => ({ ...field, advanced: false }))}
          value={value}
          onField={onField}
        />
      )}
    />
  );
  if (onCancelStandalone) return editor;

  const available = names.filter((n) => asObj(devices[n]).disabled !== true).length;
  return (
    <div className="border-border border-t" aria-label="Router configuration draft" role="group">
      <div className="flex flex-wrap items-end gap-3 px-5 py-4">
        <div className="min-w-0 flex-[1_1_260px]">
          <h3 className="text-[14px] font-[590]">Routers, in order</h3>
          <p className="text-muted-foreground text-[12px]">
            {names.length} configured · {available} available to MCP. Draft only, nothing on the
            routers changes.
          </p>
        </div>
        <label className="flex items-center gap-2">
          <span className="monitor-label">Default router</span>
          <span className="dv-mono-select">
            <MonitorSelect
              label="Default router"
              value={defaultDevice}
              onChange={(v) => onChange({ ...cfg, defaultDevice: v })}
              options={names.map((n) => ({ value: n, label: n }))}
            />
          </span>
        </label>
        <MonitorButton size="sm" onClick={addDevice} icon={<Plus aria-hidden="true" />}>
          Add device
        </MonitorButton>
      </div>

      <span role="status" className="sr-only">
        {announcement}
      </span>
      {names.length === 0 ? (
        <MonitorEmpty compact title="No routers yet">
          Choose Add device to set up your first router.
        </MonitorEmpty>
      ) : (
        <Reorder.Group
          as="ol"
          axis="y"
          values={names}
          onReorder={reorder}
          aria-label="Routers, drag to reorder"
          className="m-0 list-none p-0"
        >
          {names.map((n, index) => {
            const d = asObj(devices[n]);
            const test = tests[n]?.fingerprint === JSON.stringify(d) ? tests[n] : undefined;
            const off = d.disabled === true;
            const hosts = uniq(
              [d.host, ...arr(d.fallbackHosts)]
                .filter((host): host is string => typeof host === "string" && !!host.trim())
                .map((host) => host.trim()),
            );
            const primary = str(d.host).trim();
            return (
              <SortableDevice
                key={n}
                name={n}
                index={index}
                total={names.length}
                onMove={(offset) => move(n, offset)}
              >
                {(handle) => (
                  <>
                    <div className="flex items-start gap-3">
                      {handle}
                      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-foreground font-mono text-[13px] break-all">
                            {n}
                          </span>
                          {defaultDevice === n && <span className="monitor-chip">Default</span>}
                          <span className="monitor-chip">
                            {off ? "Off for MCP" : "Available to MCP"}
                          </span>
                          {!d.mac && hosts.length !== 1 && (
                            <span
                              className="monitor-chip"
                              aria-label={`${n}: ${hosts.length} configured management addresses`}
                            >
                              {hosts.length} address{hosts.length === 1 ? "" : "es"}
                            </span>
                          )}
                        </span>
                        <span className="text-muted-foreground flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
                          <span>
                            <span className="text-faint">Addresses </span>
                            <span
                              className="text-fg-secondary font-mono"
                              dir="ltr"
                              aria-label={`${n} management addresses`}
                            >
                              {d.mac
                                ? str(d.mac)
                                : hosts.length
                                  ? hosts
                                      .map((h) =>
                                        h === primary && hosts.length > 1 ? `${h} (primary)` : h,
                                      )
                                      .join(", ")
                                  : "No addresses configured"}
                            </span>
                          </span>
                          <span>
                            <span className="text-faint">Transport </span>
                            <span className="text-fg-secondary">{transportText(d)}</span>
                          </span>
                          <span>
                            <span className="text-faint">Login </span>
                            <span className="text-fg-secondary">{loginLine(d)}</span>
                          </span>
                          {d.description ? (
                            <span className="text-fg-secondary break-words">
                              {str(d.description)}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      <span className="mt-0.5 flex">
                        <MonitorSwitch
                          checked={!off}
                          label={`Available to MCP: ${n}`}
                          onChange={(c) => toggleDisabled(n, !c)}
                        />
                      </span>
                    </div>
                    <div className="dv-indent flex flex-wrap items-center gap-1.5">
                      {confirmDel === n ? (
                        <span className="dv-confirm" role="group" aria-label={`Remove ${n}?`}>
                          Remove {n}?
                          <MonitorButton
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirmDel(null)}
                          >
                            Cancel
                          </MonitorButton>
                          <MonitorButton
                            size="sm"
                            variant="danger"
                            aria-label={`Confirm removing ${n}`}
                            onClick={() => removeDevice(n)}
                          >
                            Remove
                          </MonitorButton>
                        </span>
                      ) : (
                        <>
                          <MonitorButton
                            size="sm"
                            variant="ghost"
                            aria-label={`Edit settings for ${n}`}
                            onClick={() => setSheet({ name: n, isNew: false })}
                          >
                            Edit settings
                          </MonitorButton>
                          <MonitorButton
                            size="sm"
                            variant="ghost"
                            disabled={!!tests[n]?.pending}
                            aria-label={`Test connection to ${n}`}
                            onClick={() => onTest(n)}
                          >
                            {tests[n]?.pending ? "Testing…" : "Test connection"}
                          </MonitorButton>
                          <MonitorButton
                            size="sm"
                            variant="ghost"
                            aria-label={`Copy ${n}`}
                            onClick={() => duplicate(n)}
                          >
                            Copy
                          </MonitorButton>
                          <MonitorButton
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            disabled={names.length === 1}
                            title={
                              names.length === 1
                                ? "Keep at least one router"
                                : "Remove from MCP. The router itself does not change."
                            }
                            aria-label={`Remove ${n}`}
                            onClick={() => setConfirmDel(n)}
                          >
                            Remove
                          </MonitorButton>
                        </>
                      )}
                    </div>
                    {test && (
                      <div
                        role="status"
                        className="dv-test"
                        data-tone={test.pending ? undefined : test.ok ? "good" : "bad"}
                      >
                        <StatusDot tone={test.pending ? "default" : test.ok ? "good" : "bad"} />
                        <span
                          className={cn(
                            "font-[510]",
                            test.pending
                              ? "text-muted-foreground"
                              : test.ok
                                ? "text-success"
                                : "text-destructive",
                          )}
                        >
                          {test.pending ? "Testing" : test.ok ? "Connected" : "Connection failed"}
                        </span>
                        <span className="text-fg-secondary min-w-0 break-words">{test.label}</span>
                        <span className="flex-1" />
                        {test.ok && (
                          <span className="text-muted-foreground">
                            Session and one read, not an ICMP ping
                          </span>
                        )}
                      </div>
                    )}
                  </>
                )}
              </SortableDevice>
            );
          })}
        </Reorder.Group>
      )}

      {editor}
    </div>
  );
}

// ── modules (inline management, editing cfg.tools) ───────────────────────────

interface ModuleItem {
  slug: string;
  label: string;
  group: string;
  description: string;
  toolCount: number;
}

function moduleEnabled(tools: Cfg, m: ModuleItem): boolean {
  const dm = arr(tools.disabledModules);
  const dg = arr(tools.disabledGroups);
  const em = arr(tools.enabledModules);
  const eg = arr(tools.enabledGroups);
  if (dm.includes(m.slug) || dg.includes(m.group)) return false;
  if (em.length === 0 && eg.length === 0) return true;
  return em.includes(m.slug) || eg.includes(m.group);
}

function ModulesCard({ cfg, onChange }: { cfg: Cfg; onChange: (c: Cfg) => void }): ReactNode {
  const [catalog, setCatalog] = useState<ModuleItem[] | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    void api<{ modules: ModuleItem[] }>("/api/modules")
      .then((d) => setCatalog(d.modules))
      .catch(() => setCatalog([]));
  }, []);

  const tools = asObj(cfg.tools);
  const toggle = (m: ModuleItem, enable: boolean): void => {
    const em = new Set(arr(tools.enabledModules));
    const dm = new Set(arr(tools.disabledModules));
    if (enable) {
      dm.delete(m.slug);
      if (arr(tools.enabledModules).length > 0 || arr(tools.enabledGroups).length > 0)
        em.add(m.slug);
    } else {
      em.delete(m.slug);
      dm.add(m.slug);
    }
    onChange({
      ...cfg,
      tools: { ...tools, enabledModules: uniq([...em]), disabledModules: uniq([...dm]) },
    });
  };

  const modules = (catalog ?? []).filter((m) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      m.label.toLowerCase().includes(q) ||
      m.slug.toLowerCase().includes(q) ||
      m.group.toLowerCase().includes(q)
    );
  });
  const groups = new Map<string, ModuleItem[]>();
  for (const m of modules) groups.set(m.group, [...(groups.get(m.group) ?? []), m]);
  const enabledCount = (catalog ?? []).filter((m) => moduleEnabled(tools, m)).length;

  return (
    <Card className="px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-lg leading-none" aria-hidden="true">
          🧩
        </span>
        <div className="min-w-0">
          <div className="text-foreground flex items-center gap-2 text-sm font-bold">
            Tool Modules
          </div>
          <div className="text-muted-foreground mt-0.5 max-w-[520px] truncate font-mono text-xs">
            {catalog ? `${enabledCount}/${catalog.length} modules enabled` : "loading…"} · applied
            on Save
          </div>
        </div>
        <span className="flex-1" />
        <Input
          placeholder="Filter modules…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-[190px]"
        />
        <label className="inline-flex items-center gap-1.5">
          <Switch
            checked={asObj(cfg.mcp).appViews === true}
            onCheckedChange={(c) => onChange({ ...cfg, mcp: { ...asObj(cfg.mcp), appViews: c } })}
            title="MCP App Views"
          />
          <span className="text-muted-foreground text-[11px]">App Views</span>
        </label>
      </div>
      <div className="mt-3 grid max-h-[440px] gap-[18px] overflow-auto">
        {[...groups.entries()].map(([group, items]) => (
          <div key={group} className="grid gap-2">
            <div className="text-muted-foreground mt-2 mb-0.5 font-bold text-[11px] tracking-[0.05em] uppercase">
              {group}
            </div>
            {items.map((m) => {
              const on = moduleEnabled(tools, m);
              return (
                <label
                  key={m.slug}
                  className={cn(
                    "bg-muted hover:border-brand/40 flex cursor-pointer items-start gap-2.5 rounded-md border px-[11px] py-[9px] transition-colors select-none",
                    on ? "border-brand/50 bg-brand/10" : "border-border",
                  )}
                  title={m.description}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggle(m, !on)}
                    className="accent-brand mt-0.5 cursor-pointer"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-foreground flex flex-wrap items-center gap-[7px] text-xs font-semibold">
                      {m.label}
                      <code className="text-muted-foreground bg-background border-border rounded border px-1.5 py-px font-mono text-[10px]">
                        {m.slug}
                      </code>
                    </span>
                    <span className="text-muted-foreground text-[11px] leading-[1.35]">
                      {m.description}
                    </span>
                  </span>
                  <span className="text-muted-foreground pt-px font-mono text-[10px] whitespace-nowrap">
                    {m.toolCount} tool{m.toolCount === 1 ? "" : "s"}
                  </span>
                </label>
              );
            })}
          </div>
        ))}
        {catalog && modules.length === 0 && (
          <span className="text-muted-foreground text-[11px]">No modules match “{query}”.</span>
        )}
      </div>
    </Card>
  );
}

// ── the form ─────────────────────────────────────────────────────────────────

export function ConfigForm({ cfg, onChange }: { cfg: Cfg; onChange: (c: Cfg) => void }): ReactNode {
  return (
    <div className="mt-1 grid min-w-0 grid-cols-1 gap-3.5">
      {CONFIG_SECTIONS.filter((s) => s.kind !== "deviceMap").map((s) =>
        s.id === "serviceProbes" ? (
          <ServiceProbesEditor key={s.id} cfg={cfg} onChange={onChange} />
        ) : s.kind === "modules" ? (
          <ModulesCard key={s.id} cfg={cfg} onChange={onChange} />
        ) : (
          <ObjectCard key={s.id} cfg={cfg} onChange={onChange} section={s} />
        ),
      )}
    </div>
  );
}
