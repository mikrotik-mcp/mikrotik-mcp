import { ArrowDownToLine } from "lucide-react";
import { Button } from "./components/ui/button";

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
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={onReview}
      className="release-downgrade"
      aria-label={`Review downgrade to v${version}`}
      title={`Review downgrade to v${version} — confirmation required`}
    >
      <span className="release-downgrade-icon" aria-hidden="true">
        <ArrowDownToLine size={14} />
      </span>
      <span>Downgrade</span>
      <span className="release-downgrade-version">v{version}</span>
    </Button>
  );
}
