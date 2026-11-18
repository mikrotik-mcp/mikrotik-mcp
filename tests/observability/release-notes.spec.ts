import { describe, expect, test } from "vite-plus/test";
import { parseRelease, releasedAgo } from "../../ui/observability/release-notes";

const BODY = [
  "# MikroTik MCP 6.15.0",
  "",
  "## Highlights",
  "",
  "### A Terminal in the dashboard",
  "",
  "- **Blocks** — each command is a block.",
  "",
  "**While you type**",
  "",
  "- `↑` and `↓` walk the blocks. Press `Ctrl+F` to find.",
  "",
  "### Devices in `mikrotik-mcp-service status`",
  "",
  "A new panel.",
  "",
  "## Fixes",
  "",
  "- **HTTP:** a server bound to localhost rejected requests.",
  "- **SSH:** no more warnings.",
  "",
  "## New settings",
  "",
  "| Setting | Default |",
  "| ------- | ------- |",
  "| `mcp.sessionIdleTimeout` | `86400000` |",
  "",
  "## Upgrade notes",
  "",
  "- **Shared service:** run `mikrotik-mcp-upgrade`.",
  "- No configuration change is required.",
  "",
  "## Docker",
  "",
  "```bash",
  "docker pull alimaster/mikrotik-mcp:6.15.0",
  "```",
  "",
  "**Full changelog:** https://github.com/mikrotik-mcp/mikrotik-mcp/compare/6.14.0...6.15.0",
].join("\r\n");

describe("parseRelease", () => {
  const r = parseRelease(BODY);

  test("one numbered section per ## heading, with a kind and a count", () => {
    expect(r.sections.map((s) => [s.index, s.title, s.kind, s.count])).toEqual([
      ["01", "Highlights", "features", 2],
      ["02", "Fixes", "fixes", 2],
      ["03", "New settings", "settings", 1],
      ["04", "Upgrade notes", "upgrade", 2],
      ["05", "Docker", "plain", null],
    ]);
    expect(r.sections.map((s) => s.short)).toEqual([
      "Highlights",
      "Fixes",
      "Settings",
      "Upgrade",
      "Docker",
    ]);
  });

  test("### headings become features; titles keep their code, escaped", () => {
    const [first, second] = r.sections[0]!.features;
    expect(first!.title).toBe("A Terminal in the dashboard");
    expect(second!.title).toBe("Devices in mikrotik-mcp-service status");
    expect(second!.titleHtml).toBe("Devices in <code>mikrotik-mcp-service status</code>");
    expect(first!.html).toContain('<p class="rn-h4">While you type</p>');
    expect(first!.html).toContain("<strong>Blocks</strong>: each command");
    expect(first!.html).toContain("<kbd>↑</kbd>");
    expect(first!.html).toContain("<kbd>Ctrl+F</kbd>");
  });

  test("fix scopes become tags, upgrade notes a callout, code a copyable command", () => {
    expect(r.sections[1]!.introHtml).toContain('<span class="rn-scope">HTTP</span>A server');
    expect(r.sections[3]!.introHtml).toMatch(
      /^\s*<div class="rn-callout">.*Read before you update/s,
    );
    const docker = r.sections[4]!.introHtml;
    expect(docker).toContain('<div class="rn-cmd">');
    expect(docker).not.toContain("<p><div");
    expect(docker).toContain("Full changelog: 6.14.0 → 6.15.0");
    expect(r.previousVersion).toBe("6.14.0");
  });

  test("markup in the body stays escaped", () => {
    const x = parseRelease("## Fixes\n\n- **UI:** <script>alert(1)</script>");
    expect(x.sections[0]!.introHtml).not.toContain("<script>");
    expect(x.sections[0]!.introHtml).toContain("&lt;script&gt;");
  });

  test("a body without headings has no sections", () => {
    const x = parseRelease("Just a note.");
    expect(x.sections).toEqual([]);
    expect(x.introHtml).toContain("Just a note.");
    expect(x.previousVersion).toBeNull();
  });
});

test("releasedAgo counts calendar days", () => {
  const now = new Date(2026, 10, 18, 9, 0).getTime();
  expect(releasedAgo(new Date(2026, 10, 17, 22, 0).toISOString(), now)).toBe("yesterday");
  expect(releasedAgo(new Date(2026, 10, 18, 1, 0).toISOString(), now)).toBe("today");
  expect(releasedAgo(new Date(2026, 9, 1).toISOString(), now)).toBe("");
});
