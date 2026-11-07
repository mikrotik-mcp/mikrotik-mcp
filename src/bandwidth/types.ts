/** A saved, bounded test of one expected tunnel path. No credentials are persisted. */
export interface BandwidthJob {
  id: string;
  name: string;
  source: string;
  destination: string;
  sourceInterface: string;
  sourceAddress: string;
  destinationAddress: string;
  protocol: "tcp" | "udp";
  direction: "transmit" | "receive" | "both";
  durationSeconds: number;
  localTxBps: number;
  remoteTxBps: number;
  localUdpTxSize: number;
  remoteUdpTxSize: number;
  randomData: boolean;
  connectionCount: number;
  reportIntervalSeconds: number;
  intervalSeconds: number;
  enabled: boolean;
  nextRunAt: number;
}
/** Only numeric measurements and fixed diagnostic messages leave the runner. */
export interface BandwidthRun {
  id: string;
  job: BandwidthJob;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "ok" | "failed" | "interrupted";
  trigger: "manual" | "schedule";
  txBps: number | null;
  rxBps: number | null;
  lostPackets: number | null;
  message: string;
}
export interface BandwidthPreflight {
  ready: boolean;
  checks: { name: string; ok: boolean; message: string }[];
  warning: string;
}
export interface BandwidthState {
  jobs: BandwidthJob[];
  runs: BandwidthRun[];
  devices: string[];
  concurrency: number;
}

/** Read-only selector inventory; interfaces without usable addresses remain visible. */
export interface BandwidthInventory {
  interfaces: { name: string; running: boolean; disabled: boolean }[];
  addresses: { interface: string; address: string }[];
}
