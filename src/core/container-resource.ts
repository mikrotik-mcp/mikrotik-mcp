import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CONTAINER_GUIDE_URI, getRouterosContainerGuide } from "./container-guidance";

export function registerContainerKnowledgeResource(server: McpServer): void {
  server.registerResource(
    "routeros-container-guide",
    CONTAINER_GUIDE_URI,
    {
      title: "RouterOS container operations guide",
      description:
        "Version-aware container discovery, deployment, isolation and lifecycle safety. Reference only, no live device data.",
      mimeType: "text/markdown",
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: getRouterosContainerGuide() }],
    }),
  );
}
