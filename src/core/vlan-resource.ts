import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getVlanSegmentationGuide, VLAN_GUIDE_URI } from "./vlan-guidance";

/** Public reference text only: available even with memory off and in read-only mode. */
export function registerVlanKnowledgeResource(server: McpServer): void {
  server.registerResource(
    "vlan-segmentation-guide",
    VLAN_GUIDE_URI,
    {
      title: "RouterOS VLAN segmentation guide",
      description:
        "Read-only VLAN design, dual-stack isolation, management safety and validation guidance. No live device data.",
      mimeType: "text/markdown",
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: getVlanSegmentationGuide() }],
    }),
  );
}
