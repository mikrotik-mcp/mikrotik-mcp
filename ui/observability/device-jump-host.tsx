import { useState } from "react";
import { Route } from "lucide-react";
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/beui/registry/components/motion/combobox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { setDraftField } from "../../src/config-device-draft";

type Draft = Record<string, unknown>;
const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const object = (value: unknown): Draft =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Draft) : {};
const addressValid = (value: string) => !!value.trim() && !/[\s/]/.test(value);
const filterOptions = (value: string, query: string, keywords: string[]) =>
  value === "manual" ||
  !query.trim() ||
  [value, ...keywords].join(" ").toLowerCase().includes(query.trim().toLowerCase());

/** Match the transport's inline-first resolution and reject unusable draft chains. */
export function jumpHostIssue(device: Draft, devices: Record<string, Draft>, name: string): string {
  const seen = new Set([name]);
  let hop = device;
  while (true) {
    if (hop.jumpHost) {
      const host = object(hop.jumpHost);
      if (!addressValid(text(host.host)))
        return "Enter a jump-host IP or hostname, without a URL or spaces.";
      const port = Number(host.port ?? 22);
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        return "Jump-host port must be from 1 to 65535.";
      if (!text(host.username ?? "admin").trim()) return "Enter the jump-host username.";
      return "";
    }
    if (!hop.jumpVia) return "";
    const via = text(hop.jumpVia);
    if (seen.has(via)) return "This route would create a jump-host cycle.";
    seen.add(via);
    if (!Object.hasOwn(devices, via)) return `Router “${via}” is no longer in this draft.`;
    hop = devices[via];
    if (hop.mac) return "MAC-Telnet routers cannot be SSH jump hosts.";
    if (hop.disabled) return "Enable this router in MCP before using it as a jump host.";
    if (!addressValid(text(hop.host))) return "This router needs a valid SSH address first.";
  }
}

