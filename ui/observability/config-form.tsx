/**
 * Interactive, schema-driven config form. Renders `CONFIG_SECTIONS` as cards; each
 * section card shows a summary + an active/deactivate toggle and opens an edit
 * Sheet with its fields. Devices are sub-cards with add/edit sheets. Everything
 * mutates ONE `cfg` object (lifted to `config-editor.tsx`), so the JSON view and
 * the safe-apply pipeline stay in sync automatically.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { api } from "./api";
import { Badge, Button, Card, Input, Note, Select } from "./geist";
import { Sheet } from "./sheet";
import { CONFIG_SECTIONS, DEVICE_FIELDS } from "./config-spec";
import type { CfgField, CfgSection } from "./config-spec";
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
const str = (v: unknown): string =>
  v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);

/** Read a possibly-dotted key (`channels.slack.url`) off an object. */
const getIn = (o: Cfg, key: string): unknown =>
  key.split(".").reduce<unknown>((acc, k) => asObj(acc)[k], o);

/**
 * Immutably write a possibly-dotted key. An empty value deletes the leaf, and a
 * parent left with no keys is deleted too — so clearing `channels.slack.url`
 * removes the whole `slack` channel rather than persisting `{}`, which the
 * schema would reject (`url` is required on a channel that exists).
 */
function setIn(o: Cfg, key: string, val: unknown): Cfg {
  const [head, ...rest] = key.split(".");
  const next = { ...o };
  if (rest.length === 0) {
    if (val === undefined || val === "") delete next[head];
    else next[head] = val;
    return next;
  }
  const child = setIn(asObj(next[head]), rest.join("."), val);
  if (Object.keys(child).length === 0) delete next[head];
  else next[head] = child;
  return next;
}

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

function DeviceSheet({
  cfg,
  onChange,
  name,
  isNew,
  onClose,
}: {
  cfg: Cfg;
  onChange: (c: Cfg) => void;
  name: string;
  isNew: boolean;
  onClose: () => void;
}): ReactNode {
  const [newName, setNewName] = useState(name);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const devices = asObj(cfg.devices);
  const dev = asObj(devices[name]);

  const setDev = (key: string, v: unknown): void => {
    onChange({ ...cfg, devices: { ...devices, [name]: setIn(dev, key, v) } });
  };

  // Rename the device key from `name` to the typed value. Returns false (and
  // sets an error) on an empty or already-taken name so the caller keeps the
  // sheet open instead of silently discarding the edit.
  const commitName = (): boolean => {
    const nn = newName.trim();
    if (nn === name) return true; // unchanged — nothing to rename
    if (!nn) {
      setNameErr("Name cannot be empty.");
      return false;
    }
    if (devices[nn]) {
      setNameErr(`A device named "${nn}" already exists.`);
      return false;
    }
    const nextDevices = { ...devices, [nn]: dev };
    delete nextDevices[name];
    onChange({ ...cfg, devices: nextDevices });
    return true;
  };

  // Done applies the typed name (creating the device under its real key for a
  // new entry) before closing.
  const done = (): void => {
    if (commitName()) onClose();
  };

  return (
    <Sheet
      title={isNew ? "Add device" : `Device · ${name}`}
      subtitle={isNew ? "New MikroTik router" : undefined}
      onClose={done}
      footer={
        <Button type="success" size="sm" onClick={done}>
          Done
        </Button>
      }
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor="dev_name" className="text-muted-foreground text-xs font-semibold">
          Name
        </Label>
        <div className="flex gap-1.5">
          <Input
            id="dev_name"
            value={newName}
            onChange={(e) => {
              setNewName(e.target.value);
              setNameErr(null);
            }}
            placeholder="core-router"
          />
          {!isNew && newName.trim() !== name && (
            <Button size="sm" ghost onClick={() => commitName()}>
              Rename
            </Button>
          )}
        </div>
        {nameErr && <span className="text-destructive text-[11px]">{nameErr}</span>}
      </div>
      <FieldForm fields={DEVICE_FIELDS} value={dev} onField={setDev} />
    </Sheet>
  );
}

