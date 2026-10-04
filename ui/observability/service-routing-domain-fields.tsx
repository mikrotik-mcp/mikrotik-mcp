import { useId } from "react";
import { ArrowRight, Globe2, Asterisk, ShieldCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { isWildcard, routingDomain } from "../../src/service-routing/domain";
import "./service-routing-domain.css";

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
  return (
    <section className="route-domain ops-field--wide" aria-label="Domain matching">
      <label htmlFor={id}>Domain or wildcard</label>
      <Input
        id={id}
        value={domain}
        onChange={(e) => onDomain(e.target.value)}
        placeholder="api.example.com or *.example.com"
        spellCheck={false}
        autoCapitalize="none"
        aria-invalid={!!domain && !parsed.success}
        aria-describedby={`${id}-help`}
      />
      <div className="route-domain__path" aria-label="Route preview">
        {wildcard ? <Asterisk size={18} /> : <Globe2 size={18} />}
        <code>{domain.trim() || "your.domain"}</code>
        <ArrowRight size={18} aria-hidden="true" />
        <strong>{primary || "Choose an exit below"}</strong>
      </div>
      <p id={`${id}-help`} className="ops-meta">
        {domain && !parsed.success
          ? parsed.error.issues[0].message
          : wildcard
            ? `Matches subdomains at any depth, not ${domain.trim().slice(2)} itself. Learned from client DNS answers; no HTTPS inspection.`
            : "Exact hostname only. Router DNS maintains its destination IPs. Leave blank only to reuse an approved service's exact hostname."}
      </p>
      {wildcard && (
        <div className="route-domain__notice">
          <ShieldCheck size={18} aria-hidden="true" />
          <div>
            <strong>DNS learning needs your network's help</strong>
            <p>
              Clients must use this router as DNS. External DNS, client DoH/DoT and cached answers
              may bypass learning. RouterOS 7.17+ is required; DNS access must already be enabled
              and protected.
            </p>
            <label className="ops-check">
              <Checkbox
                checked={dnsConfirmed}
                onCheckedChange={(v) => onDnsConfirmed(v === true)}
              />
              I confirm clients use this router DNS and accept shared-IP routing and adlist bypass
              for matching DNS names.
            </label>
            <small>
              We do not redirect DNS, open port 53, clear caches or change DHCP. A wildcard FWD
              entry affects matching DNS answers for all DNS clients; traffic routing still uses
              your client subnets below.
            </small>
          </div>
        </div>
      )}
      <small className="ops-meta">
        Routing is IP-based: other services on a shared CDN address may use this exit too.
      </small>
    </section>
  );
}
