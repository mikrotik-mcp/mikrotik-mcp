import { Plus, X } from "lucide-react";
import { MonitorButton } from "./monitoring-ui";

/** Keep host as the canonical primary; the rest are fallbacks, tried in order. */
export function DeviceAddressesEditor({
  host,
  fallbackHosts,
  onChange,
  invalid = false,
}: {
  host: string;
  fallbackHosts: string[];
  onChange: (host: string, fallbackHosts: string[]) => void;
  invalid?: boolean;
}) {
  const hosts = [host, ...fallbackHosts];
  const change = (next: string[]) => onChange(next[0], next.slice(1));
  return (
    <>
      <div className="dv-addr-box" role="group" aria-label="Management addresses">
        {hosts.map((value, index) => (
          <div className="dv-addr-row" data-primary={index === 0} key={index}>
            <span className="text-muted-foreground w-4 flex-none font-mono text-[11px]">
              {index + 1}
            </span>
            <input
              id={index === 0 ? "f_host" : `f_fallback_${index}`}
              className="monitor-input h-8 flex-1 font-mono"
              aria-label={index === 0 ? "Host / IP" : `Alternate IP ${index}`}
              aria-invalid={invalid && !value.trim() ? true : undefined}
              value={value}
              placeholder={index === 0 ? "192.168.88.1" : "203.0.113.10 or IPv6"}
              onChange={(e) =>
                change(hosts.map((h, i) => (i === index ? e.target.value.trim() : h)))
              }
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
            />
            {index === 0 ? (
              <span className="monitor-chip">Primary</span>
            ) : (
              <MonitorButton
                size="sm"
                variant="ghost"
                aria-label={`Make ${value || `address ${index + 1}`} primary`}
                disabled={!value.trim()}
                onClick={() => change([value, ...hosts.filter((_, i) => i !== index)])}
              >
                Set primary
              </MonitorButton>
            )}
            <MonitorButton
              size="sm"
              variant="ghost"
              aria-label={`Remove ${value || `address ${index + 1}`}`}
              disabled={hosts.length === 1}
              icon={<X aria-hidden="true" />}
              onClick={() => change(hosts.filter((_, i) => i !== index))}
            />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <MonitorButton
          size="sm"
          variant="ghost"
          className="pl-0"
          disabled={hosts.length >= 8}
          icon={<Plus aria-hidden="true" />}
          onClick={() => change([...hosts, ""])}
        >
          Add address
        </MonitorButton>
        <span className="monitor-hint flex-1 text-right">Up to 8. MCP tries them in order.</span>
      </div>
    </>
  );
}