function DevicesCard({ cfg, onChange }: { cfg: Cfg; onChange: (c: Cfg) => void }): ReactNode {
  const [sheet, setSheet] = useState<{ name: string; isNew: boolean } | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const devices = asObj(cfg.devices);
  const names = Object.keys(devices);
  const defaultDevice = str(cfg.defaultDevice);

  const addDevice = (): void => {
    const base = "device";
    let i = 1;
    let n = base;
    while (devices[n]) n = `${base}-${++i}`;
    onChange({
      ...cfg,
      devices: {
        ...devices,
        [n]: { host: "192.168.88.1", port: 22, username: "admin", password: "", timeoutMs: 10000 },
      },
    });
    setSheet({ name: n, isNew: true });
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

  return (
    <Card className="px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-lg leading-none" aria-hidden="true">
          🖧
        </span>
        <div className="min-w-0">
          <div className="text-foreground flex items-center gap-2 text-sm font-bold">Devices</div>
          <div className="text-muted-foreground mt-0.5 max-w-[520px] truncate font-mono text-xs">
            {names.length} device{names.length === 1 ? "" : "s"} · default: {defaultDevice || "—"}
          </div>
        </div>
        <span className="flex-1" />
        <label className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground text-[11px]">Default</span>
          <Select
            value={defaultDevice}
            onValueChange={(v) => onChange({ ...cfg, defaultDevice: v })}
            options={names.map((n) => ({ value: n, label: n }))}
          />
        </label>
        <Button size="sm" onClick={addDevice} icon={<Plus className="size-4" />}>
          Add device
        </Button>
      </div>

      <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
        {names.map((n) => {
          const d = asObj(devices[n]);
          const off = d.disabled === true;
          const addr = d.mac ? str(d.mac) : `${str(d.host) || "?"}:${str(d.port) || "22"}`;
          return (
            <div
              key={n}
              className={cn(
                "border-border bg-card hover:border-brand/40 flex flex-col gap-1.5 rounded-lg border px-[15px] py-3.5 transition-colors",
                off && "opacity-50 grayscale-[0.4]",
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "inline-block size-2 shrink-0 rounded-full",
                    off ? "bg-muted-foreground/60" : "bg-success",
                  )}
                />
                <span className="font-mono text-[13px] font-medium">{n}</span>
                {defaultDevice === n && <Badge type="accent">default</Badge>}
                <span className="flex-1" />
                <Switch
                  checked={!off}
                  onCheckedChange={(c) => toggleDisabled(n, !c)}
                  title={off ? "Enable device" : "Disable device"}
                />
              </div>
              <div className="text-muted-foreground font-mono text-[11px] break-words">{addr}</div>
              {d.description ? (
                <div className="text-muted-foreground font-mono text-[11px] break-words">
                  {str(d.description)}
                </div>
              ) : null}
              <div className="mt-auto flex gap-1.5 pt-1">
                <Button size="sm" ghost onClick={() => setSheet({ name: n, isNew: false })}>
                  Edit
                </Button>
                {confirmDel === n ? (
                  <Button size="sm" type="error" onClick={() => removeDevice(n)}>
                    Confirm?
                  </Button>
                ) : (
                  <Button size="sm" ghost type="error" onClick={() => setConfirmDel(n)}>
                    Remove
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        {names.length === 0 && (
          <Note type="secondary" label={false}>
            No devices yet. Click <b>Add device</b> to configure your first router.
          </Note>
        )}
      </div>

      {sheet && (
        <DeviceSheet
          cfg={cfg}
          onChange={onChange}
          name={sheet.name}
          isNew={sheet.isNew}
          onClose={() => setSheet(null)}
        />
      )}
    </Card>
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
    <div className="mt-1 grid gap-3.5">
      {CONFIG_SECTIONS.map((s) =>
        s.kind === "deviceMap" ? (
          <DevicesCard key={s.id} cfg={cfg} onChange={onChange} />
        ) : s.kind === "modules" ? (
          <ModulesCard key={s.id} cfg={cfg} onChange={onChange} />
        ) : (
          <ObjectCard key={s.id} cfg={cfg} onChange={onChange} section={s} />
        ),
      )}
    </div>
  );
}
