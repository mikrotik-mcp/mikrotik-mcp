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
import { DeviceEditor } from "./device-editor";
import { NumberInput, SearchInput, SecretInput, Select, Switch, TextInput } from "./kit";
import { ServiceProbesEditor } from "./service-probes-editor";
import { CONFIG_SECTIONS, DEVICE_FIELDS } from "./config-spec";
import type { CfgField, CfgSection } from "./config-spec";
import {
  MonitorButton,
  MonitorEmpty,
  MonitorNote,
  MonitorSelect,
  MonitorSwitch,
  StatusBadge,
  StatusDot,
} from "./monitoring-ui";
import { Label } from "@/components/ui/label";
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
      <TextInput
        id={id}
        label={field.label}
        mono
        placeholder={field.placeholder}
        value={arr(value).join(", ")}
        onChange={(text) => {
          const items = text
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          onChange(items.length ? items : undefined);
        }}
      />
    );
  } else if (field.type === "bool") {
    control = (
      <Switch
        id={id}
        aria-label={field.label}
        checked={(value ?? field.defaultOn) === true}
        onCheckedChange={onChange}
      />
    );
  } else if (field.type === "select") {
    control = (
      <Select
        id={id}
        label={field.label}
        value={str(value ?? field.options?.[0] ?? "")}
        onChange={onChange}
        options={(field.options ?? []).map((o) => ({ value: o, label: o }))}
      />
    );
  } else if (field.type === "number") {
    control = (
      <NumberInput
        id={id}
        label={field.label}
        allowEmpty
        placeholder={field.placeholder}
        value={typeof value === "number" ? value : null}
        onChange={(n) => onChange(n ?? undefined)}
      />
    );
  } else if (field.type === "password") {
    control = (
      <SecretInput
        id={id}
        label={field.label}
        mono
        placeholder={field.secret && value === REDACTED ? "•••• unchanged" : field.placeholder}
        value={value == null ? "" : str(value)}
        onChange={onChange}
      />
    );
  } else {
    control = (
      <TextInput
        id={id}
        label={field.label}
        mono
        placeholder={field.secret && value === REDACTED ? "•••• unchanged" : field.placeholder}
        value={value == null ? "" : str(value)}
        onChange={onChange}
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

// ── server settings (Wks-Config board) ──────────────────────────────────────

/** One field of a server section, with "Changed from …" when it differs from the saved config. */
function ServerFieldRow({
  field,
  value,
  saved,
  onChange,
}: {
  field: CfgField;
  value: unknown;
  saved: unknown;
  onChange: (v: unknown) => void;
}): ReactNode {
  const id = `sf_${field.key.replace(/\./g, "_")}`;
  const changed = str(value) !== str(saved);
  const was =
    saved == null || saved === ""
      ? "unset"
      : typeof saved === "boolean"
        ? saved
          ? "on"
          : "off"
        : field.type === "list"
          ? arr(saved).join(", ") || "empty"
          : str(saved);
  const hint = [field.help, changed ? `Changed from ${was}.` : ""].filter(Boolean).join(" ");
  if (field.type === "bool")
    return (
      <div className="flex items-start gap-3 sm:col-span-2">
        <span className="mt-0.5">
          <MonitorSwitch
            checked={value === true}
            onChange={(v) => onChange(v)}
            label={field.label}
          />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <b className="text-[13px] font-semibold text-foreground">{field.label}</b>
          {hint && <span className="monitor-hint">{hint}</span>}
        </span>
      </div>
    );
  let control: ReactNode;
  if (field.type === "select") {
    control = (
      <MonitorSelect
        label={field.label}
        value={str(value ?? field.options?.[0] ?? "")}
        onChange={onChange}
        options={(field.options ?? []).map((o) => ({ value: o, label: o }))}
      />
    );
  } else if (field.type === "list") {
    control = (
      <TextInput
        id={id}
        label={field.label}
        mono
        wrapClassName={changed ? "config-changed" : undefined}
        placeholder={field.placeholder}
        value={arr(value).join(", ")}
        onChange={(text) => {
          const items = text
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          onChange(items.length ? items : undefined);
        }}
      />
    );
  } else if (field.type === "number") {
    control = (
      <NumberInput
        id={id}
        label={field.label}
        allowEmpty
        className={changed ? "config-changed" : undefined}
        placeholder={field.placeholder}
        value={typeof value === "number" ? value : null}
        onChange={(n) => onChange(n ?? undefined)}
      />
    );
  } else if (field.type === "password") {
    control = (
      <SecretInput
        id={id}
        label={field.label}
        mono
        wrapClassName={changed ? "config-changed" : undefined}
        placeholder={field.secret && value === REDACTED ? "•••• unchanged" : field.placeholder}
        value={value == null ? "" : str(value)}
        onChange={onChange}
      />
    );
  } else {
    control = (
      <TextInput
        id={id}
        label={field.label}
        mono
        wrapClassName={changed ? "config-changed" : undefined}
        placeholder={field.secret && value === REDACTED ? "•••• unchanged" : field.placeholder}
        value={value == null ? "" : str(value)}
        onChange={onChange}
      />
    );
  }
  return (
    <div className="monitor-fl config-fl-select">
      <label htmlFor={id} className="monitor-label flex items-center gap-2">
        {field.label}
        {field.secret && <span className="text-[10px] text-warning uppercase">secret</span>}
      </label>
      {control}
      {hint && <span className="monitor-hint">{hint}</span>}
    </div>
  );
}

function ServerFieldForm({
  fields,
  value,
  saved,
  onField,
}: {
  fields: CfgField[];
  value: Cfg;
  saved: Cfg;
  onField: (key: string, v: unknown) => void;
}): ReactNode {
  const [showAdv, setShowAdv] = useState(false);
  const basic = fields.filter((f) => !f.advanced);
  const adv = fields.filter((f) => f.advanced);
  const row = (f: CfgField): ReactNode => (
    <ServerFieldRow
      key={f.key}
      field={f}
      value={getIn(value, f.key)}
      saved={getIn(saved, f.key)}
      onChange={(v) => onField(f.key, v)}
    />
  );
  return (
    <div className="grid gap-3.5 sm:grid-cols-2">
      {basic.map(row)}
      {adv.length > 0 && (
        <>
          <button
            type="button"
            className="config-adv-toggle sm:col-span-2"
            aria-expanded={showAdv}
            onClick={() => setShowAdv((s) => !s)}
          >
            {showAdv ? (
              <ChevronDown aria-hidden="true" className="size-3" />
            ) : (
              <ChevronRight aria-hidden="true" className="size-3" />
            )}
            Advanced ({adv.length})
          </button>
          {showAdv && adv.map(row)}
        </>
      )}
    </div>
  );
}

/** How many fields (and the on/off switch) of a section differ from the saved config. */
function sectionEdits(cfg: Cfg, saved: Cfg, s: CfgSection): number {
  if (s.kind === "deviceMap") return 0;
  if (s.kind === "modules")
    return (
      Number(str(cfg.tools) !== str(saved.tools)) +
      Number(asObj(cfg.mcp).appViews !== asObj(saved.mcp).appViews)
    );
  if (s.id === "serviceProbes") return Number(str(cfg[s.path ?? ""]) !== str(saved[s.path ?? ""]));
  const a = sectionObj(cfg, s);
  const b = sectionObj(saved, s);
  let n = s.enable && isActive(cfg, s) !== isActive(saved, s) ? 1 : 0;
  for (const f of s.fields) if (str(getIn(a, f.key)) !== str(getIn(b, f.key))) n += 1;
  return n;
}

function SectionCard({
  cfg,
  saved,
  onChange,
  section,
  edits,
}: {
  cfg: Cfg;
  saved: Cfg;
  onChange: (c: Cfg) => void;
  section: CfgSection;
  edits: number;
}): ReactNode {
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
      }
      return;
    }
    onChange(setField(cfg, section, section.enable!.key ?? "enabled", on));
  };
  return (
    <section className="glass config-section" aria-label={section.title}>
      <div className="flex flex-wrap items-center gap-2">
        <b className="text-[15px] font-semibold text-foreground">{section.title}</b>
        {edits > 0 && (
          <StatusBadge tone="warn" dot={false}>
            {edits} edit{edits === 1 ? "" : "s"}
          </StatusBadge>
        )}
        <span className="flex-1" />
        {section.enable && (
          <MonitorSwitch
            checked={active}
            onChange={toggle}
            label={`${active ? "Deactivate" : "Activate"} ${section.enable.label ?? section.title}`}
          />
        )}
      </div>
      {active ? (
        <ServerFieldForm
          fields={section.fields}
          value={sectionObj(cfg, section)}
          saved={sectionObj(saved, section)}
          onField={(k, v) => onChange(setField(cfg, section, k, v))}
        />
      ) : (
        <MonitorNote>This section is turned off. Turn it on to edit its settings.</MonitorNote>
      )}
    </section>
  );
}

