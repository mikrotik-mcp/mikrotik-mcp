import { useId } from "react";
import { AlertTriangle } from "lucide-react";
import { isWildcard, routingDomain } from "../../src/service-routing/domain";
import { CheckRow } from "./service-routing-ui";

export function RoutingDomainFields({
  domain,
  onDomain,
  dnsConfirmed,
  onDnsConfirmed,
  primary,
}: {
  domain: string;
  onDomain: (value: string) => void;
  dnsConfirmed: boolean;
  onDnsConfirmed: (value: boolean) => void;
  primary: string;
}) {
  const id = useId();
  const parsed = routingDomain.safeParse(domain);
  const wildcard = isWildcard(domain.trim());
  const invalid = !!domain && !parsed.success;
  return (
    <section className="route-domain monitor-fl" aria-label="Domain matching">
      <label className="monitor-label" htmlFor={id}>
        Domain or wildcard
      </label>
      <input
        id={id}
        className="monitor-input font-mono"
        value={domain}
        onChange={(e) => onDomain(e.target.value)}
        placeholder="api.example.com or *.example.com"
        spellCheck={false}
        autoCapitalize="none"
        aria-invalid={invalid}
        aria-describedby={`${id}-help`}
      />
      {invalid ? (
        <span id={`${id}-help`} className="monitor-err" role="alert">
          {parsed.error.issues[0].message}
        </span>
      ) : (
        <span id={`${id}-help`} className="monitor-hint" aria-label="Route preview">
          <span className="font-mono text-fg-secondary">{domain.trim() || "your.domain"}</span> →{" "}
          {primary ? (
            <span className="font-mono text-fg-secondary">{primary}</span>
          ) : (
            "choose an exit below"
          )}
        </span>
      )}
      {wildcard && (
        <div className="monitor-note" data-tone="warn">
          <AlertTriangle aria-hidden="true" className="text-warning" />
          <div className="flex min-w-0 flex-1 flex-col gap-2 text-fg-secondary">
            <span>
              <b>Wildcards learn addresses from DNS.</b> The router adds an address when a client
              looks the name up, so the first connection to a new address may use the main route. It
              matches subdomains at any depth, not{" "}
              <span className="font-mono">{domain.trim().slice(2)}</span> itself.
            </span>
            <span>
              Clients must use this router as DNS. External DNS, client DoH/DoT and cached answers
              can skip learning. Needs RouterOS 7.17 or later, with router DNS already enabled and
              protected.
            </span>
            <CheckRow checked={dnsConfirmed} onChange={onDnsConfirmed}>
              I confirm clients use this router as DNS, and I accept shared-IP routing and the
              adlist bypass for matching names
            </CheckRow>
            <span className="text-muted-foreground text-[12px]">
              MCP doesn't redirect DNS, open port 53, clear caches or change DHCP. The wildcard
              entry affects matching DNS answers for every DNS client; routing still applies only to
              the client subnets below.
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
