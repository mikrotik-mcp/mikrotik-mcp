import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as Bun from "bun";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { NAV_GROUPS, VIEWS } from "../ui/observability/navigation";

// A local, deterministic product film. Never connects to a router or dashboard API.
export const FILM = { width: 1920, height: 1080, fps: 30, duration: 60, sceneDuration: 6 };
const output = resolve(import.meta.dirname, "../assets/motion");
const orange = "#F2653D";
const mint = "#7CD6BB";
const blue = "#9DBFFF";
const muted = "#A0ADBE";
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const ease = (value: number) => 1 - (1 - clamp(value)) ** 3;
const text = (
  x: number,
  y: number,
  value: string,
  size = 24,
  fill = "#E7EDF7",
  weight = 400,
  extra = "",
) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" ${extra}>${Bun.escapeHTML(value)}</text>`;
const rect = (
  x: number,
  y: number,
  width: number,
  height: number,
  fill = "#192638",
  radius = 18,
  stroke = "none",
) =>
  `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="${stroke}"/>`;
const line = (x: number, y: number, x2: number, y2: number, stroke = "#334158", extra = "") =>
  `<path d="M${x} ${y}L${x2} ${y2}" fill="none" stroke="${stroke}" stroke-width="2" ${extra}/>`;
const dot = (x: number, y: number, fill = mint, radius = 5) =>
  `<circle cx="${x}" cy="${y}" r="${radius}" fill="${fill}"/>`;
const tag = (x: number, y: number, label: string, color = mint) =>
  rect(x, y, label.length * 9 + 26, 29, "#1C2B3A", 14) +
  text(x + 13, y + 20, label, 14, color, 500);

export const chapters = [
  {
    id: "intro",
    title: ["Your network.", "One clear picture."],
    subtitle: "The MikroTik MCP dashboard",
  },
  {
    id: "monitoring",
    title: ["See the signal.", "Skip the noise."],
    subtitle: "Health, flows and activity. In context.",
  },
  {
    id: "network",
    title: ["Every router.", "Connected."],
    subtitle: "Ports, paths and Wi-Fi. One workspace.",
  },
  {
    id: "users-vpn",
    title: ["Know who.", "Know when."],
    subtitle: "Clients, VPN sessions and accounting.",
  },
  {
    id: "diagnostics",
    title: ["Follow the path.", "Find the why."],
    subtitle: "From a symptom to inspectable evidence.",
  },
  {
    id: "security",
    title: ["Look closer.", "Decide better."],
    subtitle: "Exposure, incidents and bounded policy checks.",
  },
  {
    id: "configuration",
    title: ["See the change.", "Before it lands."],
    subtitle: "Preview the diff. Keep approval explicit.",
  },
  {
    id: "recovery",
    title: ["Keep a copy.", "Have a way back."],
    subtitle: "Snapshots, backup vaults and recovery rehearsals.",
  },
  {
    id: "workspace",
    title: ["Keep context.", "Keep control."],
    subtitle: "Memory, permissions and your MCP settings.",
  },
  { id: "outro", title: ["Understand.", "Then act."], subtitle: "MikroTik MCP" },
];

function chart(progress: number, x = 0, y = 90, width = 880, height = 220) {
  const points = Array.from({ length: 90 }, (_, index) => {
    const value =
      0.42 +
      Math.sin(index * 0.19) * 0.17 +
      Math.cos(index * 0.51) * 0.06 +
      (index > 60 ? 0.18 : 0);
    return `${index === 0 ? "M" : "L"}${x + (index / 89) * width},${y + height * (1 - value)}`;
  }).join(" ");
  return `<defs><clipPath id="chart-reveal"><rect x="${x}" y="${y}" width="${width * ease(progress)}" height="${height}"/></clipPath></defs>${[
    0, 0.5, 1,
  ]
    .map((n) => line(x, y + height * n, x + width, y + height * n, "#29384C"))
    .join(
      "",
    )}<g clip-path="url(#chart-reveal)"><path d="${points}L${x + width},${y + height}L${x},${y + height}Z" fill="url(#chart-fill)"/><path d="${points}" fill="none" stroke="${mint}" stroke-width="3" stroke-linejoin="round"/></g>`;
}

