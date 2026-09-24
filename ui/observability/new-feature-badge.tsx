import { Sparkles } from "lucide-react";
import { AnimatedBadge } from "./components/beui/registry/components/motion/animated-badge";
import { newFeatureRelease } from "./feature-releases";
import type { ViewId } from "./navigation";
import "./new-feature-badge.css";

export function NewFeatureBadge({
  view,
  version,
  placement = "menu",
}: {
  view: ViewId;
  version?: string;
  placement?: "menu" | "page" | "icon";
}) {
  const release = newFeatureRelease(view, version);
  if (!release) return null;
  const label = `New in v${release}`;
  const title = `${label} · Highlighted for this release, even after you visit.`;
  if (placement === "icon")
    return (
      <span
        className="feature-new-dot"
        title={title}
        aria-label={label}
        data-feature-release={release}
      />
    );
  return (
    <AnimatedBadge
      status="info"
      size="sm"
      pulse={false}
      icon={<Sparkles size={12} />}
      showIcon={placement === "page"}
      className={`feature-new-badge feature-new-${placement}`}
      title={title}
      aria-label={label}
      data-feature-release={release}
    >
      {placement === "page" ? `New in v${release}` : "NEW"}
    </AnimatedBadge>
  );
}
