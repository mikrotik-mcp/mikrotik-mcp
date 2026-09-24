import { useEffect, useState } from "react";
import {
  Activity,
  ArrowRight,
  Check,
  Clock,
  Home,
  Monitor,
  Route,
  ShieldCheck,
  Signal,
  Users,
  Undo2,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { api, postJson } from "./api";
import type { HomeClient, PolicyPlan, Diagnosis, Comparison } from "../../src/home/model";
import "./home-internet.css";

function Picker({
  label,
  value,
  items,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  items: { value: string; label: string }[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="home-field">
      <span>{label}</span>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label={label}>
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          {items.map((i) => (
            <SelectItem key={i.value} value={i.value}>
              {i.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
export function HomeInternetView() {
  const [devices, setDevices] = useState<string[]>([]),
    [device, setDevice] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void api<{ devices: { name: string }[]; defaultDevice: string }>("/api/devices")
      .then((r) => {
        if (!cancelled) {
          setDevices(r.devices.map((d) => d.name));
          setDevice(r.defaultDevice || r.devices[0]?.name || "");
        }
      })
      .catch(() => {
        if (!cancelled)
          setError("Could not load routers. Check the dashboard connection and reload.");
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <div className="home-internet">
      <header className="home-intro">
        <div>
          <div className="home-eyebrow">
            <Home size={14} /> YOUR EVERYDAY NETWORK
          </div>
          <h2>
            Less guessing.
            <br />
            <span>More connection.</span>
          </h2>
          <p>Find the slowdown, look after your household, and choose a path with evidence.</p>
        </div>
        <Picker
          label="Home router"
          value={device}
          items={devices.map((d) => ({ value: d, label: d }))}
          onChange={setDevice}
        />
      </header>
      {error && (
        <p role="alert" className="home-error">
          {error}
        </p>
      )}
      {device && <Workspace key={device} device={device} />}
    </div>
  );
}
function Workspace({ device }: { device: string }) {
  const [tab, setTab] = useState<"diagnosis" | "people" | "paths">("diagnosis");
  const [clients, setClients] = useState<HomeClient[]>([]),
    [policies, setPolicies] = useState<PolicyPlan[]>([]),
    [tables, setTables] = useState<string[]>([]);
  const [client, setClient] = useState(""),
    [target, setTarget] = useState("example.com"),
    [pathTarget, setPathTarget] = useState("1.1.1.1");
  const [selectedTables, setSelectedTables] = useState<string[]>([]),
    [goal, setGoal] = useState("calls");
  const [diagnosis, setDiagnosis] = useState<Diagnosis>(),
    [comparison, setComparison] = useState<Comparison>();
  const [action, setAction] = useState<"pause" | "priority" | "route">("pause"),
    [routeTable, setRouteTable] = useState(""),
    [minutes, setMinutes] = useState("30"),
    [delay, setDelay] = useState("0");
  const [preview, setPreview] = useState<PolicyPlan>(),
    [approved, setApproved] = useState(false),
    [undo, setUndo] = useState<string>();
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const query = `?device=${encodeURIComponent(device)}`;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  async function load() {
    const r = await api<{ clients: HomeClient[]; policies: PolicyPlan[] }>(
      `/api/home-internet${query}`,
    );
    setClients(r.clients);
    setPolicies(r.policies);
  }
  useEffect(() => {
    const controller = new AbortController();
    void api<{ clients: HomeClient[]; policies: PolicyPlan[] }>(
      `/api/home-internet${query}`,
      controller.signal,
    )
      .then((r) => {
        if (!controller.signal.aborted) {
          setClients(r.clients);
          setPolicies(r.policies);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Could not load the saved household. Retry with Refresh saved data.");
      });
    return () => controller.abort();
  }, [query]);
  async function request<T>(path: string, data: unknown): Promise<T> {
    const r = await postJson<T & { error?: string }>(`/api/home-internet/${path}${query}`, data);
    if (r.error) throw new Error(r.error);
    return r;
  }
  async function run(label: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed. No success has been confirmed.");
    } finally {
      setBusy("");
    }
  }
  const selected = clients.find((c) => c.mac === client);
  const options = clients
    .filter((c) => c.ip)
    .map((c) => ({ value: c.mac, label: `${c.name || c.hostname || "Unnamed device"} · ${c.ip}` }));
  const newClients = clients.filter((c) => !c.acknowledged);
  const resetPreview = () => {
    setPreview(undefined);
    setApproved(false);
  };
  return (
    <>
      <nav className="home-sections" aria-label="Home Internet sections">
        {[
          {
            id: "diagnosis",
            title: "Find the slowdown",
            sub: "Understand what to check",
            icon: Activity,
          },
          {
            id: "people",
            title: "Your household",
            sub: "People, devices & quiet time",
            icon: Users,
          },
          { id: "paths", title: "Choose a path", sub: "Compare before switching", icon: Route },
        ].map(({ id, title, sub, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => setTab(id as typeof tab)}
          >
            <Icon size={20} />
            <span>
              <strong>{title}</strong>
              <small>{sub}</small>
            </span>
            {id === "people" && newClients.length > 0 && (
              <b className="home-new">{newClients.length} new</b>
            )}
          </button>
        ))}
      </nav>
      <div className="home-toolbar">
        <span>
          <ShieldCheck size={16} /> No router changes without a reviewed preview.
        </span>
        <div>
          <Button
            variant="ghost"
            size="sm"
            disabled={!!busy}
            onClick={() => void run("Loading saved data", load)}
          >
            Refresh saved data
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!!busy}
            onClick={() =>
              void run("Discovering household", async () => {
                const r = await request<{ clients: HomeClient[]; tables: string[] }>("refresh", {});
                setClients(r.clients);
                setTables(r.tables);
                setSelectedTables((v) => v.filter((t) => r.tables.includes(t)));
                setNotice(
                  "DHCP inventory updated. New-device notices appear after the first baseline scan; no router configuration changed.",
                );
              })
            }
          >
            <RefreshCw size={14} /> Discover devices & paths
          </Button>
        </div>
      </div>
      {busy && (
        <p className="home-status" role="status">
          <span className="home-pulse" />
          {busy}…
        </p>
      )}
      {error && (
        <p className="home-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="home-status" role="status">
          <Check size={16} />
          {notice}
        </p>
      )}
      {tab === "diagnosis" && (
        <section className="home-grid">
          <div className="home-card">
            <div className="home-eyebrow">A SMALL, READ-ONLY CHECK</div>
            <h3>What feels slow?</h3>
            <p>
              Choose a device and a website. We check the router, DNS, Wi-Fi evidence and a few
              small internet probes.
            </p>
            <div className="home-form">
              <Picker
                label="Affected device"
                value={client}
                items={options}
                onChange={setClient}
                disabled={!!busy}
              />
              <label className="home-field">
                Website or IPv4
                <Input
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder="example.com"
                />
              </label>
              <Button
                disabled={!!busy || !selected?.ip || !target}
                onClick={() =>
                  void run("Checking the connection", async () => {
                    setDiagnosis(undefined);
                    setDiagnosis(
                      await request<Diagnosis>("diagnose", { client: selected!.ip, target }),
                    );
                  })
                }
              >
                <Activity size={16} /> Check my connection <ArrowRight size={16} />
              </Button>
            </div>
            {!clients.length && (
              <p className="home-hint">
                Start with “Discover devices & paths” above. Devices without DHCP records can still
                be investigated in <a href="#investigations">Investigations</a>.
              </p>
            )}
          </div>
          <aside className="home-explainer">
            <Signal size={32} />
            <h3>Follow the evidence.</h3>
            <ol>
              <li>
                <b>Observed</b>
                <span>Something the router actually reported.</span>
              </li>
              <li>
                <b>Suspected</b>
                <span>A possible explanation, not a confirmed cause.</span>
              </li>
              <li>
                <b>Unknown</b>
                <span>A missing measurement, never a green check.</span>
              </li>
            </ol>
            <p>
              This is not a speed test. Client application health, VPN throughput and MTU remain
              unverified.
            </p>
          </aside>
          {diagnosis && (
            <div className="home-results">
              <header>
                <h3>Your connection report</h3>
                <small>
                  {diagnosis.client} → {diagnosis.target} ·{" "}
                  {new Date(diagnosis.at).toLocaleTimeString()}
                </small>
              </header>
              <div className="home-findings">
                {diagnosis.findings.map((f) => (
                  <article key={f.area} data-state={f.state}>
                    <div className="home-finding-label">
                      <span>{f.area}</span>
                      <b>{f.state}</b>
                    </div>
                    <h4>{f.title}</h4>
                    <p>{f.detail}</p>
                    <footer>
                      <ArrowRight size={14} />
                      <span>{f.next}</span>
                    </footer>
                  </article>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
      {tab === "people" && (
        <section className="home-grid">
          <div className="home-card">
            <div className="home-eyebrow">PEOPLE, NOT MAC ADDRESSES</div>
            <h3>Give each device a place.</h3>
            <p>
              Friendly names stay in this MCP. Notices are based on explicit discovery scans, not
              continuous surveillance. Private/random MACs can appear as new devices.
            </p>
            <div className="home-client-list">
              {clients.length === 0 && (
                <p className="home-empty">
                  No household inventory yet. Discover devices to establish your first baseline.
                </p>
              )}
              {clients.map((c) => (
                <ClientRow
                  key={c.mac}
                  client={c}
                  disabled={!!busy}
                  onSave={(name, person) =>
                    void run("Saving device name", async () => {
                      await request("name", { mac: c.mac, name, person });
                      await load();
                      setNotice("Name saved locally; new-device notice acknowledged.");
                    })
                  }
                  onChoose={() => {
                    setClient(c.mac);
                    resetPreview();
                  }}
                  selected={client === c.mac}
                />
              ))}
            </div>
          </div>
          <aside className="home-card">
            <div className="home-eyebrow">
              <Clock size={14} /> TEMPORARY, BY DESIGN
            </div>
            <h3>A little quiet. Or meeting time.</h3>
            <p>
              Pause routed access or prioritize a device within an existing QoS setup. A static DHCP
              lease is required; IPv6 and FastTrack limitations are checked before a preview is
              created.
            </p>
            <Picker
              label="Household device"
              value={client}
              items={options}
              onChange={(v) => {
                setClient(v);
                resetPreview();
              }}
              disabled={!!busy}
            />
            <Picker
              label="Temporary action"
              value={action === "route" ? "pause" : action}
              items={[
                { value: "pause", label: "Pause routed access" },
                { value: "priority", label: "Meeting priority" },
              ]}
              onChange={(v) => {
                setAction(v as "pause" | "priority");
                resetPreview();
              }}
              disabled={!!busy}
            />
            <Duration
              minutes={minutes}
              delay={delay}
              setMinutes={(v) => {
                setMinutes(v);
                resetPreview();
              }}
              setDelay={(v) => {
                setDelay(v);
                resetPreview();
              }}
            />
            <Button
              disabled={!!busy || !selected}
              onClick={() =>
                void run("Checking policy prerequisites", async () => {
                  resetPreview();
                  setPreview(
                    await request<PolicyPlan>("preview", {
                      mac: client,
                      action: action === "route" ? "pause" : action,
                      minutes: Number(minutes),
                      startInMinutes: Number(delay),
                    }),
                  );
                })
              }
            >
              Review temporary change <ArrowRight size={15} />
            </Button>
          </aside>
        </section>
      )}
      {tab === "paths" && (
        <section className="home-grid">
          <div className="home-card">
            <div className="home-eyebrow">TRY THE PATH, NOT YOUR LUCK</div>
            <h3>Which route looks steadier?</h3>
            <p>
              Compare up to three existing routing tables. Five small probes per path; no traffic is
              switched and no large files are downloaded.
            </p>
            <div className="home-form">
              <Picker
                label="What matters most?"
                value={goal}
                items={[
                  { value: "calls", label: "Stable calls" },
                  { value: "gaming", label: "Responsive gaming" },
                  { value: "download", label: "Downloads — measurements only" },
                ]}
                onChange={setGoal}
              />
              <label className="home-field">
                Same IPv4 destination for every path
                <Input value={pathTarget} onChange={(e) => setPathTarget(e.target.value)} />
              </label>
              <fieldset>
                <legend>Paths to compare · up to three</legend>
                <div className="home-path-options">
                  {tables.map((t) => (
                    <label key={t}>
                      <Checkbox
                        checked={selectedTables.includes(t)}
                        disabled={!selectedTables.includes(t) && selectedTables.length >= 3}
                        onCheckedChange={(checked) =>
                          setSelectedTables((v) => (checked ? [...v, t] : v.filter((x) => x !== t)))
                        }
                      />
                      <span>{t}</span>
                    </label>
                  ))}
                </div>
                {!tables.length && (
                  <p className="home-hint">
                    Discover devices & paths to load the router's available tables.
                  </p>
                )}
              </fieldset>
              <Button
                disabled={!!busy || !selectedTables.length}
                onClick={() =>
                  void run("Comparing internet paths", async () => {
                    setComparison(undefined);
                    setComparison(
                      await request<Comparison>("compare", {
                        tables: selectedTables,
                        target: pathTarget,
                        goal,
                      }),
                    );
                  })
                }
              >
                <Route size={16} /> Compare paths
              </Button>
            </div>
          </div>
          <aside className="home-card">
            <h3>Try a path for one device.</h3>
            <p>
              Only an existing, ready routing table can be selected. IPv6 keeps its current route;
              local/private destinations are excluded.
            </p>
            <Picker
              label="Device to switch"
              value={client}
              items={options}
              onChange={(v) => {
                setClient(v);
                resetPreview();
              }}
              disabled={!!busy}
            />
            <Picker
              label="Route table"
              value={routeTable}
              items={tables.map((t) => ({ value: t, label: t }))}
              onChange={(v) => {
                setRouteTable(v);
                resetPreview();
              }}
              disabled={!!busy}
            />
            <Duration
              minutes={minutes}
              delay={delay}
              setMinutes={(v) => {
                setMinutes(v);
                resetPreview();
              }}
              setDelay={(v) => {
                setDelay(v);
                resetPreview();
              }}
            />
            <Button
              disabled={!!busy || !client || !routeTable}
              onClick={() =>
                void run("Preparing path preview", async () => {
                  resetPreview();
                  setPreview(
                    await request<PolicyPlan>("preview", {
                      mac: client,
                      action: "route",
                      table: routeTable,
                      minutes: Number(minutes),
                      startInMinutes: Number(delay),
                    }),
                  );
                })
              }
            >
              Review path change <ArrowRight size={15} />
            </Button>
          </aside>
          {comparison && (
            <div className="home-results">
              <header>
                <h3>Path comparison</h3>
                <small>
                  {comparison.target} · {new Date(comparison.at).toLocaleTimeString()}
                </small>
              </header>
              <p>{comparison.explanation}</p>
              <div className="home-paths">
                {comparison.paths.map((p) => (
                  <article
                    key={p.table}
                    className={comparison.recommended === p.table ? "home-recommended" : ""}
                  >
                    <div className="home-path-line">
                      <Monitor />
                      <span />
                      <Route />
                      <span />
                      <Signal />
                    </div>
                    <h4>{p.table}</h4>
                    {comparison.recommended === p.table && (
                      <b className="home-new">Best in this small sample</b>
                    )}
                    <dl>
                      <div>
                        <dt>Loss</dt>
                        <dd>{p.loss === null ? "Unknown" : `${p.loss.toFixed(0)}%`}</dd>
                      </div>
                      <div>
                        <dt>Average RTT</dt>
                        <dd>{p.latency === null ? "Unknown" : `${p.latency.toFixed(1)} ms`}</dd>
                      </div>
                      <div>
                        <dt>RTT range</dt>
                        <dd>{p.spread === null ? "Unknown" : `${p.spread.toFixed(1)} ms`}</dd>
                      </div>
                    </dl>
                    <p>{p.note}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setRouteTable(p.table);
                        resetPreview();
                      }}
                    >
                      Choose for preview
                    </Button>
                  </article>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
      {preview && (
        <section className="home-review" aria-label="Review temporary change">
          <header>
            <ShieldCheck />
            <div>
              <h3>Review before anything changes</h3>
              <p>
                {preview.device} · {preview.input.mac} · {preview.ip} · {preview.input.action}
                {preview.input.table ? ` → ${preview.input.table}` : ""}
              </p>
            </div>
          </header>
          <p>
            Starts{" "}
            {preview.input.startInMinutes
              ? `in ${preview.input.startInMinutes} minutes`
              : "after confirmation"}
            ; lasts {preview.input.minutes} minutes. Preview expires{" "}
            {new Date(preview.previewExpiresAt).toLocaleTimeString()}.
          </p>
          <ul>
            {preview.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <details>
            <summary>Exact RouterOS changes and rollback</summary>
            <pre>
              {preview.commands.join("\n")}
              {"\n\n# Undo only this policy\n"}
              {preview.undo.join("\n")}
            </pre>
          </details>
          <label className="home-consent">
            <Checkbox checked={approved} onCheckedChange={(v) => setApproved(v === true)} />
            <span>
              I reviewed this client, route and duration. I understand existing connections may
              disconnect.
            </span>
          </label>
          <div className="home-buttons">
            <Button variant="outline" disabled={!!busy} onClick={resetPreview}>
              Discard preview
            </Button>
            <Button
              disabled={!!busy || !approved || now > preview.previewExpiresAt}
              onClick={() =>
                void run("Applying approved policy", async () => {
                  const result = await request<PolicyPlan>("apply", {
                    id: preview.id,
                    confirm: true,
                  });
                  resetPreview();
                  await load();
                  setNotice(
                    `Policy ${result.status}. Pre-change snapshot: ${result.snapshot ?? "not returned"}. Router-side expiry installed; client delivery still needs verification.`,
                  );
                })
              }
            >
              Apply this temporary change
            </Button>
          </div>
        </section>
      )}
      <section className="home-card home-history">
        <header>
          <div>
            <div className="home-eyebrow">A WAY BACK</div>
            <h3>Temporary policy history</h3>
          </div>
          <Clock size={22} />
        </header>
        <p>
          Saved status, not live proof. After expiry, use Undo / reconcile to verify cleanup. No
          full-config restore is performed.
        </p>
        {policies.filter((p) => p.status !== "preview").length === 0 ? (
          <p className="home-empty">
            No applied policies. Your router configuration stays as it is.
          </p>
        ) : (
          policies
            .filter((p) => p.status !== "preview")
            .map((p) => (
              <div key={p.id} className="home-policy">
                <div>
                  <strong>
                    {p.input.action} · {p.ip}
                    {p.input.table ? ` → ${p.input.table}` : ""}
                  </strong>
                  <small>
                    {p.status === "undone"
                      ? "Undone"
                      : p.endsAt && now > p.endsAt
                        ? "Expiry passed · cleanup not verified"
                        : `${p.status} · saved status`}
                    {p.endsAt && ` · until ${new Date(p.endsAt).toLocaleString()}`}
                  </small>
                  {p.error && <p className="home-error">{p.error}</p>}
                </div>
                {p.status !== "undone" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!busy}
                    onClick={() => setUndo(p.id)}
                  >
                    <Undo2 size={14} /> Undo / reconcile
                  </Button>
                )}
                {undo === p.id && (
                  <div className="home-undo">
                    <span>
                      Remove only this policy's objects and restore its prior queue priority?
                    </span>
                    <Button variant="outline" size="sm" onClick={() => setUndo(undefined)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      disabled={!!busy}
                      onClick={() =>
                        void run("Restoring the previous policy", async () => {
                          await request("undo", { id: p.id, confirm: true });
                          setUndo(undefined);
                          await load();
                          setNotice("Policy undo committed.");
                        })
                      }
                    >
                      Confirm undo
                    </Button>
                  </div>
                )}
              </div>
            ))
        )}
      </section>
    </>
  );
}
function Duration({
  minutes,
  delay,
  setMinutes,
  setDelay,
}: {
  minutes: string;
  delay: string;
  setMinutes: (s: string) => void;
  setDelay: (s: string) => void;
}) {
  return (
    <div className="home-duration">
      <label className="home-field">
        Duration · minutes
        <Input
          type="number"
          min={5}
          max={120}
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
        />
      </label>
      <label className="home-field">
        Start in · minutes
        <Input
          type="number"
          min={0}
          max={1440}
          value={delay}
          onChange={(e) => setDelay(e.target.value)}
        />
      </label>
    </div>
  );
}
function ClientRow({
  client: c,
  disabled,
  selected,
  onSave,
  onChoose,
}: {
  client: HomeClient;
  disabled: boolean;
  selected: boolean;
  onSave: (name: string, person: string) => void;
  onChoose: () => void;
}) {
  const [editing, setEditing] = useState(false),
    [name, setName] = useState(c.name),
    [person, setPerson] = useState(c.person);
  return (
    <article className="home-client" data-selected={selected}>
      <div className="home-client-heading">
        <Monitor size={20} />
        <div>
          <strong>{c.name || c.hostname || "Unnamed device"}</strong>
          <small>
            {c.person || "No person assigned"} · {c.ip || "No IPv4"}
          </small>
        </div>
        {!c.acknowledged && <b className="home-new">New</b>}
      </div>
      <p className="home-hint">
        {c.mac} · {c.present ? "Bound at last scan" : "Not bound at last scan"} ·{" "}
        {new Date(c.lastSeen).toLocaleString()}
      </p>
      {editing && (
        <div className="home-form">
          <label className="home-field">
            Friendly name
            <Input maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="home-field">
            Person
            <Input maxLength={80} value={person} onChange={(e) => setPerson(e.target.value)} />
          </label>
        </div>
      )}
      <div className="home-buttons">
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => (editing ? onSave(name, person) : setEditing(true))}
        >
          {editing ? "Save & acknowledge" : "Name / acknowledge"}
        </Button>
        <Button variant="outline" size="sm" disabled={disabled} onClick={onChoose}>
          {selected ? "Selected" : "Manage device"}
        </Button>
      </div>
    </article>
  );
}
