import { Globe2, Plus, Star, Trash2 } from "lucide-react";
import { Input } from "@/components/beui/registry/components/motion/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "./geist";
import "./device-addresses.css";

/** Preserve host as the canonical Primary; the rest are ordered fallbacks. */
export function DeviceAddressesEditor({
  host,
  fallbackHosts,
  onChange,
}: {
  host: string;
  fallbackHosts: string[];
  onChange: (host: string, fallbackHosts: string[]) => void;
}) {
  const hosts = [host, ...fallbackHosts];
  const change = (next: string[]) => onChange(next[0], next.slice(1));
  return (
    <section className="device-addresses" aria-label="Management addresses">
      <header>
        <div>
          <Globe2 size={18} />
          <strong>One router. Multiple ways in.</strong>
        </div>
        <span className="device-addresses__auto">Automatic failover</span>
      </header>
      <p>
        Add internal, VPN or public static IPs belonging to this same router. Primary is tried first, then
        alternatives.
      </p>
      <ScrollArea
        className="device-addresses__scroll"
        viewportProps={{
          "aria-label": "Management address list",
          className: "device-addresses__viewport",
        }}
      >
        <div className="device-addresses__list">
          {hosts.map((value, index) => (
            <div className="device-addresses__row" data-primary={index === 0} key={index}>
              <span className="device-addresses__order">{String(index + 1).padStart(2, "0")}</span>
              <Input
                id={index === 0 ? "f_host" : `f_fallback_${index}`}
                aria-label={index === 0 ? "Host / IP" : `Alternate IP ${index}`}
                value={value}
                placeholder={index === 0 ? "192.168.88.1" : "203.0.113.10 or IPv6"}
                onChange={(v) => change(hosts.map((h, i) => (i === index ? v.trim() : h)))}
                autoComplete="off"
                spellCheck={false}
                classNames={{ field: "rounded-lg", input: "font-mono text-sm" }}
              />
              <button
                type="button"
                className="device-addresses__primary"
                aria-label={
                  index === 0
                    ? "Primary address"
                    : `Make ${value || `address ${index + 1}`} primary`
                }
                aria-pressed={index === 0}
                disabled={!value.trim()}
                onClick={() => change([value, ...hosts.filter((_, i) => i !== index)])}
              >
                <Star size={14} fill={index === 0 ? "currentColor" : "none"} />
                <span>{index === 0 ? "Primary" : "Set primary"}</span>
              </button>
              <button
                type="button"
                className="device-addresses__remove"
                aria-label={`Remove address ${index + 1}`}
                disabled={hosts.length === 1}
                onClick={() => change(hosts.filter((_, i) => i !== index))}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      </ScrollArea>
      <footer>
        <Button
          size="sm"
          ghost
          disabled={hosts.length >= 8}
          onClick={() => change([...hosts, ""])}
          icon={<Plus size={14} />}
        >
          Add address
        </Button>
        <span>{hosts.length} / 8 addresses · shared credentials & ports</span>
      </footer>
    </section>
  );
}
