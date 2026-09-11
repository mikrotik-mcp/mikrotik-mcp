/** Browser-safe path evidence types: no SQLite or server configuration imports. */
import type { TraceResult } from "../sim/trace";

export type PathStatus = "modelled" | "blocked" | "unknown";
export interface HopEvidence {
  device: string;
  ingress: string;
  egress: string;
  status: PathStatus;
  reason: string;
  trace?: Omit<TraceResult, "steps" | "routing"> & {
    steps: Omit<TraceResult["steps"][number], "raw">[];
    route?: { table?: string; gateway?: string; outInterface?: string };
  };
}
export interface PathLeg {
  status: PathStatus;
  hops: HopEvidence[];
}
export interface RoundTripResult {
  status: PathStatus;
  liveDelivery: "unverified";
  asymmetric: boolean;
  assumptions: string[];
  provenance: { device: string; snapshotId: string; capturedAt: number; sha: string }[];
  forward: PathLeg;
  reverse: PathLeg;
}
