/**
 * Device Capabilities — what this router can actually do.
 *
 * RouterOS is not one platform: the wireless stack, container support, PoE and
 * several optional packages differ per device. `src/core/capability-probe.ts`
 * learns those facts once per device (cached 6 h) and the registry uses them to
 * stop a tool before it produces a parser error.
 *
 * These two tools expose that model. `get_device_capabilities` is the one to
 * reach for when a tool reported "not available on this device" and you want to
 * know exactly what is missing; `refresh_device_capabilities` forces a reprobe
 * after installing a package or upgrading firmware.
 */
import { READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { getCapabilities, invalidateCapabilities } from "../core/capability-cache";
import type { Capabilities } from "../core/capability";
import { resolveDeviceName } from "../core/runtime";

/** Human-readable summary of one probed device. */
function render(deviceName: string, caps: Capabilities): string {
  const lines: string[] = [`DEVICE CAPABILITIES — ${deviceName}`, ""];

  if (!caps.version && caps.packages.size === 0 && !caps.board) {
    return (
      `${lines.join("\n")}The probe returned nothing usable — the device may be unreachable, or it ` +
      `answered none of the probe commands.\n\nNothing is being gated: when a capability is ` +
      `unknown, tools run normally and RouterOS decides for itself.`
    );
  }

  lines.push(
    `RouterOS:      ${caps.version?.raw ?? "unknown"}${caps.channel !== "unknown" ? ` (${caps.channel})` : ""}`,
    `Board:         ${caps.board || "unknown"}${caps.arch ? ` · ${caps.arch}` : ""}`,
    `RouterBOARD:   ${caps.isRouterBoard ? "yes" : "no (CHR / x86 / unknown)"}`,
    `Wireless:      ${wirelessLabel(caps)}`,
    "",
  );

  lines.push(
    "DEVICE MODE (7.13+ permissions)",
    `  container:   ${caps.deviceMode.container ? "allowed" : "BLOCKED"}`,
    `  scheduler:   ${caps.deviceMode.scheduler ? "allowed" : "BLOCKED"}`,
    `  fetch:       ${caps.deviceMode.fetch ? "allowed" : "BLOCKED"}`,
    "",
  );

  const pkgs = [...caps.packages].sort();
  lines.push(
    `ENABLED PACKAGES (${pkgs.length})`,
    pkgs.length > 0 ? `  ${pkgs.join(", ")}` : "  none reported",
    "",
  );

  const notes = unlockNotes(caps);
  if (notes.length > 0)
    lines.push("WHAT THIS UNLOCKS OR BLOCKS", ...notes.map((n) => `  ${n}`), "");

  lines.push(
    `Probed at ${new Date(caps.probedAt).toISOString()} · cached 6h · ` +
      "use refresh_device_capabilities to reprobe after a package install or upgrade.",
  );
  return lines.join("\n");
}

function wirelessLabel(caps: Capabilities): string {
  switch (caps.wirelessStack) {
    case "wifi":
      return "/interface wifi (RouterOS 7 wifiwave2)";
    case "wireless":
      return "/interface wireless (legacy)";
    case "capsman-legacy":
      return "/caps-man (legacy CAPsMAN controller)";
    default:
      return "none detected (wired-only, or the probe could not tell)";
  }
}

/** The consequences worth stating, rather than a mechanical field dump. */
function unlockNotes(caps: Capabilities): string[] {
  const out: string[] = [];
  const has = (p: string): boolean => caps.packages.has(p);

  if (has("container") && caps.deviceMode.container) {
    out.push("✓ Container tools available (`container` package + device-mode both OK).");
  } else if (has("container") && !caps.deviceMode.container) {
    out.push(
      "✗ Container tools BLOCKED — the package is installed but device-mode `container` is " +
        "off. Enabling it needs a physical reset-button confirmation on the router.",
    );
  } else if (caps.probedAt > 0) {
    out.push("✗ Container tools unavailable — the `container` package is not installed/enabled.");
  }

  if (has("user-manager")) out.push("✓ User Manager (RADIUS) tools available.");
  else if (caps.probedAt > 0)
    out.push("✗ User Manager tools unavailable — the `user-manager` package is not enabled.");

  if (!caps.isRouterBoard && caps.probedAt > 0) {
    out.push("✗ PoE tools unavailable — PoE-out is RouterBOARD hardware; this is not one.");
  }

  if (caps.wirelessStack === "none" && caps.probedAt > 0) {
    out.push(
      "· No wireless stack detected. Wireless tools are NOT gated on this — they probe each " +
        "command path per call, so they still work if the device does have radios.",
    );
  }
  return out;
}

export const capabilityTools: ToolModule = [
  defineTool({
    name: "get_device_capabilities",
    title: "Get Device Capabilities",
    annotations: READ,
    description:
      "Reports what this RouterOS device can actually do — version and release channel, board and" +
      " architecture, whether it is a RouterBOARD, which wireless stack it answers on" +
      " (`/interface wifi` vs legacy `/interface wireless` vs `/caps-man`), enabled optional" +
      " packages, and RouterOS 7.13+ device-mode permissions. Also states what those facts unlock" +
      " or block. Use this when a tool reported that it is 'not available on this device' and you" +
      " need to know exactly what is missing, or before suggesting a feature that needs a package." +
      " Probed once per device and cached for 6 hours; call refresh_device_capabilities to force a" +
      " reprobe. Read-only.",
    inputSchema: {},
    async handler(_a, ctx) {
      const name = resolveDeviceName(ctx.device);
      ctx.info(`Reading device capabilities: ${name}`);
      return render(name, await getCapabilities(ctx.device));
    },
  }),

  defineTool({
    name: "refresh_device_capabilities",
    title: "Refresh Device Capabilities",
    annotations: READ,
    description:
      "Discards the cached capability probe for this device and probes again immediately," +
      " bypassing the 6-hour TTL. Use after installing or enabling a RouterOS package, upgrading" +
      " firmware, or changing device-mode — anything that changes what the router supports." +
      " Returns the freshly probed capabilities. Read-only: it runs `/system` print commands and" +
      " changes nothing on the device.",
    inputSchema: {},
    async handler(_a, ctx) {
      const name = resolveDeviceName(ctx.device);
      ctx.info(`Refreshing device capabilities: ${name}`);
      invalidateCapabilities(ctx.device);
      return render(name, await getCapabilities(ctx.device));
    },
  }),
];