// ── tool modules section ─────────────────────────────────────────────────────

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

function ModulesCard({
  cfg,
  onChange,
  edits,
}: {
  cfg: Cfg;
  onChange: (c: Cfg) => void;
  edits: number;
}): ReactNode {
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
    <section className="glass config-section" aria-label="Tool Modules">
      <div className="flex flex-wrap items-center gap-2">
        <b className="text-[15px] font-semibold text-foreground">Tool Modules</b>
        {edits > 0 && (
          <StatusBadge tone="warn" dot={false}>
            {edits} edit{edits === 1 ? "" : "s"}
          </StatusBadge>
        )}
        <span className="flex-1" />
        <span className="monitor-label">App Views</span>
        <MonitorSwitch
          checked={asObj(cfg.mcp).appViews === true}
          onChange={(c) => onChange({ ...cfg, mcp: { ...asObj(cfg.mcp), appViews: c } })}
          label="MCP App Views"
        />
      </div>
      <p className="monitor-hint">
        {catalog ? `${enabledCount}/${catalog.length} modules on` : "Loading…"} · applied on Save
      </p>
      <SearchInput
        label="Filter modules"
        placeholder="Filter modules…"
        value={query}
        onChange={setQuery}
      />
      <div className="flex max-h-[440px] flex-col gap-3.5 overflow-auto">
        {[...groups.entries()].map(([group, items]) => (
          <div key={group} className="flex flex-col gap-2">
            <span className="monitor-label">{group}</span>
            {items.map((m) => {
              const on = moduleEnabled(tools, m);
              return (
                <label
                  key={m.slug}
                  className="config-module"
                  data-on={on || undefined}
                  title={m.description}
                >
                  <span className="mt-px">
                    <MonitorSwitch checked={on} onChange={() => toggle(m, !on)} label={m.label} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <b className="text-[13px] font-semibold text-foreground">{m.label}</b>
                      <span className="monitor-chip">{m.slug}</span>
                    </span>
                    <span className="monitor-hint">{m.description}</span>
                  </span>
                  <span className="font-mono text-xs whitespace-nowrap text-muted-foreground">
                    {m.toolCount} tool{m.toolCount === 1 ? "" : "s"}
                  </span>
                </label>
              );
            })}
          </div>
        ))}
        {catalog && modules.length === 0 && (
          <span className="monitor-hint">No modules match “{query}”.</span>
        )}
      </div>
    </section>
  );
}

