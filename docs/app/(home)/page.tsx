import Link from "next/link";
import { Logo } from "../logo";
import { version } from "../../../package.json";
import catalog from "../../dashboard-pages.json";

const paths = [
  {
    label: "Get connected",
    title: "Start with one router.",
    description:
      "Install with Bun, choose your connection, and bring Claude or Codex into your network.",
    href: "/docs/guides/getting-started",
    links: [
      ["SSH keys", "ssh-keys"],
      ["Client setup", "connecting-clients"],
      ["Configuration", "configuration"],
    ],
  },
  {
    label: "Operate with context",
    title: "Know what to do next.",
    description:
      "Follow a workflow from the first symptom to a verified result, with the limits made clear.",
    href: "/docs/guides/client-investigations",
    links: [
      ["Investigations", "client-investigations"],
      ["Safe Mode", "safe-mode"],
      ["Recovery", "recovery-lab"],
    ],
  },
  {
    label: "Build on the tools",
    title: "Every input. Every guardrail.",
    description:
      "Find the exact parameters, supported operations and risk level for every registered tool.",
    href: "/docs/reference",
    links: [
      ["Architecture", "architecture"],
      ["Development", "development"],
      ["Access scope", "access-scope-settings"],
    ],
  },
];

/** Orient operators around setup, evidence and controlled changes. */
export default function HomePage() {
  return (
    <main className="docs-home">
      <section className="field-hero" aria-labelledby="hero-title">
        <div className="field-intro">
          <p className="eyebrow">
            <span className="status-dot" /> THE MIKROTIK MCP FIELD GUIDE{" "}
            <span className="version-tag">v{version}</span>
          </p>
          <h1 id="hero-title">
            Understand the network.
            <br />
            <em>Then make your move.</em>
          </h1>
          <p className="hero-description">
            A practical reference for the people behind the routers. Connect your AI assistant,
            follow the evidence, and make changes with confidence.
          </p>
          <div className="hero-actions">
            <Link href="/docs/guides/getting-started" className="button-primary">
              Connect your first router <span aria-hidden="true">↗</span>
            </Link>
            <Link href="/docs/reference" className="button-text">
              Browse the tools <span aria-hidden="true">→</span>
            </Link>
          </div>
          <p className="hero-footnote">
            Bun native <span>·</span> RouterOS <span>·</span> Open source
          </p>
        </div>
        <div className="route-map" aria-label="Choose a network workflow">
          <div className="map-header">
            <span className="eyebrow">YOUR OPERATION DESK</span>
            <span className="map-status">Ready to explore</span>
          </div>
          <div className="map-root">
            <Logo size={42} />
            <div>
              <strong>MikroTik MCP</strong>
              <span>One connection. The whole picture.</span>
            </div>
          </div>
          <div className="map-branches">
            <Link href="/docs/dashboard/devices">
              <span className="map-node" />
              <span>
                <strong>Connect</strong>
                <small>Devices, credentials & transports</small>
              </span>
              <span aria-hidden="true">↗</span>
            </Link>
            <Link href="/docs/dashboard/investigations">
              <span className="map-node" />
              <span>
                <strong>Investigate</strong>
                <small>Paths, sessions & packet evidence</small>
              </span>
              <span aria-hidden="true">↗</span>
            </Link>
            <Link href="/docs/dashboard/plan">
              <span className="map-node" />
              <span>
                <strong>Change with care</strong>
                <small>Preview, apply & verify</small>
              </span>
              <span aria-hidden="true">↗</span>
            </Link>
          </div>
          <div className="map-footer">
            <span className="status-dot" /> Start with a read. Keep a way back.
          </div>
        </div>
      </section>
      <section className="handbook-paths" aria-label="Documentation paths">
        {paths.map((path) => (
          <article className="handbook-path" key={path.href}>
            <p className="eyebrow">{path.label}</p>
            <Link href={path.href} className="path-title">
              <h2>{path.title}</h2>
              <span aria-hidden="true">↗</span>
            </Link>
            <p>{path.description}</p>
            <div className="path-shortcuts">
              {path.links.map(([label, slug]) => (
                <Link key={slug} href={`/docs/guides/${slug}`}>
                  {label} <span aria-hidden="true">→</span>
                </Link>
              ))}
            </div>
          </article>
        ))}
      </section>
      <section className="dashboard-atlas" aria-labelledby="atlas-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">THE DASHBOARD, EXPLAINED</p>
            <h2 id="atlas-title">A guide for every view.</h2>
          </div>
          <Link href="/docs/dashboard" className="button-text">
            Explore all {catalog.length} pages <span aria-hidden="true">→</span>
          </Link>
        </div>
        <div className="atlas-grid">
          <Link href="/docs/dashboard/openvpn" className="atlas-feature">
            <div className="atlas-caption">
              <span>Users & VPN</span>
              <h3>
                Every connection has a story. <span aria-hidden="true">↗</span>
              </h3>
              <p>Live sessions, traffic and connection history.</p>
            </div>
            <img
              src="/screenshots/openvpn.jpg"
              width="2380"
              height="1314"
              alt="Full-page OpenVPN dashboard with private names and addresses blurred"
            />
          </Link>
          <div className="atlas-links">
            {[
              ["Network", "Devices & connectivity", "devices"],
              ["Monitoring", "Site Activity", "site-activity"],
              ["Network", "Service Routing", "service-routing"],
              ["Users & VPN", "RADIUS & User Manager", "aaa"],
              ["Backup & recovery", "Snapshots & restore", "snapshots"],
            ].map(([group, label, id]) => (
              <Link key={id} href={`/docs/dashboard/${id}`}>
                <span>
                  <small>{group}</small>
                  <strong>{label}</strong>
                </span>
                <span aria-hidden="true">↗</span>
              </Link>
            ))}
          </div>
        </div>
      </section>
      <footer className="home-footer">
        <span>
          <Logo size={22} /> MikroTik MCP <span className="version-tag">v{version}</span>
        </span>
        <span>Read the evidence. Understand the change.</span>
        <Link href="https://github.com/mikrotik-mcp/mikrotik-mcp">Source on GitHub ↗</Link>
      </footer>
    </main>
  );
}