function monitoring(time: number) {
  const count = Math.round(128 * ease(time / 1.6));
  return (
    text(0, 0, "A network, at a glance", 30, "#E7EDF7", 500) +
    tag(718, -24, "DEMO DATA", blue) +
    ["Observed calls", "Median response", "Connected routers"]
      .map((label, index) => {
        const value = [String(count), "42 ms", "3 / 3"][index]!;
        return (
          rect(index * 300, 36, 280, 106) +
          text(index * 300 + 20, 68, label, 15, muted) +
          text(index * 300 + 20, 118, value, 36, index === 2 ? mint : "#E7EDF7", 500)
        );
      })
      .join("") +
    chart(time / 3, 0, 175, 880, 210) +
    text(0, 421, "Network activity", 18, muted) +
    text(770, 421, "Illustrative", 14, muted) +
    line(0, 447, 880, 447) +
    dot(12, 482) +
    text(30, 489, "Read interface counters", 20) +
    tag(688, 465, "Recorded", mint)
  );
}

function network(time: number) {
  const center = { x: 440, y: 217 };
  const nodes = [
    { x: 110, y: 105, title: "Edge router", sub: "Interfaces" },
    { x: 770, y: 105, title: "Branch router", sub: "Service routing" },
    { x: 440, y: 430, title: "Access point", sub: "CAPsMAN / Wi-Fi" },
  ];
  return `${text(
    0,
    0,
    "A map you can work with",
    30,
    "#E7EDF7",
    500,
  )}<circle cx="440" cy="220" r="170" stroke="#293A51" fill="none" stroke-dasharray="3 10"/>${nodes
    .map((node, index) => {
      const p = (time * 0.35 + index * 0.3) % 1;
      return (
        line(center.x, center.y, node.x, node.y, "#475C76") +
        dot(center.x + (node.x - center.x) * p, center.y + (node.y - center.y) * p, orange, 6) +
        rect(node.x - 99, node.y - 47, 198, 94, "#1A2A3D", 22, "#415775") +
        text(node.x, node.y - 6, node.title, 20, "#E7EDF7", 500, 'text-anchor="middle"') +
        text(node.x, node.y + 25, node.sub, 14, muted, 400, 'text-anchor="middle"')
      );
    })
    .join("")}${rect(358, 170, 164, 94, "#F2653D", 24)}${text(
    440,
    210,
    "MCP",
    32,
    "#FFFCF5",
    600,
    'text-anchor="middle"',
  )}${text(440, 239, "Explicit targets", 13, "#FFFCF5", 400, 'text-anchor="middle"')}${tag(
    0,
    480,
    "Topology",
    blue,
  )}${tag(125, 480, "L2 Fabric", blue)}${tag(262, 480, "Connection endpoints", blue)}`;
}

function users(time: number) {
  const entries = [
    ["Alex", "192.0.2.24", "00:42:18"],
    ["Sam", "198.51.100.8", "01:12:06"],
    ["Robin", "203.0.113.19", "00:08:35"],
  ];
  return (
    text(0, 0, "The people behind the packets", 30, "#E7EDF7", 500) +
    text(0, 48, "Session duration · source IP · country & ASN context", 18, muted) +
    entries
      .map((entry, index) => {
        const appear = ease((time - index * 0.18) / 0.75);
        const y = 90 + index * 103;
        return (
          `<g opacity="${appear}" transform="translate(${(1 - appear) * 35} 0)">` +
          rect(0, y, 880, 86) +
          dot(34, y + 42) +
          text(60, y + 38, entry[0]!, 22, "#E7EDF7", 500) +
          text(60, y + 65, "OpenVPN session", 13, muted) +
          text(290, y + 50, entry[1]!, 21, blue) +
          text(635, y + 50, entry[2]!, 24) +
          `</g>`
        );
      })
      .join("") +
    rect(0, 421, 880, 87, "#202D40", 18) +
    text(24, 455, "History beyond the current connection", 21, blue, 500) +
    text(24, 486, "Review retained sessions, periods and user accounting.", 17, muted)
  );
}

