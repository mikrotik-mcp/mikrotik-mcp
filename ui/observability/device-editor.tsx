import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { CREDENTIAL_SOURCE, renameDevice, setDraftField } from "../../src/config-device-draft";
import type { SshKeyOption } from "../../src/observability/ssh-key-inventory";
import { api, postJson } from "./api";
import { testDeviceConnection } from "./config-connection";
import { DeviceJumpHost, jumpHostIssue } from "./device-jump-host";
import { DeviceAddressesEditor } from "./device-addresses";
import type { ConnectionResult } from "./config-connection";
import { clockTime } from "./device-card";
import {
  MonitorButton,
  MonitorDialog,
  MonitorSwitch,
  Segmented,
  StatusBadge,
} from "./monitoring-ui";
import { TagsInput } from "@/components/ui/tags-input";
import { cn } from "@/lib/utils";

type Draft = Record<string, unknown>;
const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const REDACTED = "«redacted»";
const STEPS = [
  ["Connection", "Where MCP finds the router"],
  ["Sign in", "Username and key or password"],
  ["Review & test", "Check it, then save"],
] as const;
const HEADINGS = ["Where is the router?", "How does MCP sign in?", "Check it, then save"];
const TRANSPORTS = [
  ["ssh", "SSH", "Port 22, the default"],
  ["rest", "REST + SSH", "HTTPS, falls back to SSH"],
  ["mac", "MAC-Telnet", "Same layer-2 network, no IP"],
] as const;

/** A label over a 36px input, with a hint or an error under it. */
function Field({
  label,
  optional,
  hint,
  error,
  className,
  children,
}: {
  label: string;
  optional?: boolean;
  hint?: ReactNode;
  error?: string;
  className?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <label className={cn("monitor-fl", className)}>
      <span className="monitor-label">
        {label}
        {optional && <span className="text-faint font-normal"> optional</span>}
      </span>
      {children}
      {error ? (
        <span role="alert" className="monitor-err">
          {error}
        </span>
      ) : hint ? (
        <span className="monitor-hint">{hint}</span>
      ) : null}
    </label>
  );
}

