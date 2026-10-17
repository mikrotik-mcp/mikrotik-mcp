import { randomUUID } from "node:crypto";
import type { ToolContext } from "./context";
import { executeMikrotikCommand } from "./connector";
import { Cmd, looksLikeError, quoteValue } from "./routeros";
import { redactSecrets } from "../utils/redact-secrets";

const DONE = "MCP-SURVEY-DONE";
const FAILED = "MCP-SURVEY-FAILED";
const PENDING = "MCP-SURVEY-PENDING";

function readFile(file: string): string {
  const find = new Cmd("/file find").set("name", file).build();
  return (
    `:local surveyFiles [${find}]; :if ([:len $surveyFiles] = 0) do={ :put "${PENDING}" } else={ ` +
    `:if ([/file get ($surveyFiles->0) size] > 60000) do={ :error "failure: survey exceeds safe contents read size" }; ` +
    `:put [/file get ($surveyFiles->0) contents] }`
  );
}

/** Launch once on the router; reconnect only to read, never to repeat a disruptive scan. */
export async function runWifiSurvey(
  path: string,
  iface: string,
  duration: number,
  ctx: ToolContext,
): Promise<string> {
  const base = `mcp-wifi-survey-${randomUUID()}`;
  const report = `${base}.txt`;
  const status = `${base}-status.txt`;
  const scan = new Cmd(`${path} frequency-scan`)
    .raw(quoteValue(iface))
    .set("duration", `${duration}s`)
    .set("save-file", report)
    .build();
  // Router-owned execution survives loss of the SSH connection over the scanned radio.
  const script = `:delay 1s; :do { ${scan}; :put "${DONE}" } on-error={ :put "${FAILED}" }`;
  const launch = new Cmd(":execute").set("script", script).set("file", status).build();
  let lastError = "No completed report received";
  try {
    const result = await executeMikrotikCommand(launch, ctx);
    if (looksLikeError(result))
      return `Failed to start Wi-Fi survey: ${redactSecrets(result.trim())}. Scan was not retried.`;
  } catch (error) {
    // The router may have accepted the job before the acknowledgement was lost.
    lastError = redactSecrets(String(error));
  }

  const deadline = Date.now() + (duration + 60) * 1000;
  let response: string | undefined;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const state = await executeMikrotikCommand(readFile(status), ctx);
      if (state.includes(FAILED)) {
        response =
          "Failed to survey Wi-Fi channels: router background job failed. Check scan support and file/test permissions. Scan was not retried.";
        break;
      }
      if (!state.split(/\r?\n/).some((line) => line.trim() === DONE)) {
        if (looksLikeError(state)) lastError = redactSecrets(state.trim());
        continue;
      }
      const data = await executeMikrotikCommand(readFile(report), ctx);
      if (data.trim() === PENDING || looksLikeError(data)) {
        lastError = redactSecrets(data.trim());
        continue;
      }
      response = /^\s*\d{4,5}\s*[,\s]/m.test(data)
        ? `WI-FI CHANNEL SURVEY (${path}):\n\n${data.trim()}`
        : "Failed to survey Wi-Fi channels: completed report contains no channel measurements. A longer scan may be needed; scan was not retried.";
      break;
    } catch (error) {
      lastError = redactSecrets(String(error));
    }
  }
  // Do not delete a job's files while it may still be running or after a failed read.
  if (!response)
    return (
      `Failed to retrieve Wi-Fi survey before the recovery deadline: ${lastError}. ` +
      `Scan was not retried. Preserve/retrieve router files ${report} and ${status}; the job may have completed while disconnected.`
    );
  for (const file of [report, status]) {
    try {
      const selector = new Cmd("/file find").set("name", file).build();
      const result = await executeMikrotikCommand(
        new Cmd("/file remove").raw(`[${selector}]`).build(),
        ctx,
      );
      if (looksLikeError(result)) throw new Error(result);
    } catch {
      response += `\nWarning: Could not remove temporary router file ${file}; it may need manual cleanup.`;
    }
  }
  return response;
}