function diagnostics(time: number) {
  const labels = ["Client", "Gateway", "Tunnel", "Destination"];
  return (
    text(0, 0, "A question becomes evidence", 30, "#E7EDF7", 500) +
    line(80, 126, 800, 126, "#405573") +
    labels
      .map((label, index) => {
        const x = 80 + index * 240;
        return (
          `<circle cx="${x}" cy="126" r="32" fill="#16273A" stroke="${time > index * 0.55 ? mint : "#405573"}" stroke-width="2"/>` +
          text(x, 134, String(index + 1), 23, blue, 500, 'text-anchor="middle"') +
          text(x, 192, label, 19, "#E7EDF7", 500, 'text-anchor="middle"')
        );
      })
      .join("") +
    rect(0, 252, 880, 252, "#101C2C", 20, "#334A66") +
    text(24, 293, "INVESTIGATION", 14, orange, 600, 'letter-spacing="2"') +
    [
      "Correlate client and service evidence",
      "Inspect packet and flow details",
      "Preserve the incident with Flight Recorder",
      "Export a minimised support bundle",
    ]
      .map(
        (label, index) =>
          `<g opacity="${ease((time - 0.8 - index * 0.25) / 0.6)}">` +
          dot(32, 331 + index * 45, blue, 3) +
          text(52, 338 + index * 45, label, 21) +
          `</g>`,
      )
      .join("")
  );
}

function security(time: number) {
  const rows = [
    ["Observed incidents", "Inspect the evidence", orange],
    ["Published vulnerabilities", "Review actual exposure", blue],
    ["Policy scenarios", "Verify bounded behavior", mint],
  ];
  return (
    text(0, 0, "Evidence before confidence", 30, "#E7EDF7", 500) +
    rows
      .map((row, index) => {
        const y = 52 + index * 117;
        return (
          `<g opacity="${ease((time - index * 0.15) / 0.7)}">` +
          rect(0, y, 880, 96) +
          rect(0, y + 20, 3, 56, row[2]!, 1) +
          text(25, y + 39, row[0]!, 23) +
          text(25, y + 72, row[1]!, 17, muted) +
          `<path d="M813 ${y + 40}l10 10-10 10" fill="none" stroke="${row[2]}" stroke-width="2"/></g>`
        );
      })
      .join("") +
    line(0, 439, 880, 439) +
    text(0, 482, "A check is evidence — not a blanket guarantee.", 22, muted)
  );
}

function configuration(time: number) {
  const lines = [
    ["# Illustrative change preview", muted],
    ["target: edge-router", blue],
    ["", muted],
    ["− destination: old-service-set", "#F4A3A4"],
    ["+ destination: reviewed-service-set", mint],
    ["", muted],
    ["Preview first. Explicit approval next.", "#DDE6F6"],
  ];
  return (
    text(0, 0, "Make the intended change visible", 30, "#E7EDF7", 500) +
    rect(0, 43, 880, 322, "#0F1A2B", 18, "#354966") +
    lines
      .map(
        (entry, index) =>
          `<g opacity="${ease((time - index * 0.12) / 0.6)}">` +
          text(
            26,
            85 + index * 39,
            entry[0]!,
            21,
            entry[1]!,
            400,
            'font-family="Menlo, monospace"',
          ) +
          `</g>`,
      )
      .join("") +
    ["Inspect", "Preview", "Approve"]
      .map(
        (label, index) =>
          rect(
            index * 300,
            407,
            280,
            69,
            index === 2 ? "#394341" : "#1C2D43",
            17,
            index === 2 ? "#C88260" : "none",
          ) +
          text(
            index * 300 + 140,
            450,
            label,
            22,
            index === 2 ? "#F7B395" : blue,
            500,
            'text-anchor="middle"',
          ),
      )
      .join("") +
    text(0, 513, "Safe Mode and recovery limits stay visible.", 17, muted)
  );
}

