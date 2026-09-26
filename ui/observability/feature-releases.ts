import type { ViewId } from "./navigation";

/** Release that introduced the page's newest capability, not its latest styling/fix.
 * Keep literal release versions: importing package.version here would promote a
 * feature forever. Update the entry when shipping a new capability on an old page.
 * Every new ViewId must explicitly declare its release (or null for legacy pages).
 */
export const FEATURE_RELEASES: Record<ViewId, string | null> = {
  "home-internet": "5.12.0",
  overview: null,
  devices: null,
  interfaces: "5.16.0",
  clients: null,
  investigations: null,
  "service-contracts": null,
  "round-trip": null,
  aaa: null,
  topology: null,
  fabric: null,
  vulns: null,
  access: null,
  packets: null,
  flows: null,
  snapshots: null,
  drift: null,
  policies: null,
  simulator: null,
  schedules: null,
  explain: null,
  attacks: null,
  txn: null,
  plan: null,
  s3: null,
  backups: null,
  modules: null,
  config: null,
  memory: null,
  alerts: null,
  releases: null,
  capsman: null,
  feed: null,
};

/** Build metadata is not a release upgrade; patch/prerelease changes are. */
export function releaseVersion(value?: string | null): string | null {
  const match = value
    ?.trim()
    .match(
      /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?)(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/,
    );
  return match?.[1] ?? null;
}

/** No dismissal state: visiting a page must never consume its release badge. */
export function newFeatureRelease(view: ViewId, runningVersion?: string): string | null {
  const introduced = releaseVersion(FEATURE_RELEASES[view]);
  return introduced && introduced === releaseVersion(runningVersion) ? introduced : null;
}