// ── the form ─────────────────────────────────────────────────────────────────

/**
 * Server settings: a section list on the left, the chosen section's fields on
 * the right, and `below` (the diff) under them. `baseline` is the saved config,
 * for edit counts and "Changed from …" hints.
 */
export function ConfigForm({
  cfg,
  onChange,
  baseline,
  below,
}: {
  cfg: Cfg;
  onChange: (c: Cfg) => void;
  baseline?: Cfg;
  below?: ReactNode;
}): ReactNode {
  const saved = baseline ?? cfg;
  const [sel, setSel] = useState(
    () => CONFIG_SECTIONS.find((s) => s.kind !== "deviceMap")?.id ?? "",
  );
  const section = CONFIG_SECTIONS.find((s) => s.id === sel);
  const edits = new Map(CONFIG_SECTIONS.map((s) => [s.id, sectionEdits(cfg, saved, s)]));
  const ledTone = (s: CfgSection): "warn" | "good" | "default" =>
    (edits.get(s.id) ?? 0) > 0
      ? "warn"
      : s.kind === "deviceMap" || s.kind === "modules" || isActive(cfg, s)
        ? "good"
        : "default";
  return (
    <div className="config-form-grid">
      <nav className="config-nav" aria-label="Config sections">
        {CONFIG_SECTIONS.map((s) => {
          const n = edits.get(s.id) ?? 0;
          return (
            <button
              key={s.id}
              type="button"
              className="config-nav-item"
              aria-current={s.id === sel ? "true" : undefined}
              onClick={() => setSel(s.id)}
            >
              <StatusDot tone={ledTone(s)} />
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              {n > 0 && <span className="font-mono text-[11px] text-warning">{n}</span>}
            </button>
          );
        })}
      </nav>
      <div className="flex min-w-0 flex-col gap-3.5">
        {!section ? null : section.kind === "deviceMap" ? (
          <MonitorNote>
            Router connections, credentials and order are managed on the{" "}
            <a className="config-link" href="#devices">
              Devices page
            </a>
            . This editor only changes server settings.
          </MonitorNote>
        ) : section.id === "serviceProbes" ? (
          <ServiceProbesEditor cfg={cfg} onChange={onChange} />
        ) : section.kind === "modules" ? (
          <ModulesCard cfg={cfg} onChange={onChange} edits={edits.get(section.id) ?? 0} />
        ) : (
          <SectionCard
            key={section.id}
            cfg={cfg}
            saved={saved}
            onChange={onChange}
            section={section}
            edits={edits.get(section.id) ?? 0}
          />
        )}
        {below}
      </div>
    </div>
  );
}
