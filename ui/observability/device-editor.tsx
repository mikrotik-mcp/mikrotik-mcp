import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  Fingerprint,
  KeyRound,
  Laptop,
  LockKeyhole,
  Network,
  PlugZap,
  Router,
  ShieldCheck,
  X,
} from "lucide-react";
import { CREDENTIAL_SOURCE, renameDevice, setDraftField } from "../../src/config-device-draft";
import type { SshKeyOption } from "../../src/observability/ssh-key-inventory";
import { api, postJson } from "./api";
import { CopyButton } from "./atoms";
import { testDeviceConnection } from "./config-connection";
import type { ConnectionResult } from "./config-connection";
import { Badge, Button, Note } from "./geist";
import { Input } from "@/components/beui/registry/components/motion/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import "./device-editor.css";

type Draft = Record<string, unknown>;
const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const REDACTED = "«redacted»";
const steps = ["Connection", "Authentication", "Review & test"];

function SecretInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const stored = value === REDACTED;
  return (
    <Input
      label={label}
      type={visible && !stored ? "text" : "password"}
      value={stored ? "" : text(value)}
      onChange={onChange}
      autoComplete="new-password"
      placeholder={stored ? "Stored securely · leave unchanged" : "Enter a secret"}
      classNames={{ field: "rounded-xl", input: "font-mono text-sm" }}
      rightIcon={
        <button
          type="button"
          aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
          aria-pressed={visible}
          disabled={stored}
          onClick={() => setVisible(!visible)}
          className="rounded p-1 disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-ring"
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      }
    />
  );
}

