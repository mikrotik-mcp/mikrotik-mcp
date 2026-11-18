/**
 * Posture views: L2 Fabric, Vulnerabilities and Access Scope.
 *
 * All three read a single JSON endpoint backed by the same pure analyzer the
 * MCP tools use (`src/core/l2-fabric.ts`, `advisories.ts`, `access.ts`), so the
 * dashboard can never disagree with what a tool call reports. Each page lives
 * in its own file; these re-exports keep the existing imports working.
 */

// The L2 Fabric page lives in fabric-view.tsx.
export { FabricView } from "./fabric-view";

// The Vulnerabilities page lives in vulns.tsx.
export { AdvisoryView } from "./vulns";

export { AccessView } from "./access-view";