/** Keep a device reference, not a copy of its secrets; show its effective fields read-only. */
export function DeviceJumpHost({
  device,
  devices,
  name,
  disabled,
  onChange,
}: {
  device: Draft;
  devices: Record<string, Draft>;
  name: string;
  disabled: boolean;
  onChange: (device: Draft) => void;
}) {
  const [query, setQuery] = useState("");
  const manual = !!device.jumpHost;
  const via = manual ? "" : text(device.jumpVia);
  const selected = via && Object.hasOwn(devices, via) ? devices[via] : undefined;
  const host = manual ? object(device.jumpHost) : (selected ?? {});
  const value = manual ? "manual" : via ? `device:${via}` : "direct";
  const issue = jumpHostIssue(device, devices, name);
  const choose = (choice: string) => {
    if (disabled) return;
    const { jumpVia: _via, jumpHost: _host, ...rest } = device;
    onChange(
      choice === "direct"
        ? rest
        : choice === "manual"
          ? {
              ...rest,
              jumpHost:
                manual && (!query.trim() || query.trim() === host.host)
                  ? host
                  : { host: query.trim(), port: 22, username: "admin" },
            }
          : { ...rest, jumpVia: choice.slice(7) },
    );
    setQuery("");
  };
  const update = (key: string, next: string) => {
    // Never carry credentials to a different manually entered bastion.
    const changed =
      key === "host" && next !== host.host
        ? { ...device, jumpHost: { host: next, port: host.port, username: host.username } }
        : setDraftField(device, `jumpHost.${key}`, key === "port" && next ? Number(next) : next);
    onChange(changed);
  };
  const field = (key: string, label: string, fallback = "", secret = false) => {
    const stored = host[key] === "«redacted»";
    return (
      <label key={key} className="monitor-fl">
        <span className="monitor-label">{label}</span>
        <input
          id={`jump_${key}`}
          className={cn("monitor-input", !secret && "font-mono")}
          readOnly={!manual}
          type={secret ? "password" : key === "port" ? "number" : "text"}
          value={stored || (!manual && secret) ? "" : text(host[key] ?? fallback)}
          placeholder={
            stored || (!manual && secret && host[key])
              ? "Stored securely · reused automatically"
              : secret
                ? "Optional"
                : "Not set"
          }
          autoComplete={secret ? "new-password" : "off"}
          onChange={(e) => update(key, e.target.value)}
        />
      </label>
    );
  };
  const summary = selected
    ? `${text(selected.host)}${selected.mac ? " · MAC-Telnet" : " · SSH"}`
    : manual
      ? `port ${text(host.port ?? 22)} · custom bastion`
      : "";
  return (
    <div className="monitor-fl" aria-label="SSH jump host" role="group">
      <span className="monitor-label">Jump host</span>
      <Combobox
        value={value}
        query={query}
        onQueryChange={setQuery}
        onValueChange={choose}
        disabled={disabled}
        filter={filterOptions}
      >
        <ComboboxTrigger className="dv-combo">
          <span className="flex min-w-0 items-center gap-2">
            <Route aria-hidden="true" className="text-muted-foreground size-4 flex-none" />
            <ComboboxInput
              aria-label="Jump via device or address"
              placeholder="Direct, or search routers and addresses"
              wrapperClassName={cn(
                "dv-combo-input",
                value === "direct" ? "min-w-0 flex-1" : "flex-none",
              )}
              className={cn(
                "h-8 text-[13px]",
                value !== "direct" && "dv-fit font-mono text-[12px]",
              )}
            />
            {summary && (
              <span className="text-muted-foreground truncate text-[12px] leading-[21px]">
                {summary}
              </span>
            )}
          </span>
        </ComboboxTrigger>
        <ComboboxContent className="device-jump-menu">
          <ScrollArea
            className="h-[min(260px,var(--combobox-available-height))]"
            viewportProps={{ className: "[&>div]:!block" }}
          >
            <ComboboxList ariaLabel="Jump hosts" className="max-h-none overflow-visible">
              <ComboboxItem value="direct" textValue="Direct connection · no jump host">
                Direct connection · no jump host
              </ComboboxItem>
              {Object.entries(devices)
                .filter(([key]) => key !== name)
                .map(([key, router]) => {
                  const reason = jumpHostIssue({ jumpVia: key }, devices, name);
                  return (
                    <ComboboxItem
                      key={key}
                      value={`device:${key}`}
                      textValue={key}
                      disabled={!!reason}
                      keywords={[key, text(router.host)]}
                    >
                      <span className="min-w-0">
                        <strong className="block truncate font-mono font-medium">{key}</strong>
                        <small className="text-muted-foreground block truncate">
                          {reason ||
                            `${text(router.host)}:${text(router.port ?? 22)} · ${text(router.username ?? "admin")}`}
                        </small>
                      </span>
                    </ComboboxItem>
                  );
                })}
              <ComboboxItem
                value="manual"
                textValue={manual ? text(host.host) || "Custom address" : "Custom address"}
                disabled={!!query.trim() && !addressValid(query.trim())}
              >
                {query.trim()
                  ? `Use “${query.trim()}” as a custom address`
                  : "Enter a custom address…"}
              </ComboboxItem>
            </ComboboxList>
          </ScrollArea>
        </ComboboxContent>
      </Combobox>
      {issue ? (
        <span role="alert" className="monitor-err">
          {issue}
        </span>
      ) : via ? (
        <span className="monitor-hint">
          MCP connects to {via} first, then opens a tunnel to this router.
        </span>
      ) : manual ? (
        <span className="monitor-hint">
          MCP connects to the bastion first, then opens a tunnel to this router. SSH TCP forwarding
          must already be on there.
        </span>
      ) : null}
      {manual && (
        <div className="mt-2 grid grid-cols-2 gap-3 max-sm:grid-cols-1">
          {field("host", "Bastion address")}
          {field("port", "Bastion port", "22")}
          {field("username", "Bastion user", "admin")}
          {field("password", "Bastion password", "", true)}
          {field("keyFilename", "Bastion key file")}
          {field("keyPassphrase", "Bastion key passphrase", "", true)}
        </div>
      )}
    </div>
  );
}
