import { ChevronDown } from "lucide-react";
import { MonitorButton } from "./monitoring-ui";

/** A review affordance, never an installation trigger. */
export function ReleaseDowngradeButton({
  version,
  disabled,
  onReview,
}: {
  version: string;
  disabled?: boolean;
  onReview: () => void;
}) {
  return (
    <MonitorButton
      type="button"
      variant="danger"
      size="sm"
      disabled={disabled}
      onClick={onReview}
      className="release-downgrade"
      aria-label={`Review downgrade to v${version}`}
      title={`Review downgrade to v${version} — confirmation required`}
      icon={<ChevronDown aria-hidden="true" />}
    >
      Downgrade
      <span className="sr-only">v{version}</span>
    </MonitorButton>
  );
}
