import { useEffect, useState } from "react";
import ipaddr from "ipaddr.js";
import { Network } from "lucide-react";
import { api } from "./api";
import type { IpGeo } from "../../src/observability/geo";

/** CIDRs describe a scope, not a single organization: look up only their stated IP. */
export function networkIp(value: string): string | null {
  const text = value.trim();
  if (!/^[\da-f:.]+(?:\/\d{1,3})?$/i.test(text)) return null;
  const address = text.split("/")[0];
  if (!address.includes(":") && !ipaddr.IPv4.isValidFourPartDecimal(address)) return null;
  try {
    return (text.includes("/") ? ipaddr.parseCIDR(text)[0] : ipaddr.parse(text)).toString();
  } catch {
    return null;
  }
}

/** Small, non-blocking annotation for both saved addresses and live input drafts. */
export function IpNetwork({ address }: { address: string }) {
  const ip = networkIp(address);
  const [result, setResult] = useState<{ ip: string; geo: IpGeo }>();
  useEffect(() => {
    if (!ip) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const load = async () => {
      try {
        const geo = await api<IpGeo>(
          `/api/ip-network?ip=${encodeURIComponent(ip)}`,
          AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
        );
        if (abort.signal.aborted) return;
        if (!["pending", "resolved", "private", "unavailable"].includes(geo.status))
          throw new Error("Invalid network response");
        setResult({ ip, geo });
        if (geo.status === "pending") {
          if (++attempts < 30) timer = setTimeout(() => void load(), 2000);
          else setResult({ ip, geo: { status: "unavailable" } });
        }
      } catch {
        if (!abort.signal.aborted) setResult({ ip, geo: { status: "unavailable" } });
      }
    };
    // Debounce editing; cleanup cancels old IPs and pending polls when a row leaves the page.
    timer = setTimeout(() => void load(), 400);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [ip]);
  if (!ip) return null;
  const geo = result?.ip === ip ? result.geo : undefined;
  const known = geo?.status === "resolved" && (geo.asnOrganization || geo.asn);
  const label = known
    ? geo.asnOrganization || geo.asn
    : geo?.status === "private"
      ? "Private network"
      : geo && geo.status !== "pending"
        ? "ASN unavailable"
        : "Looking up ASN…";
  const title = [
    ip,
    geo?.asnOrganization,
    geo?.asn,
    geo?.country,
    address.includes("/") ? "Organization of this IP, not necessarily the whole subnet" : label,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"
      title={title}
      aria-label={`Network for ${ip}: ${label}${known && geo.asn ? ` · ${geo.asn}` : ""}`}
    >
      <Network size={12} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{label}</span>
      {known && geo.asnOrganization && geo.asn && (
        <span
          className="shrink-0 rounded border border-border/60 px-1 font-mono text-[10px]"
          dir="ltr"
        >
          {geo.asn}
        </span>
      )}
    </span>
  );
}