/** A secret field: stored values are never shown, new ones can be revealed. */
function SecretInput({
  label,
  value,
  optional,
  onChange,
}: {
  label: string;
  value: unknown;
  optional?: boolean;
  onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const stored = value === REDACTED;
  return (
    <div className="monitor-fl">
      <span className="monitor-label">
        {label}
        {optional && <span className="text-faint font-normal"> optional</span>}
      </span>
      <span className="monitor-input justify-between">
        <input
          aria-label={label}
          className="min-w-0 flex-1 bg-transparent font-mono outline-none"
          type={visible && !stored ? "text" : "password"}
          value={stored ? "" : text(value)}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="new-password"
          placeholder={stored ? "Stored securely · leave unchanged" : "Enter a secret"}
        />
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground text-[12px] disabled:opacity-40"
          aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
          aria-pressed={visible}
          disabled={stored}
          onClick={() => setVisible(!visible)}
        >
          {visible ? "Hide" : "Show"}
        </button>
      </span>
    </div>
  );
}

/** A button that opens the section under it, with a short summary on the right. */
function Disclosure({
  label,
  summary,
  defaultOpen = false,
  children,
}: {
  label: string;
  summary: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        className="dv-disclosure"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        <span className="flex-1">{label}</span>
        <span className="text-muted-foreground text-[12px]">{summary}</span>
      </button>
      {open && <div className="flex flex-col gap-3">{children}</div>}
    </div>
  );
}

function CopyKey({ text: value, name }: { text: string; name: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <MonitorButton
      size="sm"
      variant="ghost"
      aria-label={`Copy public key ${name}`}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied" : "Copy"}
    </MonitorButton>
  );
}

function KeyPicker({ value, onSelect }: { value: string; onSelect: (key: SshKeyOption) => void }) {
  const [data, setData] = useState<{ keys: SshKeyOption[]; warning?: string } | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [version, setVersion] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [created, setCreated] = useState<SshKeyOption | null>(null);
  const createInFlight = useRef(false);
  /** Create on the MCP host, then select only the path in this unsaved device draft. */
  async function createKey() {
    if (createInFlight.current) return;
    createInFlight.current = true;
    setCreating(true);
    setCreateError("");
    try {
      const result = await postJson<{ key?: SshKeyOption; error?: string }>(
        "/api/config/ssh-keys",
        { name: keyName.trim() },
      );
      if (!result.key) throw new Error(result.error || "Could not create the key.");
      const key = result.key;
      setCreated(key);
      setQuery("");
      setError("");
      setData((current) => ({
        ...current,
        keys: [key, ...(current?.keys ?? []).filter((item) => item.path !== key.path)],
      }));
      onSelect(key);
      setShowCreate(false);
      setKeyName("");
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Could not create the key.");
    } finally {
      setCreating(false);
      createInFlight.current = false;
    }
  }
  useEffect(() => {
    const abort = new AbortController();
    void api<{ keys: SshKeyOption[]; warning?: string }>("/api/config/ssh-keys", abort.signal)
      .then((result) => {
        if (!abort.signal.aborted) setData(result);
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError("Could not load public keys. Refresh, or enter a private key path below.");
      });
    return () => abort.abort();
  }, [version]);
  const keys =
    data?.keys.filter((key) =>
      `${key.name} ${key.path} ${key.type} ${key.fingerprint}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    ) ?? [];
  const pick = (key: SshKeyOption) => {
    if (key.usable) onSelect(key);
  };
  return (
    <div className="monitor-fl" aria-label="Public keys on this MCP host" role="group">
      <div className="flex items-center gap-2">
        <span className="monitor-label flex-1">Public keys on this MCP host</span>
        <MonitorButton
          size="sm"
          variant="ghost"
          aria-label="Refresh public keys"
          disabled={creating}
          onClick={() => {
            setData(null);
            setError("");
            setVersion(version + 1);
          }}
        >
          Refresh
        </MonitorButton>
        <MonitorButton
          size="sm"
          disabled={creating}
          aria-expanded={showCreate}
          icon={<Plus aria-hidden="true" />}
          onClick={() => {
            setShowCreate(!showCreate);
            setCreateError("");
          }}
        >
          Create key
        </MonitorButton>
      </div>
      {showCreate && (
        <div className="monitor-note flex-col" role="group" aria-label="Create SSH key">
          <div className="flex w-full items-center gap-2">
            <b className="text-foreground flex-1 font-[510]">New SSH key</b>
            <span className="monitor-chip">RSA · 3072 bit</span>
          </div>
          <Field label="Key name" className="w-full">
            <input
              id="ssh_create_name"
              className="monitor-input font-mono"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              disabled={creating}
              placeholder="mikrotik_home"
              autoComplete="off"
            />
          </Field>
          <p className="text-muted-foreground text-[12px]">
            Creates a key pair in the .ssh folder of the MCP host, with no passphrase so MCP can use
            it unattended. Only the owner can read the private file. Existing files are never
            replaced, and the files stay even if you cancel this router.
          </p>
          {createError && (
            <p role="alert" className="monitor-err">
              {createError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <MonitorButton
              size="sm"
              variant="inverse"
              disabled={creating || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(keyName.trim())}
              onClick={() => void createKey()}
            >
              {creating ? "Generating key…" : "Generate & select key"}
            </MonitorButton>
            <MonitorButton
              size="sm"
              variant="ghost"
              disabled={creating}
              onClick={() => setShowCreate(false)}
            >
              Cancel
            </MonitorButton>
          </div>
        </div>
      )}
      {created && (
        <div className="monitor-note flex-col" data-tone="warn" role="status">
          <b className="text-foreground font-[510]">Public key ready to import</b>
          <code className="w-full font-mono text-[11px] break-all">{created.fingerprint}</code>
          <textarea
            aria-label="Generated public key"
            readOnly
            value={created.publicKey}
            rows={3}
            className="monitor-input w-full resize-none font-mono"
          />
          <CopyKey text={created.publicKey} name={created.name} />
          <p className="text-muted-foreground text-[12px]">
            Save this as {created.name}.pub, upload it in WinBox under Files, then import it under
            System → Users → SSH Keys for the login user. Never upload the private file.
          </p>
          <p className="text-muted-foreground text-[12px]">
            Importing a key can turn off password SSH login for that user. Keep your current session
            open and test the key before you disconnect. Nothing on the router has changed.
          </p>
        </div>
      )}
      {data && data.keys.length > 3 && (
        <label className="monitor-field">
          <input
            type="search"
            aria-label="Search public keys"
            placeholder="Search name, path or fingerprint"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}
      <div
        role="listbox"
        aria-label="Available public keys"
        aria-busy={!data && !error}
        className="dv-keys"
      >
        {!data && !error && (
          <p role="status" className="text-muted-foreground px-3 py-2.5 text-[12px]">
            Reading public keys…
          </p>
        )}
        {error && (
          <p role="alert" className="monitor-err px-3 py-2.5">
            {error}
          </p>
        )}
        {data && !keys.length && (
          <p className="text-muted-foreground px-3 py-2.5 text-[12px]">
            {query
              ? "No matching public keys."
              : "No public keys yet. Create one above, or enter a private key path below."}
          </p>
        )}
        {keys.map((key) => {
          const selected = value === key.path;
          return (
            <div
              key={key.path}
              role="option"
              aria-selected={selected}
              aria-disabled={!key.usable}
              aria-label={`Use key ${key.name}`}
              tabIndex={key.usable ? 0 : -1}
              className="dv-key"
              onClick={() => pick(key)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  pick(key);
                }
              }}
            >
              <span className="dv-radio" aria-hidden="true" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <span className="text-foreground font-mono text-[13px]">{key.name}</span>
                  <span className="monitor-chip">{key.type}</span>
                </span>
                <span className="text-muted-foreground truncate font-mono text-[11px]">
                  {key.usable ? key.fingerprint : "No matching private key next to this file"}
                </span>
                <span
                  className={cn(
                    "truncate font-mono text-[11px]",
                    key.usable ? "text-muted-foreground" : "text-destructive",
                  )}
                >
                  {key.path}.pub
                </span>
              </span>
              <CopyKey text={key.publicKey} name={key.name} />
            </div>
          );
        })}
      </div>
      {data?.warning && (
        <p role="status" className="monitor-hint">
          {data.warning}
        </p>
      )}
      <span className="monitor-hint">
        Add the public key to the router user before you test. Keys with a broken file can't be
        picked.
      </span>
    </div>
  );
}

/** Local form state is committed to the shared safe-apply draft only on explicit acceptance. */
export function DeviceEditor({
  cfg,
  name,
  isNew,
  onApply,
  onSave,
  saveNotice,
  onCancel,
  advanced,
}: {
  cfg: Draft;
  name: string;
  isNew: boolean;
  onApply: (cfg: Draft) => void;
  onSave: (cfg: Draft) => Promise<boolean>;
  saveNotice: string;
  onCancel: () => void;
  advanced: (
    device: Draft,
    onField: (key: string, value: unknown) => void,
    transport: string,
  ) => ReactNode;
}) {
  const devices = cfg.devices as Record<string, Draft>;
  const initial = devices[name];
  const [dev, setDev] = useState(() => structuredClone(initial));
  const [newName, setNewName] = useState(name);
  const [step, setStep] = useState(0);
  const [transport, setTransport] = useState(initial.mac ? "mac" : initial.api ? "rest" : "ssh");
  const [auth, setAuth] = useState(initial.privateKey || initial.keyFilename ? "key" : "password");
  const [keySource, setKeySource] = useState(initial.privateKey ? "inline" : "file");
  const [keyMeta, setKeyMeta] = useState<SshKeyOption | null>(null);
  const [inlineVisible, setInlineVisible] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [discard, setDiscard] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const inFlight = useRef(false);
  const busy = saving || testing;
  const [test, setTest] = useState<(ConnectionResult & { snapshot: string; at: number }) | null>(
    null,
  );
  const content = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const toTop = () => content.current?.parentElement?.scrollTo?.({ top: 0 });
  const snapshot = JSON.stringify(dev);
  const currentTest = test?.snapshot === snapshot ? test : null;
  const dirty = newName !== name || snapshot !== JSON.stringify(initial);
  const setField = (key: string, value: unknown) => {
    setErrors({});
    setDiscard(false);
    setDev((current) => {
      const next = setDraftField(current, key, value);
      if (key === "keyFilename" && value !== current.keyFilename) delete next.keyPassphrase;
      return next;
    });
  };
  const changeTransport = (value: string) => {
    setTransport(value);
    setErrors({});
    setDev((current) => {
      const next: Draft = { ...current, api: value === "rest" };
      if (value !== "mac")
        for (const key of ["mac", "sourceMac", "macHost", "macPort"]) delete next[key];
      else delete next.fallbackHosts;
      return next;
    });
  };
  const changeAuth = (value: string) => {
    setAuth(value);
    setErrors({});
    if (value === "password")
      setDev(({ privateKey: _key, keyFilename: _file, keyPassphrase: _phrase, ...rest }) => rest);
  };
  const selectKeyFile = (key: SshKeyOption) => {
    setKeySource("file");
    setKeyMeta(key);
    setDev((current) => {
      if (current.keyFilename === key.path && !current.privateKey) return current;
      const { privateKey: _key, keyPassphrase: _phrase, ...rest } = current;
      return { ...rest, keyFilename: key.path };
    });
    setErrors({});
  };
  const validate = (through: number) => {
    const issues: Record<string, string> = {};
    const nn = newName.trim();
    if (!nn) issues.name = "Give this router a name.";
    else if (nn !== name && Object.hasOwn(devices, nn))
      issues.name = `A router named ${nn} already exists. Pick another name.`;
    if (transport === "mac") {
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(text(dev.mac)))
        issues.mac = "Enter a MAC address such as 48:A9:8A:C6:42:F7.";
    } else {
      const jumpIssue = jumpHostIssue(dev, devices, name);
      if (jumpIssue) issues.form = jumpIssue;
      if (!text(dev.host).trim() || /[\s/]/.test(text(dev.host)))
        issues.host = "Enter an IP address or hostname, without a URL or spaces.";
      const hosts = [
        text(dev.host),
        ...(Array.isArray(dev.fallbackHosts) ? dev.fallbackHosts : []),
      ];
      if (hosts.some((h) => typeof h !== "string" || !h.trim()))
        issues.host = "Enter every management address or remove the empty row.";
      else if (new Set(hosts.map((h) => h.toLowerCase())).size !== hosts.length)
        issues.host = "Each management address must be unique.";
      if (
        !Number.isInteger(Number(dev.port ?? 22)) ||
        Number(dev.port ?? 22) < 1 ||
        Number(dev.port ?? 22) > 65535
      )
        issues.port = "Use a port from 1 to 65535.";
    }
    if (through > 0) {
      if (!text(dev.username).trim()) issues.username = "Enter the RouterOS username.";
      if (transport !== "mac" && auth === "key") {
        if (keySource === "inline" && !text(dev.privateKey).trim())
          issues.privateKey = "Enter a private key or choose a key file.";
        if (
          keySource === "file" &&
          (!text(dev.keyFilename).trim() || text(dev.keyFilename).trim().endsWith(".pub"))
        )
          issues.keyFilename = "Use the private key path, not the .pub file.";
      }
    }
    setErrors(issues);
    return !Object.keys(issues).length;
  };
  const go = (next: number) => {
    if (inFlight.current) return;
    if (next > step && !validate(next - 1)) return;
    setStep(next);
    setDiscard(false);
    toTop();
  };
  const close = () => {
    if (!inFlight.current) dirty ? setDiscard(true) : onCancel();
  };
  const apply = async (connectAndSave = false) => {
    if (inFlight.current || !validate(2)) return;
    inFlight.current = true;
    setSaving(true);
    if (connectAndSave) setTest(null);
    try {
      const next = renameDevice(
        { ...cfg, devices: { ...devices, [name]: dev } },
        name,
        newName.trim(),
      );
      const result = await postJson<{
        ok: boolean;
        errors?: { path: string; message: string }[];
        error?: string;
      }>("/api/config/validate?scope=devices", next);
      if (!mounted.current) return;
      if (!result.ok) {
        setErrors({
          form:
            result.errors?.map((e) => `${e.path}: ${e.message}`).join(" · ") ||
            result.error ||
            "Validation unavailable. Try again.",
        });
        return;
      }
      if (!connectAndSave) {
        onApply(next);
        return;
      }
      setStep(2);
      toTop();
      setTesting(true);
      const connection = await testDeviceConnection(
        newName.trim(),
        (next.devices as Record<string, Draft>)[newName.trim()],
        next.devices,
      );
      if (!mounted.current) return;
      setTesting(false);
      setTest({ ...connection, snapshot, at: Date.now() });
      if (!connection.ok) return;
      if (!(await onSave(next)) && mounted.current)
        setErrors({
          form: "The connection worked, but the save was not confirmed. Check the saved routers before you try again. Your form is still here.",
        });
    } catch {
      if (mounted.current)
        setErrors({
          form: connectAndSave
            ? "Connect & save did not finish. Check the saved routers before you try again."
            : "Could not validate the draft. Nothing was saved. Try again.",
        });
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setSaving(false);
        setTesting(false);
      }
    }
  };
  const probe = async () => {
    if (inFlight.current || !validate(2)) return;
    inFlight.current = true;
    setTesting(true);
    setTest(null);
    setStep(2);
    toTop();
    const result = await testDeviceConnection(name, dev, { ...devices, [name]: dev });
    inFlight.current = false;
    if (mounted.current) {
      setTest({ ...result, snapshot, at: Date.now() });
      setTesting(false);
    }
  };
  const input = (key: string, placeholder = "", type = "text", mono = true) => (
    <input
      id={key === "name" ? "dev_name" : `f_${key}`}
      className={cn("monitor-input", mono ? "font-mono" : "tabular-nums")}
      placeholder={placeholder}
      type={type}
      value={key === "name" ? newName : text(dev[key])}
      aria-invalid={errors[key] ? true : undefined}
      autoComplete="off"
      spellCheck={false}
      onChange={(e) => {
        const value = e.target.value;
        if (key === "name") {
          setNewName(value);
          setErrors({});
        } else setField(key, type === "number" && value ? Number(value) : value);
      }}
    />
  );

  const hosts = [text(dev.host), ...(Array.isArray(dev.fallbackHosts) ? dev.fallbackHosts : [])];
  const port = text(dev.port) || "22";
  const address =
    transport === "mac" ? text(dev.mac) : `${text(dev.host) || "Router address"}:${port}`;
  const via = dev.jumpVia ? text(dev.jumpVia) : dev.jumpHost ? "a bastion" : "";
  const route =
    transport === "mac"
      ? "Local network · MAC-Telnet"
      : `Encrypted transport${via ? ` · via ${via}` : ""}`;
  const timeout = Number(dev.timeoutMs ?? 10000) / 1000;
  const signIn =
    transport === "mac" || auth === "password"
      ? "Password"
      : keySource === "inline"
        ? "Inline SSH key"
        : keyMeta && keyMeta.path === text(dev.keyFilename)
          ? `SSH key · ${keyMeta.name} (${keyMeta.type})`
          : "SSH key file";
  const result = testing
    ? {
        tone: "default",
        title: "Connecting to your router…",
        text: "Read-only connection check. No settings are applied.",
      }
    : currentTest
      ? {
          tone: currentTest.ok ? "good" : "bad",
          title: currentTest.ok ? "Connection verified" : "Connection could not be verified",
          text: currentTest.label,
        }
      : {
          tone: "default",
          title: "Not tested yet",
          text: test
            ? "Settings changed. Test again to check this draft."
            : "A test is optional. You can save a router that is offline too.",
        };

  // Field errors show under their field; the rest (and those on another step) go here.
  const shownHere: string[] =
    step === 0
      ? ["name", "mac", "host", "port"]
      : step === 1
        ? ["username", "privateKey", "keyFilename"]
        : [];
  const elsewhere = Object.entries(errors).filter(([key]) => !shownHere.includes(key));

  const footer = discard ? (
    <>
      <span role="alert" className="text-foreground flex-1 text-[13px]">
        Discard the changes in this form?
      </span>
      <MonitorButton size="sm" variant="ghost" onClick={() => setDiscard(false)}>
        Keep editing
      </MonitorButton>
      <MonitorButton size="sm" variant="danger" onClick={onCancel}>
        Discard form
      </MonitorButton>
    </>
  ) : (
    <>
      <MonitorButton size="sm" disabled={busy} onClick={close}>
        Cancel
      </MonitorButton>
      <span className="dv-foot-hint text-muted-foreground flex-1 text-[12px]">
        Draft only · not applied
      </span>
      {step > 0 && (
        <MonitorButton size="sm" variant="ghost" disabled={busy} onClick={() => go(step - 1)}>
          Back
        </MonitorButton>
      )}
      {step < 2 ? (
        <MonitorButton size="sm" variant="inverse" disabled={busy} onClick={() => go(step + 1)}>
          Continue
        </MonitorButton>
      ) : (
        <>
          <MonitorButton size="sm" disabled={busy} onClick={() => void probe()}>
            {testing && !saving ? "Testing…" : "Test connection"}
          </MonitorButton>
          <MonitorButton size="sm" disabled={busy} onClick={() => void apply()}>
            {isNew ? "Add to draft" : "Update draft"}
          </MonitorButton>
          <MonitorButton
            size="sm"
            variant="inverse"
            disabled={busy}
            onClick={() => void apply(true)}
          >
            {saving ? "Saving…" : "Connect & save"}
          </MonitorButton>
        </>
      )}
    </>
  );

  return (
    <MonitorDialog
      open
      onOpenChange={(open) => {
        if (open) return;
        // An open picker takes Escape first; it must not also close the form.
        const active = document.activeElement;
        if (
          active instanceof HTMLElement &&
          active.getAttribute("role") === "combobox" &&
          active.getAttribute("aria-expanded") === "true"
        )
          return;
        close();
      }}
      eyebrow={`Router setup · ${isNew ? "new" : "edit"} connection`}
      title={isNew ? "Add a router" : `Edit ${name}`}
      description="Set how MCP connects, test it, then save it to your draft."
      width={880}
      dismissible={false}
      closeDisabled={busy}
      footer={footer}
    >
      <div ref={content} className="dv-ed">
        <div className="dv-ed-side">
          <nav aria-label="Steps" className="flex flex-col gap-1">
            {STEPS.map(([label, sub], index) => (
              <button
                type="button"
                key={label}
                className="dv-step"
                disabled={busy}
                aria-current={step === index ? "step" : undefined}
                data-done={index < step || undefined}
                onClick={() => go(index)}
              >
                <span className="dv-step-n" aria-hidden="true">
                  {index < step ? <Check /> : `0${index + 1}`}
                </span>
                <span className="flex flex-col">
                  <span className="dv-step-label">{label}</span>
                  <span className="dv-step-sub text-muted-foreground text-[12px] leading-4">
                    {sub}
                  </span>
                </span>
              </button>
            ))}
          </nav>
          <div className="dv-route" aria-label="Connection preview">
            <span className="monitor-label">Connection</span>
            <span className="flex flex-col gap-0.5 text-[12px]">
              <span className="text-foreground">MCP host</span>
              <span className="text-muted-foreground">Credentials stay here</span>
            </span>
            <span className="text-muted-foreground flex items-center gap-1.5 pl-0.5 text-[12px]">
              <span className="bg-input h-3.5 w-px" />
              {route}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5 text-[12px]">
              <span className="text-foreground truncate font-mono">
                {newName.trim() || "New router"}
              </span>
              <span className="text-muted-foreground truncate font-mono">{address}</span>
            </span>
          </div>
          <p className="text-muted-foreground text-[12px] leading-4">
            This sets how MCP reaches the router. Nothing on the router changes.
          </p>
        </div>
        <fieldset disabled={busy} className="dv-ed-body">
          <h3 className="text-foreground text-[15px] font-[590]">{HEADINGS[step]}</h3>
          {step === 0 && (
            <>
              <div className="dv-grid-2">
                <Field label="Device name" error={errors.name}>
                  {input("name", "home-router")}
                </Field>
                <Field label="Description" optional>
                  {input("description", "Home · hAP ax³", "text", false)}
                </Field>
              </div>
              <div className="monitor-fl">
                <span className="monitor-label">How MCP connects</span>
                <div role="radiogroup" aria-label="Transport" className="dv-grid-3">
                  {TRANSPORTS.map(([value, label, hint]) => (
                    <button
                      type="button"
                      key={value}
                      role="radio"
                      aria-checked={transport === value}
                      aria-label={label}
                      className="monitor-choice"
                      onClick={() => changeTransport(value)}
                    >
                      <span className="font-[510]">{label}</span>
                      <small>{hint}</small>
                    </button>
                  ))}
                </div>
              </div>
              {transport === "mac" ? (
                <Field label="MAC address" error={errors.mac}>
                  {input("mac", "48:A9:8A:C6:42:F7")}
                </Field>
              ) : (
                <div className="monitor-fl">
                  <div className="flex items-center gap-2">
                    <span className="monitor-label flex-1">Management addresses</span>
                    <span className="monitor-chip">Automatic failover</span>
                  </div>
                  <DeviceAddressesEditor
                    host={text(dev.host)}
                    fallbackHosts={Array.isArray(dev.fallbackHosts) ? dev.fallbackHosts : []}
                    invalid={!!errors.host}
                    onChange={(host, fallbackHosts) => {
                      setDev(({ fallbackHosts: _old, ...current }) => ({
                        ...current,
                        host,
                        ...(fallbackHosts.length ? { fallbackHosts } : {}),
                      }));
                      setErrors({});
                      setDiscard(false);
                    }}
                  />
                  {errors.host && (
                    <span role="alert" className="monitor-err">
                      {errors.host}
                    </span>
                  )}
                </div>
              )}
              <div className={transport === "mac" ? undefined : "dv-grid-port"}>
                {transport !== "mac" && (
                  <Field label="SSH port" error={errors.port}>
                    {input("port", "22", "number", false)}
                  </Field>
                )}
                <div className="dv-tags">
                  <TagsInput
                    value={Array.isArray(dev.tags) ? dev.tags : []}
                    suggestions={Object.values(devices).flatMap((device) =>
                      Array.isArray(device.tags) ? device.tags : [],
                    )}
                    onValueChange={(tags) => setField("tags", tags)}
                    disabled={busy}
                  />
                </div>
              </div>
              {transport !== "mac" && (
                <DeviceJumpHost
                  device={dev}
                  devices={devices}
                  name={name}
                  disabled={busy}
                  onChange={(next) => {
                    setDev(next);
                    setErrors({});
                    setDiscard(false);
                  }}
                />
              )}
              <Disclosure label="Connection options" summary={`Timeout ${timeout} s`}>
                {advanced(dev, setField, transport)}
              </Disclosure>
              <div className="flex items-start gap-3">
                <span className="flex flex-1 flex-col">
                  <span className="text-foreground text-[13px]">Available to MCP</span>
                  <span className="text-muted-foreground text-[12px]">
                    Turn off to keep the router in your list without tool access.
                  </span>
                </span>
                <MonitorSwitch
                  checked={dev.disabled !== true}
                  label="Available to MCP"
                  onChange={(value) => setField("disabled", !value)}
                />
              </div>
            </>
          )}
          {step === 1 && (
            <>
              <Field label="Username" className="max-w-80" error={errors.username}>
                {input("username", "admin")}
              </Field>
              {transport !== "mac" && (
                <div className="monitor-fl">
                  <span className="monitor-label">Sign in with</span>
                  <Segmented
                    className="self-start"
                    label="Sign in with"
                    value={auth}
                    options={[
                      { value: "password", label: "Password" },
                      { value: "key", label: "SSH key" },
                    ]}
                    onChange={changeAuth}
                  />
                </div>
              )}
              {typeof dev[CREDENTIAL_SOURCE] === "string" && (
                <div className="monitor-note">
                  <span>
                    <b className="text-foreground font-[510]">Copied credentials.</b> Secrets you
                    leave unchanged come from {text(dev[CREDENTIAL_SOURCE])}.
                  </span>
                </div>
              )}
              {transport !== "mac" && auth === "key" ? (
                <>
                  <KeyPicker
                    value={keySource === "file" ? text(dev.keyFilename) : ""}
                    onSelect={selectKeyFile}
                  />
                  {keySource === "file" ? (
                    <div className="dv-grid-key">
                      <Field
                        label="Private key path"
                        hint="The private file, not the .pub one."
                        error={errors.keyFilename}
                      >
                        {input("keyFilename", "~/.ssh/id_ed25519")}
                      </Field>
                      <SecretInput
                        label="Key passphrase"
                        optional
                        value={dev.keyPassphrase}
                        onChange={(value) => setField("keyPassphrase", value)}
                      />
                    </div>
                  ) : (
                    <div className="monitor-fl">
                      <div className="flex items-center gap-2">
                        <span className="monitor-label flex-1">Inline private key</span>
                        <MonitorButton
                          size="sm"
                          variant="ghost"
                          onClick={() => setInlineVisible(!inlineVisible)}
                        >
                          {inlineVisible ? "Hide key" : "Edit key"}
                        </MonitorButton>
                      </div>
                      {inlineVisible ? (
                        <textarea
                          aria-label="Inline private key"
                          className="monitor-input font-mono"
                          aria-invalid={errors.privateKey ? true : undefined}
                          value={dev.privateKey === REDACTED ? "" : text(dev.privateKey)}
                          placeholder={
                            dev.privateKey === REDACTED
                              ? "The stored key stays until you paste a new one"
                              : "Paste a PEM or OpenSSH private key"
                          }
                          onChange={(event) => setField("privateKey", event.target.value)}
                          spellCheck={false}
                        />
                      ) : (
                        <span className="monitor-hint">
                          {dev.privateKey
                            ? "The private key is hidden."
                            : "Choose Edit key to paste one."}
                        </span>
                      )}
                      {errors.privateKey && (
                        <span role="alert" className="monitor-err">
                          {errors.privateKey}
                        </span>
                      )}
                      <SecretInput
                        label="Key passphrase"
                        optional
                        value={dev.keyPassphrase}
                        onChange={(value) => setField("keyPassphrase", value)}
                      />
                    </div>
                  )}
                  <MonitorButton
                    size="sm"
                    variant="ghost"
                    className="self-start pl-0"
                    onClick={() => {
                      setKeySource(keySource === "file" ? "inline" : "file");
                      setDev(
                        ({
                          privateKey: _key,
                          keyFilename: _file,
                          keyPassphrase: _phrase,
                          ...rest
                        }) => rest,
                      );
                      setInlineVisible(true);
                    }}
                  >
                    {keySource === "file"
                      ? "Paste a private key instead"
                      : "Use a key file instead"}
                  </MonitorButton>
                  <Disclosure
                    label="Password fallback"
                    summary={transport === "rest" ? "Needed for REST" : "Optional for SSH"}
                    defaultOpen={transport === "rest"}
                  >
                    <SecretInput
                      label="Password"
                      value={dev.password}
                      onChange={(value) => setField("password", value)}
                    />
                  </Disclosure>
                </>
              ) : (
                <>
                  <SecretInput
                    label="Password"
                    value={dev.password}
                    onChange={(value) => setField("password", value)}
                  />
                  <span className="monitor-hint">
                    Stored passwords are never shown. Leave the field empty to keep the current one.
                    A blank password works for first setup.
                  </span>
                </>
              )}
            </>
          )}
          {step === 2 && (
            <>
              <div className="dv-review">
                <div className="border-border flex items-center gap-2.5 border-b px-4 py-3.5">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-emphasis truncate font-mono text-[14px]">
                      {newName.trim()}
                    </span>
                    {text(dev.description) && (
                      <span className="text-muted-foreground truncate text-[12px]">
                        {text(dev.description)}
                      </span>
                    )}
                  </span>
                  <StatusBadge tone={dev.disabled ? "default" : "good"}>
                    {dev.disabled ? "Off for MCP" : "Ready for draft"}
                  </StatusBadge>
                </div>
                <dl className="monitor-facts dv-review-facts px-4 py-3.5">
                  {transport === "mac" ? (
                    <>
                      <dt>MAC address</dt>
                      <dd className="font-mono text-[12px]">{text(dev.mac)}</dd>
                    </>
                  ) : (
                    <>
                      <dt>Address priority</dt>
                      <dd className="font-mono text-[12px]">{hosts.join(" → ")}</dd>
                    </>
                  )}
                  <dt>Connection</dt>
                  <dd>
                    {transport === "mac"
                      ? "MAC-Telnet"
                      : `${transport === "rest" ? "REST + SSH" : "SSH"}, port ${port}${via ? `, via ${via}` : ""}`}
                  </dd>
                  <dt>Username</dt>
                  <dd className="font-mono text-[12px]">{text(dev.username)}</dd>
                  <dt>Sign in</dt>
                  <dd>{signIn}</dd>
                  <dt>Timeout</dt>
                  <dd>{timeout} s</dd>
                  {dev.keyFilename && auth === "key" ? (
                    <>
                      <dt>Private key path</dt>
                      <dd className="font-mono text-[12px]">{text(dev.keyFilename)}</dd>
                    </>
                  ) : null}
                </dl>
              </div>
              <div
                role="status"
                className="monitor-note dv-result items-center"
                data-result={result.tone}
              >
                {result.tone !== "default" && (
                  <span className="dv-result-icon" aria-hidden="true">
                    {result.tone === "bad" ? <X /> : <Check />}
                  </span>
                )}
                <span className="flex flex-1 flex-col">
                  <span className="text-foreground font-[510]">{result.title}</span>
                  <span className="text-muted-foreground text-[12px]">{result.text}</span>
                </span>
                {currentTest && (
                  <span className="text-muted-foreground text-[12px]">
                    Tested {clockTime(currentTest.at)}
                  </span>
                )}
              </div>
              <p className="text-muted-foreground text-[12px]">
                The test opens a session and runs one read. It isn't an ICMP ping.
              </p>
              <div className="monitor-note">
                <span className="text-fg-secondary flex-1">
                  <b className="text-foreground font-[510]">Nothing saved yet.</b>{" "}
                  {isNew ? "Add to draft" : "Update draft"} keeps it in Manage routers until you
                  save there. {saveNotice}
                </span>
              </div>
            </>
          )}
          {elsewhere.length > 0 && (
            <div role="alert" className="monitor-note flex-col" data-tone="bad">
              {elsewhere.map(([key, message]) => (
                <span key={key}>{message}</span>
              ))}
            </div>
          )}
        </fieldset>
      </div>
    </MonitorDialog>
  );
}