function recovery(time: number) {
  return (
    text(0, 0, "Recovery starts before the incident", 30, "#E7EDF7", 500) +
    ["Snapshot", "Local vault", "S3 storage"]
      .map((label, index) => {
        const x = index * 300;
        const p = ease((time - index * 0.2) / 1);
        return (
          `<g transform="translate(0 ${(1 - p) * 28})" opacity="${p}">` +
          rect(x, 57, 280, 235) +
          `<path d="M${x + 108} 115l32-17 32 17v45l-32 17-32-17zM${x + 108} 115l32 17 32-17M${x + 140} 132v45" fill="none" stroke="${index === 1 ? orange : blue}" stroke-width="2" stroke-linejoin="round"/>` +
          text(x + 140, 222, label, 24, "#E7EDF7", 500, 'text-anchor="middle"') +
          text(x + 140, 259, "Review & verify", 15, muted, 400, 'text-anchor="middle"') +
          `</g>`
        );
      })
      .join("") +
    line(30, 367, 850, 367, "#48617F") +
    [30, 440, 850].map((x) => dot(x, 367, mint, 7)).join("") +
    text(0, 415, "Before", 18, muted) +
    text(391, 415, "Compare", 18, muted) +
    text(779, 415, "Rehearse", 18, muted) +
    rect(0, 451, 880, 61, "#1A2D34", 16) +
    text(25, 490, "Router Migration + Recovery Lab", 23, mint, 500)
  );
}

function workspace(time: number) {
  const p = ease(time / 1.5);
  return (
    text(0, 0, "Useful context. Explicit boundaries.", 30, "#E7EDF7", 500) +
    rect(0, 55, 425, 337) +
    text(25, 100, "Memory", 29, blue, 500) +
    ["Device context", "Shared knowledge", "Sources & freshness"]
      .map(
        (label, index) =>
          `<g opacity="${ease((time - index * 0.2) / 0.8)}">` +
          line(39, 150 + index * 77, 39, 215 + index * 77) +
          dot(39, 150 + index * 77, orange, 6) +
          text(60, 158 + index * 77, label, 21) +
          `</g>`,
      )
      .join("") +
    rect(452, 55, 428, 337) +
    text(477, 100, "Tool access", 29, mint, 500) +
    ["Read", "Review", "Scope"]
      .map(
        (label, index) =>
          text(477, 166 + index * 74, label, 23) +
          rect(753, 141 + index * 74, 80, 34, "#314C47", 17) +
          dot(770 + 46 * p, 158 + index * 74, mint, 12),
      )
      .join("") +
    text(0, 453, "Memory is context, never permission.", 26, "#E7EDF7", 500) +
    text(0, 492, "Keep your server configuration and approvals under your control.", 18, muted)
  );
}

const illustrations = [
  monitoring,
  network,
  users,
  diagnostics,
  security,
  configuration,
  recovery,
  workspace,
];

function pageNames(index: number) {
  return NAV_GROUPS[index]!.views.map((id) => VIEWS.find((view) => view.id === id)!.label);
}

function brandMark(logo: string, x: number, y: number, size: number) {
  return `<image x="${x}" y="${y}" width="${size}" height="${size}" href="${logo}"/>`;
}

