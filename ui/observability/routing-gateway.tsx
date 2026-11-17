/**
 * Presentation only: retain raw RouterOS values for search, inspection and commands.
 * Styles live in service-routing.css (`.routing-gateway*`), so the markup stays plain.
 */
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
              <span dir="ltr">{iface}</span>
            </span>
          </span>
        );
      })}
    </span>
  );
}
