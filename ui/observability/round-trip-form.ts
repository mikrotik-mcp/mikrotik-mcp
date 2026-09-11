/** Browser-only request shape; do not pull the Bun/SQLite simulator import graph into the UI. */
export interface TripPayload {
  snapshots: { device: string; id: string }[];
  forward: { device: string; ingress: string; egress: string }[];
  reverse: { device: string; ingress: string; egress: string }[];
  packet: {
    srcAddress: string;
    dstAddress: string;
    protocol: "tcp" | "udp" | "icmp";
    srcPort?: number;
    dstPort?: number;
  };
  maxAgeSeconds: number;
  maxSkewSeconds: number;
}

export interface PathStep {
  key: string;
  device: string;
  snapshotId: string;
  ingress: string;
  egress: string;
}
export interface SnapshotChoice {
  id: string;
  device: string;
  ts: number;
  label?: string;
}
export interface RouterChoice {
  device: string;
  snapshots: SnapshotChoice[];
}
export interface TripForm {
  forward: PathStep[];
  reverse: PathStep[];
  mirror: boolean;
  src: string;
  dst: string;
  protocol: "tcp" | "udp" | "icmp";
  srcPort: string;
  dstPort: string;
  maxAge: number;
  maxSkew: number;
}
export const blankStep = (): PathStep => ({
  key: crypto.randomUUID(),
  device: "",
  snapshotId: "",
  ingress: "",
  egress: "",
});
export function returnSteps(steps: PathStep[]): PathStep[] {
  return [...steps]
    .reverse()
    .map((s) => ({ ...s, key: `return-${s.key}`, ingress: s.egress, egress: s.ingress }));
}
const ip = (v: string): boolean =>
  /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(v) &&
  v.split(".").every((n) => Number(n) <= 255);

/** Translate the guided editor into the existing contract; never relax backend safety bounds. */
export function buildTripInput(
  form: TripForm,
  choices: RouterChoice[],
  now = Date.now(),
): TripPayload {
  if (!ip(form.src) || !ip(form.dst))
    throw new Error(
      "Enter a valid client IPv4 and destination IPv4. Hostnames are not supported in this offline lab.",
    );
  if (
    !Number.isInteger(form.maxAge) ||
    form.maxAge < 1 ||
    form.maxAge > 86400 ||
    !Number.isInteger(form.maxSkew) ||
    form.maxSkew < 0 ||
    form.maxSkew > 3600
  )
    throw new Error("Snapshot age must be 1–86400 seconds and capture gap 0–3600 seconds.");
  const reverse = form.mirror ? returnSteps(form.forward) : form.reverse;
  const selected = new Map<string, SnapshotChoice>();
  for (const [label, steps] of [
    ["Outbound", form.forward],
    ["Return", reverse],
  ] as const) {
    if (!steps.length || steps.length > 8)
      throw new Error(`${label}: choose between one and eight router steps.`);
    const seen = new Set<string>();
    for (const [i, step] of steps.entries()) {
      if (!step.device || !step.snapshotId || !step.ingress || !step.egress)
        throw new Error(
          `${label}, router ${i + 1}: select a router, saved configuration, entry interface and exit interface.`,
        );
      if (seen.has(step.device))
        throw new Error(`${label}: a router may appear only once. Remove the repeated router.`);
      seen.add(step.device);
      const snap = choices
        .find((c) => c.device === step.device)
        ?.snapshots.find((s) => s.id === step.snapshotId && s.device === step.device);
      if (!snap)
        throw new Error(
          `${step.device}: the selected saved configuration is unavailable. Refresh the choices.`,
        );
      if (selected.has(step.device) && selected.get(step.device)!.id !== snap.id)
        throw new Error(`${step.device}: use the same saved configuration in both directions.`);
      if (!Number.isFinite(snap.ts) || snap.ts > now + 10_000 || now - snap.ts > form.maxAge * 1000)
        throw new Error(
          `${step.device}: this saved configuration is too old or future-dated. Capture a fresh snapshot, or explicitly adjust the allowed age.`,
        );
      selected.set(step.device, snap);
    }
  }
  if (selected.size > 8) throw new Error("Use at most eight different routers in this test.");
  const first = form.forward[0],
    last = form.forward.at(-1)!;
  if (
    reverse[0].device !== last.device ||
    reverse[0].ingress !== last.egress ||
    reverse.at(-1)!.device !== first.device ||
    reverse.at(-1)!.egress !== first.ingress
  )
    throw new Error(
      "The return path must start at the destination-side exit and end at the client-side entry.",
    );
  const times = [...selected.values()].map((s) => s.ts);
  if (Math.max(...times) - Math.min(...times) > form.maxSkew * 1000)
    throw new Error(
      "These snapshots were captured too far apart. Choose closer captures or explicitly adjust the allowed capture gap.",
    );
  const packet: TripPayload["packet"] = {
    srcAddress: form.src,
    dstAddress: form.dst,
    protocol: form.protocol,
  };
  if (form.protocol !== "icmp") {
    const validPort = (v: string): boolean =>
      /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535;
    if (!validPort(form.srcPort) || !validPort(form.dstPort))
      throw new Error("Enter client and destination ports between 1 and 65535.");
    packet.srcPort = Number(form.srcPort);
    packet.dstPort = Number(form.dstPort);
  }
  const hops = (steps: PathStep[]) =>
    steps.map(({ device, ingress, egress }) => ({ device, ingress, egress }));
  return {
    snapshots: [...selected.values()].map(({ device, id }) => ({ device, id })),
    forward: hops(form.forward),
    reverse: hops(reverse),
    packet,
    maxAgeSeconds: form.maxAge,
    maxSkewSeconds: form.maxSkew,
  };
}