function scene(index: number, time: number, logo: string) {
  const chapter = chapters[index]!;
  const p = ease(time / 1.1);
  const slide = (1 - p) * 32;
  const light = index === 0 || index === 9;
  let content = rect(0, 0, 1920, 1080, light ? "#F5F6F3" : "#101824", 0);
  content +=
    brandMark(logo, 87, 59, 52) +
    text(157, 95, "MikroTik MCP", 26, light ? "#26332C" : "#E7EDF7", 500);
  content += text(
    1824,
    91,
    "THE DASHBOARD FILM",
    14,
    light ? "#606D63" : muted,
    500,
    'text-anchor="end" letter-spacing="3"',
  );
  if (light) {
    const isEnd = index === 9;
    content += `<g opacity="${p}" transform="translate(0 ${slide})">${text(
      96,
      367,
      isEnd ? "A LITTLE LESS CLI. A LOT MORE CLARITY." : "A HUMAN INTERFACE TO ROUTEROS",
      17,
      "#647468",
      500,
      'letter-spacing="3"',
    )}${text(89, 510, chapter.title[0]!, 112, "#243129", 600, 'letter-spacing="-6"')}${text(
      89,
      636,
      chapter.title[1]!,
      112,
      "#6E806E",
      600,
      'letter-spacing="-6"',
    )}${text(
      98,
      722,
      isEnd
        ? "Open source. Built with Bun. Yours to explore."
        : "See. Investigate. Review. Recover.",
      31,
      "#657568",
    )}</g>`;
    content += `<g transform="translate(0 ${Math.sin(time * 0.8) * 7})">${brandMark(
      logo,
      1290,
      336,
      340,
    )}</g>`;
    [0, 1, 2].forEach((n) => {
      const y = 395 + n * 130;
      content +=
        line(1200, y, 1278, y, "#C4D0C2") + dot(1200 + ((time * 25 + n * 27) % 78), y, orange, 5);
    });
    content +=
      line(96, 910, 1824, 910, "#CDD7CB") +
      text(
        96,
        967,
        isEnd ? "github.com/mikrotik-mcp/mikrotik-mcp" : "8 WORKSPACES / ONE CONNECTED VIEW",
        23,
        "#536350",
        500,
      );
    content += text(
      1824,
      967,
      isEnd ? "Your network. One conversation." : "ILLUSTRATED PRODUCT TOUR",
      16,
      "#647468",
      400,
      'text-anchor="end" letter-spacing="1"',
    );
  } else {
    const group = NAV_GROUPS[index - 1]!;
    content += text(96, 232, group.label.toUpperCase(), 17, orange, 500, 'letter-spacing="2.5"');
    content += `<g opacity="${p}" transform="translate(0 ${slide})">${text(
      90,
      342,
      chapter.title[0]!,
      63,
      "#E7EDF7",
      500,
      'letter-spacing="-2.5"',
    )}${text(90, 418, chapter.title[1]!, 63, "#A2B3C7", 500, 'letter-spacing="-2.5"')}</g>`;
    const subtitle = chapter.subtitle.split(". ");
    subtitle.forEach((value, i) => {
      content += text(96, 497 + i * 35, value, 22, muted);
    });
    const names = pageNames(index - 1);
    names.forEach((name, i) => {
      content += text(
        97,
        620 + i * 38,
        name,
        21,
        i === Math.floor(time / 0.7) % names.length ? "#E7EDF7" : "#8496AF",
        400,
      );
    });
    const zoom = 0.975 + 0.025 * ease(time / 3);
    content += `<g transform="translate(${640 + (1 - zoom) * 595} ${169 + (1 - zoom) * 380}) scale(${zoom})">${rect(
      0,
      0,
      1190,
      730,
      "#132033",
      27,
      "#344760",
    )}${line(0, 58, 1190, 58)}${[25, 43, 61].map((x) => dot(x, 29, "#536780", 4)).join("")}${text(
      100,
      35,
      `Dashboard / ${group.label}`,
      17,
      "#C2D0E4",
    )}${tag(1012, 14, "DEMO", blue)}${line(202, 58, 202, 730)}${NAV_GROUPS.map((nav, i) => {
      const selected = i === index - 1;
      return (
        (selected ? rect(14, 93 + i * 66, 174, 49, "#293D55", 10) : "") +
        dot(30, 117 + i * 66, selected ? orange : "#53667E", 3) +
        text(
          44,
          123 + i * 66,
          nav.label
            .replace("Router configuration", "Configuration")
            .replace("Backup & recovery", "Recovery")
            .replace("MCP workspace", "Workspace"),
          15,
          selected ? "#E7EDF7" : muted,
          selected ? 500 : 400,
        )
      );
    }).join("")}${text(
      24,
      692,
      "LOCAL WORKSPACE",
      10,
      muted,
      500,
      'letter-spacing="1.5"',
    )}<g transform="translate(237 136)">${illustrations[index - 1]!(time)}</g></g>`;
    content +=
      line(96, 955, 1824, 955, "#2A3849") +
      text(
        96,
        1006,
        "ILLUSTRATED INTERFACES · SYNTHETIC DATA · NOT LIVE TELEMETRY",
        13,
        muted,
        400,
        'letter-spacing="1.3"',
      ) +
      text(
        1824,
        1006,
        `${String(index).padStart(2, "0")} / 08`,
        20,
        orange,
        500,
        'text-anchor="end"',
      );
  }
  return content;
}

