import { Cmd } from "./routeros";

/** Print the resolver expression; an unprinted expression has no SSH result. */
export function dnsResolveCommand(
  name: string,
  server?: string,
  type?: "ipv4" | "ipv6" | "any" | "any6",
): string {
  const expression = new Cmd(":resolve")
    .set("domain-name", name)
    .opt("server", server)
    .opt("type", type)
    .build();
  return `:put [${expression}]`;
}
