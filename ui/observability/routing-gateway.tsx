import { Network } from "lucide-react";
import "./routing-gateway.css";

/** Presentation only: retain raw RouterOS values for search, inspection and commands. */
export function RoutingGateway({ value }: { value: string }) {
  // Split ECMP members only when every member has an unambiguous IP%interface shape.
  // Interface-only names, explanatory text and unknown syntax remain untouched.
  const members = value
    .split(",")
    .map((member) =>
      member.trim().match(/^((?:\d{1,3}\.){3}\d{1,3}|(?=[\da-f:.]*:)[\da-f:.]+)%([^%,]+)$/i),
    );
  if (!members.every(Boolean)) return <code>{value}</code>;
  return (
    <span className="routing-gateway">
      {members.map((member, index) => {
        const [, address, iface] = member!;
        return (
          <span
            className="routing-gateway__member"
            key={index}
            role="group"
            aria-label={`Gateway ${address}, interface ${iface}`}
          >
            <code dir="ltr">{address}</code>
            <span className="routing-gateway__interface" title={`Interface: ${iface}`}>
              <Network size={12} aria-hidden="true" />
              <span dir="ltr">{iface}</span>
            </span>
          </span>
        );
      })}
    </span>
  );
}