export function filmFrame(seconds: number, logo: string) {
  const time = Math.max(0, Math.min(FILM.duration - 1 / FILM.fps, seconds));
  const index = Math.floor(time / FILM.sceneDuration);
  const local = time % FILM.sceneDuration;
  let content = scene(index, local, logo);
  if (index > 0 && local < 0.45) {
    content = `${scene(
      index - 1,
      FILM.sceneDuration,
      logo,
    )}<g opacity="${clamp(local / 0.45)}">${content}</g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${mint}" stop-opacity=".22"/><stop offset="1" stop-color="${mint}" stop-opacity="0"/></linearGradient></defs><g font-family="Avenir Next, Helvetica Neue, Arial, sans-serif">${content}</g><rect y="1076" width="${(1920 * time) / FILM.duration}" height="4" fill="${orange}"/></svg>`;
}

export function checkFilm() {
  const encoded = text(0, 0, `<&>"' ]]></text><script>alert(1)</script>`);
  assert(
    encoded.endsWith(
      "&lt;&amp;&gt;&quot;&#x27; ]]&gt;&lt;/text&gt;&lt;script&gt;alert(1)&lt;/script&gt;</text>",
    ),
  );
  assert.equal(text(0, 0, "RADIUS & UM").includes("RADIUS &amp; UM</text>"), true);
  assert.equal(
    new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">${encoded}</svg>`, {
      font: { loadSystemFonts: false },
    }).width,
    100,
  );
  assert.equal(chapters.length * FILM.sceneDuration, FILM.duration);
  assert.deepEqual(
    chapters.slice(1, -1).map((chapter) => chapter.id),
    NAV_GROUPS.map((group) => group.id),
  );
  const covered = NAV_GROUPS.flatMap((group) => group.views);
  assert.equal(new Set(covered).size, VIEWS.length);
  assert.equal(covered.length, VIEWS.length);
  for (let i = 0; i < chapters.length; i++) {
    for (const offset of [0, 0.2, 3, 5.99]) {
      const svg = filmFrame(i * 6 + offset, "data:image/svg+xml;base64,PHN2Zy8+");
      assert(!/NaN|undefined|Infinity/.test(svg));
      assert(svg.includes('viewBox="0 0 1920 1080"'));
    }
  }
}

