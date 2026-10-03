import { z } from "zod";
import { defineTool, READ, WRITE } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { recorderInput } from "../flight-recorder/model";
import {
  getFlight,
  configureFlight,
  freezeIncident,
  exportIncident,
} from "../flight-recorder/service";
export const flightRecorderTools: ToolModule = [
  defineTool({
    name: "get_flight_recorder",
    title: "Read Network Flight Recorder",
    annotations: READ,
    description:
      "Read bounded persistent telemetry, off-router log metadata, capture gaps and frozen incidents for this router. No active probes. Times are host receipt times; correlation never proves cause, identity or a network outage.",
    inputSchema: {},
    async handler(_, ctx) {
      return JSON.stringify(await getFlight(ctx));
    },
  }),
  defineTool({
    name: "configure_flight_recorder",
    title: "Configure Network Flight Recorder",
    annotations: WRITE,
    description:
      "Explicitly enable/disable periodic read-only router collection and local retention. No router configuration writes. Stores bounded resources, interface state, classified log metadata and MCP write/failure metadata; no raw messages or credentials. Requires the MCP process to stay running. SSH polling can miss logs; not a lossless syslog service.",
    inputSchema: recorderInput.shape,
    async handler(a, ctx) {
      return JSON.stringify(await configureFlight(a, ctx));
    },
  }),
  defineTool({
    name: "freeze_network_incident",
    title: "Freeze Network Incident Evidence",
    annotations: WRITE,
    description:
      "Preserve this router's available rolling evidence plus two minutes of future samples when recording is enabled. Local operation only. Empty history stays empty; cannot recover past logs. Maximum 30 incidents, configured age retention.",
    inputSchema: { title: z.string().trim().min(1).max(120) },
    async handler(a, ctx) {
      return JSON.stringify(await freezeIncident(a.title, ctx));
    },
  }),
  defineTool({
    name: "export_network_incident",
    title: "Export Network Incident Evidence",
    annotations: READ,
    description:
      "Export a device-scoped frozen incident with coverage gaps and separate router/receive timestamps. No raw logs or command bodies. Review device/interface names before sharing. Do not attribute an attack to a user based only on these observations.",
    inputSchema: { id: z.uuid() },
    async handler(a, ctx) {
      return JSON.stringify(await exportIncident(a.id, ctx));
    },
  }),
];
