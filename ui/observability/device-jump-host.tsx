import { useState } from "react";
import { Network, Router } from "lucide-react";
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/beui/registry/components/motion/combobox";
import { Input } from "@/components/beui/registry/components/motion/input";
import { ScrollArea } from "@/components/ui/scroll-area";
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
      <Input
        key={key}
        label={label}
        id={`jump_${key}`}
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
        onChange={(next) => update(key, next)}
        classNames={{ field: "rounded-xl", input: "text-sm font-mono" }}
      />
    );
  };
  return (
    <section className="device-jump-host" aria-label="SSH jump host">
      <div className="device-editor__section-heading">
        <span>
          <Network size={17} /> SSH jump host
        </span>
      </div>
      <p className="device-editor__caption">
        Choose a router to reuse its connection, or enter a custom bastion address.
      </p>
      <Combobox
        value={value}
        query={query}
        onQueryChange={setQuery}
        onValueChange={choose}
        disabled={disabled}
        filter={filterOptions}
      >
        <ComboboxTrigger className="min-w-0">
          <ComboboxInput
            aria-label="Jump via device or address"
            placeholder="Search routers or type an IP / hostname…"
          />
        </ComboboxTrigger>
        <ComboboxContent className="device-jump-menu">
          <ScrollArea
            className="device-jump-menu__scroll"
            viewportProps={{ className: "device-editor__viewport" }}
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
                      <Router size={16} className="shrink-0" />
                      <span className="min-w-0">
                        <strong className="block truncate font-medium">{key}</strong>
                        <small className="block truncate text-muted-foreground">
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
      {issue && (
        <p role="alert" className="text-destructive text-xs">
          {issue}
        </p>
      )}
      {(manual || selected) && (
        <div className="device-jump-host__details">
          <p className="device-editor__caption col-span-full">
            {manual
              ? "Custom bastion · enter its own SSH credentials below."
              : `Linked to ${via}. Fields are filled automatically; credentials stay on the server. Edit that router to change them.`}
          </p>
          {field("host", "Jump host address")}
          {field("port", "Jump host port", "22")}
          {field("username", "Jump host user", "admin")}
          {field("password", "Jump host password", "", true)}
          {field("keyFilename", "Jump host key file")}
          {manual && field("keyPassphrase", "Jump host key passphrase", "", true)}
          {!manual && (
            <Input
              label="Authentication"
              value={
                host.privateKey
                  ? "Stored private key"
                  : host.keyFilename
                    ? "SSH key file"
                    : host.password
                      ? "Stored password"
                      : "No credentials configured"
              }
              readOnly
            />
          )}
          <p className="device-editor__caption col-span-full">
            SSH TCP forwarding must already be enabled on the bastion. This form does not change its
            RouterOS settings.
          </p>
        </div>
      )}
    </section>
  );
}
