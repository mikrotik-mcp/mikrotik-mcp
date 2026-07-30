/**
 * Explain command — the architecture document for a router, read in the
 * launcher.
 *
 * This is the one feature in the extension whose output is *natively* Markdown,
 * and Raycast's `Detail` is genuinely good at Markdown — so the whole command is
 * a device list that opens into the document, with the actions people actually
 * want: copy it, save it, open it in the dashboard.
 *
 * Read-only throughout. `/export` is a print; nothing here writes to a router.
 */
import {
  Action,
  ActionPanel,
  Color,
  Detail,
  Icon,
  List,
  Toast,
  open,
  showToast,
} from "@raycast/api";
import { useState } from "react";
import { withToken } from "./lib/api";
import { useApi } from "./lib/hooks";
import type { DevicesPayload, ExplainPayload } from "./lib/types";

/** The sections `explain_section` (and the API) accept. */
const SECTIONS = [
  { id: "", label: "Everything" },
  { id: "exposure", label: "Exposed to the internet" },
  { id: "identity", label: "What this device is" },
  { id: "topology", label: "Topology" },
  { id: "addressing", label: "Addressing" },
  { id: "internet", label: "Internet path" },
  { id: "firewall", label: "Firewall" },
  { id: "vpn", label: "VPN and tunnels" },
  { id: "services", label: "Management services" },
  { id: "unknowns", label: "What is not covered" },
] as const;

const SEVERITY_COLOR: Record<string, Color> = {
  critical: Color.Red,
  high: Color.Orange,
  medium: Color.Yellow,
  low: Color.Blue,
};

function Document({ device }: { device: string }) {
  const [section, setSection] = useState("");
  const path = section
    ? `/api/explain/${encodeURIComponent(device)}/section/${section}`
    : `/api/explain/${encodeURIComponent(device)}`;
  const { data, isLoading, error, revalidate } = useApi<ExplainPayload>(path);

  if (error && !data) {
    return (
      <Detail
        markdown={`# Could not explain ${device}\n\n${error.message}\n\nThe dashboard must be running, and the device reachable.`}
        actions={
          <ActionPanel>
            <Action
              title="Retry"
              icon={Icon.ArrowClockwise}
              onAction={revalidate}
            />
          </ActionPanel>
        }
      />
    );
  }

  const markdown =
    data?.markdown ?? `# ${device}\n\nReading the configuration…`;
  const narrative = data?.narrative;
  const exposure = narrative?.exposure ?? [];

  return (
    <Detail
      isLoading={isLoading}
      markdown={markdown}
      navigationTitle={narrative?.identity.name ?? device}
      metadata={
        narrative ? (
          <Detail.Metadata>
            <Detail.Metadata.Label
              title="Role"
              text={narrative.identity.roles.primary?.label ?? "unknown"}
            />
            {narrative.identity.roles.secondary.length > 0 && (
              <Detail.Metadata.Label
                title="Also"
                text={narrative.identity.roles.secondary
                  .map((r) => r.label)
                  .join(", ")}
              />
            )}
            <Detail.Metadata.Separator />
            <Detail.Metadata.TagList title="Exposed">
              {exposure.length === 0 ? (
                <Detail.Metadata.TagList.Item
                  text="nothing unrestricted"
                  color={Color.Green}
                />
              ) : (
                exposure
                  .slice(0, 4)
                  .map((e) => (
                    <Detail.Metadata.TagList.Item
                      key={`${e.kind}-${e.what}-${e.line}`}
                      text={`${e.what} (${e.from})`}
                      color={SEVERITY_COLOR[e.severity] ?? Color.SecondaryText}
                    />
                  ))
              )}
            </Detail.Metadata.TagList>
            <Detail.Metadata.Separator />
            <Detail.Metadata.Label
              title="Subnets"
              text={String(narrative.subnets.length)}
            />
            <Detail.Metadata.Label
              title="Interfaces"
              text={String(narrative.interfaces.length)}
            />
            <Detail.Metadata.Label
              title="Not covered"
              text={
                narrative.unknowns.length === 0
                  ? "everything was recognised"
                  : `${narrative.unknowns.length} menu(s)`
              }
            />
            {narrative.identity.version && (
              <Detail.Metadata.Label
                title="RouterOS"
                text={narrative.identity.version}
              />
            )}
            <Detail.Metadata.Label title="Source" text={data?.source ?? "—"} />
          </Detail.Metadata>
        ) : undefined
      }
      actions={
        <ActionPanel>
          <ActionPanel.Section>
            <Action.CopyToClipboard
              title="Copy as Markdown"
              icon={Icon.Clipboard}
              content={markdown}
            />
            {data?.mermaid && (
              <Action.CopyToClipboard
                title="Copy Topology Diagram"
                icon={Icon.Network}
                // Mermaid source, fenced — most wikis render it as a diagram.
                content={`\`\`\`mermaid\n${data.mermaid}\n\`\`\``}
              />
            )}
            <Action
              title="Save to File"
              icon={Icon.SaveDocument}
              onAction={async () => {
                const { writeFile } = await import("node:fs/promises");
                const { homedir } = await import("node:os");
                const { join } = await import("node:path");
                const name = `${narrative?.identity.name ?? device}-narrative.md`;
                const path = join(homedir(), "Downloads", name);
                try {
                  await writeFile(path, markdown, "utf8");
                  await showToast({
                    style: Toast.Style.Success,
                    title: `Saved to ${path}`,
                  });
                } catch (e) {
                  await showToast({
                    style: Toast.Style.Failure,
                    title: "Could not save",
                    message: e instanceof Error ? e.message : String(e),
                  });
                }
              }}
            />
          </ActionPanel.Section>
          <ActionPanel.Section title="Section">
            {SECTIONS.map((s) => (
              <Action
                key={s.id || "all"}
                title={s.label}
                icon={s.id === section ? Icon.CheckCircle : Icon.Circle}
                onAction={() => setSection(s.id)}
              />
            ))}
          </ActionPanel.Section>
          <ActionPanel.Section>
            <Action
              title="Open in Dashboard"
              icon={Icon.Globe}
              onAction={() => open(withToken("/#explain"))}
            />
            <Action
              title="Refresh"
              icon={Icon.ArrowClockwise}
              onAction={revalidate}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

export default function Command() {
  const { data, isLoading } = useApi<DevicesPayload>("/api/devices");
  const devices = (data?.devices ?? []).filter((d) => !d.disabled);

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Which router should I explain?"
    >
      {devices.map((d) => (
        <List.Item
          key={d.name}
          icon={{
            source: Icon.Document,
            tintColor:
              d.status.reachable === false ? Color.Red : Color.PrimaryText,
          }}
          title={d.name}
          subtitle={d.status.identity ?? d.address ?? `${d.host}:${d.port}`}
          accessories={[
            { text: d.status.version ?? "" },
            d.status.reachable === false
              ? { tag: { value: "offline", color: Color.Red } }
              : {},
          ]}
          actions={
            <ActionPanel>
              <Action.Push
                title="Explain"
                icon={Icon.Book}
                target={<Document device={d.name} />}
              />
            </ActionPanel>
          }
        />
      ))}
      {!isLoading && devices.length === 0 && (
        <List.EmptyView
          title="No devices"
          description="Configure a device, or check the dashboard URL in the extension preferences."
        />
      )}
    </List>
  );
}
