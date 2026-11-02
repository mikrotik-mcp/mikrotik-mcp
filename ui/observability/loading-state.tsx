import { Skeleton } from "skullet/react";
import "skullet/styles.css";
import "./loading-state.css";

type Layout = "table" | "cards" | "chart" | "form";

/** Reserve a workspace-shaped surface while its first read is pending. */
export function LoadingState({
  label = "Loading workspace",
  layout = "table",
}: {
  label?: string;
  layout?: Layout;
}) {
  return (
    <Skeleton loading label={label} className="workspace-skeleton">
      <div aria-hidden="true" className="workspace-skeleton__content">
        <div className="workspace-skeleton__toolbar">
          <span>Workspace information</span>
          <span>Filter results</span>
        </div>
        {layout === "chart" ? (
          <div className="workspace-skeleton__chart">
            {[40, 65, 48, 82, 60, 92, 74, 56, 85, 68, 90, 76].map((height, index) => (
              <div key={index} skullet-block="" style={{ height: `${height}%` }} />
            ))}
          </div>
        ) : layout === "cards" ? (
          <div className="workspace-skeleton__cards">
            {[0, 1, 2].map((i) => (
              <div className="workspace-skeleton__card" key={i}>
                <h3>Connection details</h3>
                <p>Current status and resources</p>
                <p>Last observed information</p>
              </div>
            ))}
          </div>
        ) : layout === "form" ? (
          <div className="workspace-skeleton__fields">
            {[0, 1, 2, 3].map((i) => (
              <div key={i}>
                <p>Setting description</p>
                <div className="workspace-skeleton__field" skullet-block="" />
              </div>
            ))}
          </div>
        ) : (
          <div>
            {[0, 1, 2, 3, 4].map((i) => (
              <div className="workspace-skeleton__row" key={i}>
                <span>Network resource</span>
                <span>Connection information</span>
                <span>Current status</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Skeleton>
  );
}