async function main() {
  const mode = process.argv[2];
  assert(
    ["--check", "--preview", "--render"].includes(mode ?? ""),
    "Use --check, --preview or --render",
  );
  checkFilm();
  if (mode === "--check") {
    process.stdout.write(
      `Film checked: ${chapters.length} scenes, ${VIEWS.length} pages, ${FILM.duration}s.\n`,
    );
    return;
  }
  const target = resolve(output, "dashboard-film.mp4");
  if (mode === "--render")
    assert(
      !(await Bun.file(target).exists()),
      "Output already exists; move it aside before rendering again.",
    );
  const logo = `data:image/svg+xml;base64,${(
    await readFile(resolve(import.meta.dirname, "../assets/logo-icon.svg"))
  ).toString("base64")}`;
  await mkdir(output, { recursive: true });
  const fontFiles = ["Avenir Next.ttc", "HelveticaNeue.ttc", "Menlo.ttc"]
    .map((name) => `/System/Library/Fonts/${name}`)
    .filter(existsSync);
  const render = (time: number) =>
    new Resvg(filmFrame(time, logo), {
      font: { fontFiles, loadSystemFonts: fontFiles.length === 0 },
    })
      .render()
      .asPng();
  const previews: string[] = [];
  for (let i = 0; i < chapters.length; i++) {
    const png = render(i * 6 + 3);
    await Bun.write(resolve(output, `${String(i).padStart(2, "0")}-${chapters[i]!.id}.png`), png);
    previews.push(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);
  }
  const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="2700"><rect width="1920" height="2700" fill="#101824"/>${previews.map((src, i) => `<image x="${(i % 2) * 960}" y="${Math.floor(i / 2) * 540}" width="960" height="540" href="${src}"/>`).join("")}</svg>`;
  await Bun.write(resolve(output, "storyboard.png"), new Resvg(sheet).render().asPng());
  const manifest = {
    ...FILM,
    format: "H.264 / yuv420p / silent / faststart",
    provenance:
      "Locally authored SVG motion, project logo; synthetic documentation IPs; no live router data or screen recording.",
    chapters: chapters.map((chapter, i) => ({
      ...chapter,
      startsAt: i * 6,
      pages: i > 0 && i < 9 ? pageNames(i - 1) : [],
    })),
  };
  await Bun.write(resolve(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const timestamp = (seconds: number) =>
    `00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.000`;
  await Bun.write(
    resolve(output, "chapters.vtt"),
    `WEBVTT\n\n${chapters
      .map(
        (chapter, i) =>
          `${timestamp(i * 6)} --> ${timestamp((i + 1) * 6)}\n${i === 0 || i === 9 ? chapter.subtitle : NAV_GROUPS[i - 1]!.label}\n`,
      )
      .join("\n")}`,
  );
  if (mode !== "--render") return;
  assert(Bun.which("ffmpeg"), "Install FFmpeg with libx264 to render the MP4.");
  const ffmpeg = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-n",
      "-f",
      "image2pipe",
      "-framerate",
      String(FILM.fps),
      "-vcodec",
      "png",
      "-i",
      "pipe:0",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-colorspace",
      "bt709",
      target,
    ],
    { stdin: "pipe", stdout: "inherit", stderr: "inherit" },
  );
  try {
    for (let frame = 0; frame < FILM.duration * FILM.fps; frame++) {
      await ffmpeg.stdin.write(render(frame / FILM.fps));
      await ffmpeg.stdin.flush();
      // Yield so native finalizers can run; raster buffers are larger than their JS wrappers.
      if (frame % 10 === 0) {
        await Bun.sleep(1);
        Bun.gc(true);
      }
      if (frame % (FILM.fps * 6) === 0)
        process.stdout.write(`Rendering ${chapters[Math.floor(frame / FILM.fps / 6)]!.id}…\n`);
    }
    await ffmpeg.stdin.end();
    assert.equal(
      await ffmpeg.exited,
      0,
      "FFmpeg failed; inspect the partial output before retrying.",
    );
    process.stdout.write(`Created ${target}\n`);
  } finally {
    if (ffmpeg.exitCode === null) ffmpeg.kill();
  }
}

if (import.meta.main) await main();