function KeyPicker({ value, onSelect }: { value: string; onSelect: (key: SshKeyOption) => void }) {
  const [data, setData] = useState<{ keys: SshKeyOption[]; warning?: string } | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void api<{ keys: SshKeyOption[]; warning?: string }>("/api/config/ssh-keys", abort.signal)
      .then((result) => {
        if (!abort.signal.aborted) setData(result);
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError("Could not load public keys. Retry or enter a private-key path below.");
      });
    return () => abort.abort();
  }, [version]);
  const keys =
    data?.keys.filter((key) =>
      `${key.name} ${key.path} ${key.type} ${key.fingerprint}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    ) ?? [];
  return (
    <section className="device-key-picker" aria-label="Quick public key selection">
      <div className="device-editor__section-heading">
        <span>
          <Fingerprint size={17} /> Public keys on this MCP host
        </span>
        <Button
          size="sm"
          ghost
          aria-label="Refresh public keys"
          onClick={() => {
            setData(null);
            setError("");
            setVersion(version + 1);
          }}
        >
          Refresh
        </Button>
      </div>
      <p>
        Select a public identity to use its companion private-key file. Private key contents never
        leave the server.
      </p>
      {data && data.keys.length > 3 && (
        <Input
          aria-label="Search public keys"
          placeholder="Search name, path or fingerprint…"
          value={query}
          onChange={setQuery}
          classNames={{ field: "h-9 rounded-lg" }}
        />
      )}
      <ScrollArea
        className="device-key-picker__scroll"
        viewportProps={{
          className: "device-editor__viewport device-key-picker__viewport",
          "aria-label": "Available public keys",
        }}
      >
        <div className="device-key-picker__list" aria-busy={!data && !error}>
          {!data && !error && <p role="status">Reading public keys…</p>}
          {error && <p role="alert">{error}</p>}
          {data && !keys.length && (
            <p>
              {query
                ? "No matching public keys."
                : "No public keys found. Add a .pub companion in the server’s .ssh folder, or enter a private-key path below."}
            </p>
          )}
          {keys.map((key) => (
            <div className="device-key" key={key.path} data-selected={value === key.path}>
              <button
                type="button"
                aria-label={`Use key ${key.name}`}
                aria-pressed={value === key.path}
                disabled={!key.usable}
                onClick={() => onSelect(key)}
              >
                <span className="device-key__icon">
                  {value === key.path ? <Check size={18} /> : <KeyRound size={18} />}
                </span>
                <span className="device-key__identity">
                  <strong>
                    {key.name} <small>{key.type}</small>
                  </strong>
                  <code>{key.fingerprint}</code>
                  <small>{key.path}</small>
                  {!key.usable && (
                    <small className="text-warning">No readable companion private-key file</small>
                  )}
                </span>
              </button>
              <CopyButton text={key.publicKey} icon title={`Copy public key ${key.name}`} />
            </div>
          ))}
        </div>
      </ScrollArea>
      {data?.warning && <p role="status">{data.warning}</p>}
      <p className="device-editor__caption">
        The public key must already be authorized for this router’s username. Selecting it does not
        install it.
      </p>
    </section>
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
  const [inlineVisible, setInlineVisible] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [discard, setDiscard] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const inFlight = useRef(false);
  const busy = saving || testing;
  const [test, setTest] = useState<(ConnectionResult & { snapshot: string }) | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
      return next;
    });
  };
  const changeAuth = (value: string) => {
    setAuth(value);
    setErrors({});
    if (value === "password")
      setDev(({ privateKey: _key, keyFilename: _file, keyPassphrase: _phrase, ...rest }) => rest);
  };
  const selectKeyFile = (path: string) => {
    setKeySource("file");
    setDev((current) => {
      if (current.keyFilename === path && !current.privateKey) return current;
      const { privateKey: _key, keyPassphrase: _phrase, ...rest } = current;
      return { ...rest, keyFilename: path };
    });
    setErrors({});
  };
  const validate = (through: number) => {
    const issues: Record<string, string> = {};
    const nn = newName.trim();
    if (!nn) issues.name = "Give this router a name.";
    else if (nn !== name && Object.hasOwn(devices, nn))
      issues.name = "A router with this name already exists.";
    if (transport === "mac") {
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(text(dev.mac)))
        issues.mac = "Enter a MAC address such as 48:A9:8A:C6:42:F7.";
    } else {
      if (!text(dev.host).trim() || /[\s/]/.test(text(dev.host)))
        issues.host = "Enter an IP address or hostname, without a URL or spaces.";
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
          issues.keyFilename = "Use the private-key path, not the .pub file.";
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
    content.current?.scrollTo({ top: 0 });
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
      content.current?.scrollTo({ top: 0 });
      setTesting(true);
      const connection = await testDeviceConnection(
        newName.trim(),
        (next.devices as Record<string, Draft>)[newName.trim()],
        next.devices,
      );
      if (!mounted.current) return;
      setTesting(false);
      setTest({ ...connection, snapshot });
      if (!connection.ok) return;
      if (!(await onSave(next)) && mounted.current)
        setErrors({
          form: "Connection succeeded, but saving was not confirmed. Check the saved devices before trying again; your form is still here.",
        });
    } catch {
      if (mounted.current)
        setErrors({
          form: connectAndSave
            ? "Connect & Save could not be completed. Check the saved devices before trying again."
            : "Could not validate the draft. Nothing has been saved. Try again.",
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
    content.current?.scrollTo({ top: 0 });
    const result = await testDeviceConnection(name, dev, { ...devices, [name]: dev });
    inFlight.current = false;
    if (mounted.current) {
      setTest({ ...result, snapshot });
      setTesting(false);
    }
  };
  const field = (key: string, label: string, placeholder = "", type = "text") => (
    <Input
      id={key === "name" ? "dev_name" : `f_${key}`}
      label={label}
      placeholder={placeholder}
      type={type}
      value={
        key === "name"
          ? newName
          : key === "tags" && Array.isArray(dev.tags)
            ? dev.tags.join(", ")
            : text(dev[key])
      }
      error={errors[key]}
      autoComplete="off"
      onChange={(value) =>
        key === "name"
          ? (setNewName(value), setErrors({}))
          : setField(
              key,
              key === "tags"
                ? value
                    .split(",")
                    .map((tag) => tag.trim())
                    .filter(Boolean)
                : type === "number" && value
                  ? Number(value)
                  : value,
            )
      }
      classNames={{ field: "rounded-xl", input: "text-sm" }}
    />
  );
  const address =
    transport === "mac"
      ? text(dev.mac)
      : `${text(dev.host) || "Router address"}:${text(dev.port) || "22"}`;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="device-editor"
        showCloseButton={false}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          // Let an open picker consume Escape before the modal asks to discard the draft.
          const target = event.target;
          if (
            target instanceof HTMLElement &&
            target.getAttribute("role") === "combobox" &&
            target.getAttribute("aria-expanded") === "true"
          )
            event.preventDefault();
        }}
      >
        <header className="device-editor__header">
          <span className="device-editor__emblem">
            <Router size={24} strokeWidth={1.5} />
          </span>
          <div>
            <span className="device-editor__eyebrow">
              ROUTER SETUP / {isNew ? "NEW CONNECTION" : "EDIT CONNECTION"}
            </span>
            <DialogTitle>
              {isNew ? "Bring a router into view." : "Fine-tune your connection."}
            </DialogTitle>
            <DialogDescription>
              Configure, verify, then save safely from your device draft.
            </DialogDescription>
          </div>
          <button
            type="button"
            className="device-editor__close"
            aria-label="Close device editor"
            disabled={busy}
            onClick={close}
          >
            <X size={19} />
          </button>
        </header>
        <div className="device-editor__layout">
          <ScrollArea
            className="device-editor__rail-scroll"
            viewportProps={{ className: "device-editor__viewport device-editor__rail-viewport" }}
          >
            <aside className="device-editor__rail">
              <nav aria-label="Device setup steps">
                {steps.map((label, index) => (
                  <button
                    type="button"
                    key={label}
                    disabled={busy}
                    aria-current={step === index ? "step" : undefined}
                    onClick={() => go(index)}
                  >
                    <span>{index < step ? <Check size={15} /> : `0${index + 1}`}</span>
                    <strong>{label}</strong>
                  </button>
                ))}
              </nav>
              <div className="device-route" aria-label="Connection preview">
                <span className="device-editor__eyebrow">CONNECTION PREVIEW</span>
                <div>
                  <Laptop size={19} />
                  <span>
                    MCP host<small>Credentials stay here</small>
                  </span>
                </div>
                <div className="device-route__line">
                  <span>
                    {dev.jumpVia
                      ? `via ${text(dev.jumpVia)}`
                      : dev.jumpHost
                        ? "via bastion"
                        : transport === "mac"
                          ? "Local network"
                          : "Encrypted transport"}
                  </span>
                </div>
                <div>
                  <Router size={19} />
                  <span className="min-w-0">
                    {newName || "New router"}
                    <code>{address}</code>
                  </span>
                </div>
              </div>
              <p className="device-editor__safety">
                <ShieldCheck size={16} />
                This form configures MCP access. It does not change your router.
              </p>
            </aside>
          </ScrollArea>
          <ScrollArea
            className="device-editor__body-scroll"
            viewportProps={{
              ref: content,
              className: "device-editor__viewport",
              "aria-label": "Device setup form",
            }}
          >
            <div className="device-editor__body">
              <fieldset disabled={busy} className="min-w-0 space-y-6 border-0 p-0">
                <div className="device-editor__intro">
                  <Badge type="secondary">STEP {step + 1} OF 3</Badge>
                  <h3>
                    {["Where is your router?", "Choose how to sign in.", "One last look."][step]}
                  </h3>
                  <p>
                    {
                      [
                        "Give it a recognizable name and choose the management connection.",
                        "Use a RouterOS account with the permissions your tools need.",
                        "Test this configuration, then save it or keep it in your draft for later.",
                      ][step]
                    }
                  </p>
                </div>
                {step === 0 && (
                  <>
                    <div className="device-editor__grid">
                      {field("name", "Device name", "home-router")}
                      {field("description", "Description", "Home · MikroTik hAP ax³")}
                    </div>
                    <div className="device-editor__choices" aria-label="Connection transport">
                      {[
                        ["ssh", "SSH", "Secure command access"],
                        ["rest", "REST + SSH", "HTTPS with SSH fallback"],
                        ["mac", "MAC-Telnet", "Same local network"],
                      ].map(([value, label, hint]) => (
                        <button
                          type="button"
                          key={value}
                          aria-label={label}
                          aria-pressed={transport === value}
                          onClick={() => changeTransport(value)}
                        >
                          <Network size={17} />
                          <strong>{label}</strong>
                          <small>{hint}</small>
                        </button>
                      ))}
                    </div>
                    <div className="device-editor__grid">
                      {transport === "mac" ? (
                        field("mac", "MAC address", "48:A9:8A:C6:42:F7")
                      ) : (
                        <>
                          {field("host", "Host / IP", "192.168.88.1")}
                          {field("port", "SSH port", "22", "number")}
                        </>
                      )}
                    </div>
                    {field("tags", "Tags", "home, production")}
                    <details className="device-editor__advanced">
                      <summary>
                        Connection options{" "}
                        <span>Timeout, jump host{transport === "rest" ? ", TLS" : ""}</span>
                      </summary>
                      {advanced(dev, setField, transport)}
                    </details>
                    <label className="device-editor__enabled">
                      <span>
                        <strong>Available to MCP</strong>
                        <small>Allow the assistant to target this router after saving.</small>
                      </span>
                      <Switch
                        aria-label="Available to MCP"
                        checked={dev.disabled !== true}
                        onCheckedChange={(value) => setField("disabled", !value)}
                      />
                    </label>
                  </>
                )}
                {step === 1 && (
                  <>
                    {field("username", "Username", "admin")}
                    {transport !== "mac" && (
                      <div
                        className="device-editor__choices device-editor__choices--two"
                        aria-label="Authentication method"
                      >
                        <button
                          type="button"
                          aria-label="Password authentication"
                          aria-pressed={auth === "password"}
                          onClick={() => changeAuth("password")}
                        >
                          <LockKeyhole size={18} />
                          <strong>Password</strong>
                          <small>RouterOS account password</small>
                        </button>
                        <button
                          type="button"
                          aria-label="SSH key authentication"
                          aria-pressed={auth === "key"}
                          onClick={() => changeAuth("key")}
                        >
                          <KeyRound size={18} />
                          <strong>SSH key</strong>
                          <small>Choose a public identity</small>
                        </button>
                      </div>
                    )}
                    {typeof dev[CREDENTIAL_SOURCE] === "string" && (
                      <Note type="secondary" label="Copied credentials">
                        <p>
                          Unchanged secrets are inherited securely from{" "}
                          {text(dev[CREDENTIAL_SOURCE])}.
                        </p>
                      </Note>
                    )}
                    {transport !== "mac" && auth === "key" ? (
                      <>
                        <KeyPicker
                          value={keySource === "file" ? text(dev.keyFilename) : ""}
                          onSelect={(key) => selectKeyFile(key.path)}
                        />
                        {keySource === "file" ? (
                          field(
                            "keyFilename",
                            "Private-key path on the MCP host",
                            "/Users/you/.ssh/id_ed25519",
                          )
                        ) : (
                          <div className="device-editor__inline-key">
                            <div className="device-editor__section-heading">
                              <span>Inline private key</span>
                              <Button
                                size="sm"
                                ghost
                                onClick={() => setInlineVisible(!inlineVisible)}
                              >
                                {inlineVisible ? "Hide key" : "Edit key"}
                              </Button>
                            </div>
                            {inlineVisible ? (
                              <textarea
                                aria-label="Inline private key"
                                value={dev.privateKey === REDACTED ? "" : text(dev.privateKey)}
                                placeholder={
                                  dev.privateKey === REDACTED
                                    ? "Stored key remains unchanged until you enter a replacement"
                                    : "Paste a PEM / OpenSSH private key"
                                }
                                onChange={(event) => setField("privateKey", event.target.value)}
                                spellCheck={false}
                              />
                            ) : (
                              <p>
                                {dev.privateKey
                                  ? "Private key is hidden."
                                  : "Enter a key using Edit key."}
                              </p>
                            )}
                            {errors.privateKey && <p role="alert">{errors.privateKey}</p>}
                          </div>
                        )}
                        <Button
                          ghost
                          size="sm"
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
                        </Button>
                        <SecretInput
                          label="Key passphrase"
                          value={dev.keyPassphrase}
                          onChange={(value) => setField("keyPassphrase", value)}
                        />
                        <details
                          className="device-editor__advanced"
                          open={transport === "rest" || undefined}
                        >
                          <summary>
                            Password fallback{" "}
                            <span>
                              {transport === "rest"
                                ? "Required by REST authentication"
                                : "Optional"}
                            </span>
                          </summary>
                          <SecretInput
                            label="Password"
                            value={dev.password}
                            onChange={(value) => setField("password", value)}
                          />
                        </details>
                      </>
                    ) : (
                      <>
                        <SecretInput
                          label="Password"
                          value={dev.password}
                          onChange={(value) => setField("password", value)}
                        />
                        <p className="device-editor__caption">
                          Stored passwords are never revealed. Leave the field unchanged to keep the
                          current secret. Blank passwords are supported for initial setup.
                        </p>
                      </>
                    )}
                  </>
                )}
                {step === 2 && (
                  <>
                    <div className="device-editor__review">
                      <span className="device-editor__emblem">
                        <Router size={27} />
                      </span>
                      <div>
                        <h4>{newName.trim()}</h4>
                        <code>{address}</code>
                      </div>
                      <Badge type="secondary">
                        {dev.disabled ? "Disabled" : "Ready for draft"}
                      </Badge>
                    </div>
                    <dl className="device-editor__facts">
                      <div>
                        <dt>Connection</dt>
                        <dd>
                          {transport === "mac"
                            ? "MAC-Telnet"
                            : transport === "rest"
                              ? "REST + SSH"
                              : "SSH"}
                        </dd>
                      </div>
                      <div>
                        <dt>Username</dt>
                        <dd>{text(dev.username)}</dd>
                      </div>
                      <div>
                        <dt>Authentication</dt>
                        <dd>
                          {transport === "mac" || auth === "password"
                            ? "Password"
                            : keySource === "inline"
                              ? "Inline SSH key"
                              : "SSH key file"}
                        </dd>
                      </div>
                      <div>
                        <dt>Timeout</dt>
                        <dd>{Number(dev.timeoutMs ?? 10000) / 1000}s</dd>
                      </div>
                      {dev.keyFilename && auth === "key" ? (
                        <div className="col-span-full">
                          <dt>Private-key path</dt>
                          <dd>{text(dev.keyFilename)}</dd>
                        </div>
                      ) : null}
                    </dl>
                    <div
                      className="device-editor__probe"
                      data-result={currentTest ? (currentTest.ok ? "success" : "error") : "idle"}
                    >
                      <PlugZap size={23} />
                      <div>
                        <strong>
                          {testing
                            ? "Connecting to your router…"
                            : currentTest
                              ? currentTest.ok
                                ? "Connection verified"
                                : "Connection could not be verified"
                              : "Verify before you save"}
                        </strong>
                        <p role="status">
                          {testing
                            ? "Read-only connection check. No settings are applied."
                            : (currentTest?.label ??
                              (test
                                ? "Settings changed. Test again to verify this draft."
                                : "A connection check is optional. You can save an offline router too."))}
                        </p>
                      </div>
                    </div>
                    <Note type="secondary" label="Nothing saved yet">
                      <p>
                        <b>Test connection</b> only checks access. <b>Connect &amp; Save</b> tests
                        again and saves only after a successful connection. You can also keep this
                        router in your draft without saving.
                      </p>
                    </Note>
                  </>
                )}
                {Object.keys(errors).length > 0 && (
                  <div role="alert" className="device-editor__errors">
                    {Object.entries(errors).map(([key, message]) => (
                      <p key={key}>{message}</p>
                    ))}
                  </div>
                )}
              </fieldset>
            </div>
          </ScrollArea>
        </div>
        <footer className="device-editor__footer">
          {discard ? (
            <>
              <span role="alert">Discard the changes in this form?</span>
              <Button size="sm" ghost onClick={() => setDiscard(false)}>
                Keep editing
              </Button>
              <Button size="sm" type="error" onClick={onCancel}>
                Discard form
              </Button>
            </>
          ) : (
            <>
              <Button ghost onClick={close} disabled={busy}>
                Cancel
              </Button>
              <span className="device-editor__footer-hint">
                <LockKeyhole size={13} /> Draft only · not applied
              </span>
              <span className="flex-1" />
              {step > 0 && (
                <Button
                  ghost
                  onClick={() => go(step - 1)}
                  disabled={busy}
                  icon={<ArrowLeft size={15} />}
                >
                  Back
                </Button>
              )}
              {step < 2 ? (
                <Button ghost disabled={busy} onClick={() => go(step + 1)}>
                  Continue <ArrowRight size={15} />
                </Button>
              ) : (
                <Button
                  ghost
                  disabled={busy}
                  onClick={() => void apply()}
                  icon={<Check size={16} />}
                >
                  {isNew ? "Add to draft" : "Update draft"}
                </Button>
              )}
              <div className="device-editor__connect-actions">
                <p className="device-editor__save-notice">{saveNotice}</p>
                <Button
                  ghost
                  disabled={busy}
                  loading={testing && !saving}
                  aria-label="Test connection"
                  onClick={() => void probe()}
                  icon={<PlugZap size={16} />}
                >
                  Test connection
                </Button>
                <Button
                  disabled={busy}
                  loading={saving}
                  aria-label="Connect & Save"
                  onClick={() => void apply(true)}
                  icon={<Check size={16} />}
                >
                  Connect &amp; Save
                </Button>
              </div>
            </>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
