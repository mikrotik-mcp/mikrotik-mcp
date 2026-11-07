import {
  getPreferenceValues,
  LocalStorage,
  updateCommandMetadata,
} from "@raycast/api";
import { api } from "./lib/api";
import {
  bandwidthNotificationNamespace,
  pollBandwidthNotifications,
  type CompletionPage,
} from "./lib/bandwidth-notifications";
import { notifyStrict } from "./lib/notify";

/** Poll retained completions on manual and background launches; never substitute a toast. */
export default async function Command(): Promise<void> {
  try {
    const { dashboardUrl } = getPreferenceValues<Preferences>();
    const result = await pollBandwidthNotifications(
      bandwidthNotificationNamespace(dashboardUrl ?? ""),
      {
        get: (key) => LocalStorage.getItem<string>(key),
        set: (key, value) => LocalStorage.setItem(key, value),
        fetch: (after, limit) =>
          api<CompletionPage>(
            `/api/bandwidth/notifications?after=${after}&limit=${limit}`,
          ),
        notify: notifyStrict,
      },
    );
    await updateCommandMetadata({
      subtitle: `${result.dispatched} native dispatches${result.hasMore ? " · backlog pending" : " · up to date"}; visibility depends on OS permissions`,
    });
  } catch (error) {
    await updateCommandMetadata({
      subtitle: "Notification polling/dispatch failed · retry pending",
    });
    throw error;
  }
}
