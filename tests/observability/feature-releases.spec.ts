import { expect, test } from "vite-plus/test";
import {
  FEATURE_RELEASES,
  newFeatureRelease,
  releaseVersion,
} from "../../ui/observability/feature-releases";
import { VIEWS } from "../../ui/observability/navigation";

test("every dashboard page declares its feature release", () => {
  expect(Object.keys(FEATURE_RELEASES).sort()).toEqual(VIEWS.map((view) => view.id).sort());
  for (const release of Object.values(FEATURE_RELEASES)) {
    if (release !== null) expect(releaseVersion(release)).toBe(release);
  }
});

test("new features are promoted only throughout their release, never consumed by visits", () => {
  for (let visit = 0; visit < 3; visit++) {
    expect(newFeatureRelease("home-internet", "5.12.0")).toBe("5.12.0");
  }
  for (const version of [undefined, "", "unknown", "5.11.0", "5.12.1", "5.13.0", "5.12.0-beta.1"]) {
    expect(newFeatureRelease("home-internet", version)).toBeNull();
  }
  expect(newFeatureRelease("devices", "5.12.0")).toBeNull();
});

test("version prefixes and build metadata do not change the release", () => {
  expect(newFeatureRelease("home-internet", " v5.12.0+build.7 ")).toBe("5.12.0");
  expect(releaseVersion("v5.13.0-rc.1+sha.123")).toBe("5.13.0-rc.1");
  for (const value of [null, undefined, "5.12", "5.12.0.1", "5.12.0 garbage", "05.12.0"]) {
    expect(releaseVersion(value)).toBeNull();
  }
});
