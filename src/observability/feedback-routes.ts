/**
 * Dashboard REST API for the LLM tool-feedback & telemetry loop (`/api/feedback/*`).
 * Shares validation and deduplication logic with the MCP `submit_feedback` and
 * `find_feedback` tools.
 */
import { z } from "zod";
import { getConfigSource } from "../config";
import { atomicWrite, serializeConfig } from "../config-write";
import { getConfig, setConfig } from "../core/runtime";
import { closeFeedbackStore, getFeedbackStore, installFeedbackStore } from "../feedback/accessor";
import {
  buildBatchGithubIssuePayload,
  buildGithubIssuePayload,
  syncFeedbackToMemory,
} from "../feedback/memory-sync";
import { openFeedbackStore } from "../feedback/store";
import {
  BatchFeedbackSchema,
  FindFeedbackSchema,
  GithubIssueFeedbackSchema,
  SubmitFeedbackSchema,
  normalizeUpdateFeedbackInput,
} from "../feedback/types";

export { closeFeedbackStore };

const count = (value: string | null, fallback: number, max: number) =>
  z.coerce
    .number()
    .int()
    .min(0)
    .max(max)
    .parse(value ?? fallback);

let configuring = false;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function body(req: Request): Promise<unknown> {
  const raw = await req.text();
  if (raw.length > 256_000) throw new Error("Feedback request is too large");
  return raw ? JSON.parse(raw) : {};
}

export async function feedbackRoutes(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (p !== "/api/feedback" && !p.startsWith("/api/feedback/")) return null;

  try {
    const cfg = getConfig();

    if (p === "/api/feedback/config" && req.method === "GET") {
      let summary = null;
      if (cfg.feedback.enabled) {
        try {
          summary = (await getFeedbackStore()).summary();
        } catch {
          /* summary is optional if DB path is unreadable */
        }
      }
      return json({
        ...cfg.feedback,
        summary,
      });
    }

    if (p === "/api/feedback/config" && req.method === "POST") {
      if (configuring)
        return json({ error: "Feedback configuration is being saved. Retry shortly." }, 409);
      const update = z
        .object({
          dbPath: z.string().trim().min(1).max(4096).optional(),
          enabled: z.boolean().optional(),
        })
        .strict()
        .parse(await body(req));
      configuring = true;
      try {
        const next = { ...cfg, feedback: { ...cfg.feedback, ...update } };
        if (
          next.feedback.enabled === cfg.feedback.enabled &&
          next.feedback.dbPath === cfg.feedback.dbPath
        ) {
          return json({ ok: true, ...cfg.feedback });
        }
        const prepared = next.feedback.enabled
          ? await openFeedbackStore(next.feedback.dbPath)
          : null;
        try {
          atomicWrite(getConfigSource().path, serializeConfig(next));
        } catch {
          prepared?.close();
          return json(
            {
              error:
                "Could not persist feedback configuration; the previous configuration is still active.",
            },
            500,
          );
        }
        setConfig(next);
        if (prepared) installFeedbackStore(prepared);
        else closeFeedbackStore();
        return json({ ok: true, ...next.feedback, summary: prepared?.summary() ?? null });
      } finally {
        configuring = false;
      }
    }

    if (!cfg.feedback.enabled) {
      return json({ error: "LLM tool feedback is disabled in configuration." }, 503);
    }

    const store = await getFeedbackStore();

    if (p === "/api/feedback/summary" && req.method === "GET") {
      return json(store.summary());
    }

    if (p === "/api/feedback" && req.method === "GET") {
      const values: Record<string, unknown> = Object.fromEntries(url.searchParams);
      delete values.token;
      const parsed = FindFeedbackSchema.parse({
        ...values,
        limit: count(url.searchParams.get("limit"), 50, 100),
        offset: count(url.searchParams.get("offset"), 0, 1_000_000),
      });
      return json(store.list(parsed));
    }

    if (p === "/api/feedback" && req.method === "POST") {
      const parsed = SubmitFeedbackSchema.parse(await body(req));
      return json(store.submit(parsed, "operator"));
    }

    if (p === "/api/feedback" && req.method === "DELETE") {
      const data = z
        .object({
          ids: z.array(z.number().int().positive()).max(500).optional(),
          all: z.boolean().optional(),
        })
        .strict()
        .parse(await body(req));
      const removed = data.all === true ? store.clear() : store.deleteIssues(data.ids ?? []);
      return json({ removed, summary: store.summary() });
    }

    const itemMatch = p.match(/^\/api\/feedback\/(\d+)$/);
    if (itemMatch) {
      const id = z.coerce.number().int().positive().parse(itemMatch[1]);
      if (req.method === "GET") {
        const found = store.get(id);
        return found ? json(found) : json({ error: `Feedback issue #${id} not found` }, 404);
      }
      if (req.method === "PATCH") {
        const patch = normalizeUpdateFeedbackInput(await body(req));
        let issue = store.update(id, patch);
        const shouldSyncMemory =
          patch.sync_to_memory ??
          (issue.status === "resolved" ||
            patch.resolution_note !== undefined ||
            patch.workaround !== undefined ||
            patch.replacement_tool !== undefined ||
            patch.fixed_in_version !== undefined);
        let memoryFactId = issue.memoryFactId;
        if (shouldSyncMemory) {
          try {
            const syncedId = await syncFeedbackToMemory(issue);
            if (syncedId !== null && syncedId !== issue.memoryFactId) {
              issue = store.update(id, {}, syncedId);
              memoryFactId = syncedId;
            }
          } catch {
            /* best-effort memory sync when memory is disabled or locked */
          }
        }
        return json({
          ok: true,
          issue,
          memorySynced: Boolean(memoryFactId),
          summary: store.summary(),
        });
      }
      if (req.method === "DELETE") {
        const removed = store.deleteIssues([id]);
        return json({ removed, summary: store.summary() });
      }
    }

    const syncMemMatch = p.match(/^\/api\/feedback\/(\d+)\/sync-memory$/);
    if (syncMemMatch && req.method === "POST") {
      const id = z.coerce.number().int().positive().parse(syncMemMatch[1]);
      const found = store.get(id);
      if (!found) return json({ error: `Feedback issue #${id} not found` }, 404);
      const memoryFactId = await syncFeedbackToMemory(found.issue);
      if (memoryFactId === null) {
        return json(
          {
            error:
              "Knowledge memory is disabled or this feedback item has no resolution/workaround to record.",
          },
          400,
        );
      }
      const issue = store.update(id, {}, memoryFactId);
      return json({ ok: true, issue, memoryFactId, summary: store.summary() });
    }

    const ghIssueMatch = p.match(/^\/api\/feedback\/(\d+)\/github-issue$/);
    if (ghIssueMatch && req.method === "POST") {
      const id = z.coerce.number().int().positive().parse(ghIssueMatch[1]);
      const found = store.get(id);
      if (!found) return json({ error: `Feedback issue #${id} not found` }, 404);
      const input = GithubIssueFeedbackSchema.parse(await body(req));
      const payload = buildGithubIssuePayload(found.issue, found.occurrences);
      const title = input.title ?? payload.title;
      const issueBody = input.body ?? payload.body;
      const labels = input.labels ?? payload.labels;
      const token =
        input.token || process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || "";

      const buildFallbackWebUrl = () => {
        const u = new URL(`https://github.com/${input.repo}/issues/new`);
        u.searchParams.set("title", title);
        // Keep query parameter under typical browser/GitHub URL limits (~6500 chars)
        u.searchParams.set("body", issueBody.slice(0, 6000));
        if (labels.length) u.searchParams.set("labels", labels.join(","));
        return u.toString();
      };

      if (token) {
        const ghRes = await fetch(`https://api.github.com/repos/${input.repo}/issues`, {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "user-agent": "mikrotik-mcp-feedback-dashboard",
            "x-github-api-version": "2022-11-28",
          },
          body: JSON.stringify({ title, body: issueBody, labels }),
        });
        const ghJson = (await ghRes.json().catch(() => ({}))) as {
          html_url?: string;
          number?: number;
          message?: string;
        };
        if (ghRes.ok && ghJson.html_url) {
          const updated = store.update(id, { github_issue_url: ghJson.html_url });
          return json({
            ok: true,
            mode: "api",
            url: ghJson.html_url,
            number: ghJson.number ?? null,
            issue: updated,
          });
        }
        return json(
          {
            error: ghJson.message
              ? `GitHub API error (${ghRes.status}): ${ghJson.message}`
              : `GitHub API returned HTTP ${ghRes.status}`,
            fallbackUrl: buildFallbackWebUrl(),
          },
          ghRes.status >= 400 && ghRes.status < 500 ? ghRes.status : 502,
        );
      }

      return json({
        ok: true,
        mode: "web_url",
        url: buildFallbackWebUrl(),
        issue: found.issue,
      });
    }

    const mergeMatch = p.match(/^\/api\/feedback\/(\d+)\/merge$/);
    if (mergeMatch && req.method === "POST") {
      const targetId = z.coerce.number().int().positive().parse(mergeMatch[1]);
      const data = z
        .object({
          sourceId: z.number().int().positive(),
        })
        .strict()
        .parse(await body(req));
      const issue = store.merge(targetId, data.sourceId);
      return json({ ok: true, issue, summary: store.summary() });
    }

    if (p === "/api/feedback/batch" && req.method === "POST") {
      const batch = BatchFeedbackSchema.parse(await body(req));
      const uniqueIds = [...new Set(batch.ids)];

      if (batch.action === "delete") {
        const removed = store.deleteIssues(uniqueIds);
        return json({ ok: true, action: "delete", removed, summary: store.summary() });
      }

      if (batch.action === "merge") {
        if (uniqueIds.length < 2 && !batch.target_id) {
          return json({ error: "Select at least two feedback issues to merge into one." }, 400);
        }
        const targetId = batch.target_id ?? uniqueIds[0]!;
        const sourceIds = uniqueIds.filter((id) => id !== targetId);
        if (sourceIds.length === 0) {
          return json(
            { error: "Select at least one source issue different from the target issue." },
            400,
          );
        }
        let mergedIssue = store.get(targetId)?.issue;
        if (!mergedIssue) {
          return json({ error: `Target feedback issue #${targetId} not found` }, 404);
        }
        for (const sourceId of sourceIds) {
          mergedIssue = store.merge(targetId, sourceId);
        }
        return json({
          ok: true,
          action: "merge",
          targetId,
          mergedCount: sourceIds.length,
          issue: mergedIssue,
          summary: store.summary(),
        });
      }

      if (batch.action === "sync_memory") {
        let syncedCount = 0;
        for (const id of uniqueIds) {
          const found = store.get(id);
          if (!found) continue;
          try {
            const factId = await syncFeedbackToMemory(found.issue);
            if (factId !== null) {
              store.update(id, {}, factId);
              syncedCount++;
            }
          } catch {
            /* best-effort per item */
          }
        }
        return json({
          ok: true,
          action: "sync_memory",
          updatedCount: uniqueIds.length,
          memorySyncedCount: syncedCount,
          summary: store.summary(),
        });
      }

      if (batch.action === "update") {
        const patch = batch.patch ?? {};
        let updatedCount = 0;
        let syncedCount = 0;
        for (const id of uniqueIds) {
          const existing = store.get(id);
          if (!existing) continue;
          let issue = store.update(id, patch);
          updatedCount++;
          const shouldSyncMemory =
            patch.sync_to_memory ??
            (issue.status === "resolved" ||
              patch.resolution_note !== undefined ||
              patch.workaround !== undefined ||
              patch.replacement_tool !== undefined ||
              patch.fixed_in_version !== undefined);
          if (shouldSyncMemory) {
            try {
              const factId = await syncFeedbackToMemory(issue);
              if (factId !== null) {
                issue = store.update(id, {}, factId);
                syncedCount++;
              }
            } catch {
              /* best-effort when memory is disabled or locked */
            }
          }
        }
        return json({
          ok: true,
          action: "update",
          updatedCount,
          memorySyncedCount: syncedCount,
          summary: store.summary(),
        });
      }

      if (batch.action === "github_issue") {
        const entries = uniqueIds
          .map((id) => store.get(id))
          .filter((x): x is NonNullable<typeof x> => x !== null);
        if (entries.length === 0) {
          return json({ error: "None of the selected feedback issues were found" }, 404);
        }
        const ghInput = GithubIssueFeedbackSchema.parse(batch.github ?? {});
        const payload = buildBatchGithubIssuePayload(entries);
        const title = ghInput.title ?? payload.title;
        const issueBody = ghInput.body ?? payload.body;
        const labels = ghInput.labels ?? payload.labels;
        const token =
          ghInput.token || process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || "";

        const buildFallbackWebUrl = () => {
          const u = new URL(`https://github.com/${ghInput.repo}/issues/new`);
          u.searchParams.set("title", title);
          u.searchParams.set("body", issueBody.slice(0, 6000));
          if (labels.length) u.searchParams.set("labels", labels.join(","));
          return u.toString();
        };

        if (token) {
          const ghRes = await fetch(`https://api.github.com/repos/${ghInput.repo}/issues`, {
            method: "POST",
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "user-agent": "mikrotik-mcp-feedback-dashboard",
              "x-github-api-version": "2022-11-28",
            },
            body: JSON.stringify({ title, body: issueBody, labels }),
          });
          const ghJson = (await ghRes.json().catch(() => ({}))) as {
            html_url?: string;
            number?: number;
            message?: string;
          };
          if (ghRes.ok && ghJson.html_url) {
            for (const entry of entries) {
              store.update(entry.issue.id, { github_issue_url: ghJson.html_url });
            }
            return json({
              ok: true,
              action: "github_issue",
              mode: "api",
              url: ghJson.html_url,
              number: ghJson.number ?? null,
              count: entries.length,
              summary: store.summary(),
            });
          }
          return json(
            {
              error: ghJson.message
                ? `GitHub API error (${ghRes.status}): ${ghJson.message}`
                : `GitHub API returned HTTP ${ghRes.status}`,
              fallbackUrl: buildFallbackWebUrl(),
            },
            ghRes.status >= 400 && ghRes.status < 500 ? ghRes.status : 502,
          );
        }

        return json({
          ok: true,
          action: "github_issue",
          mode: "web_url",
          url: buildFallbackWebUrl(),
          count: entries.length,
        });
      }
    }

    return json({ error: "Unknown feedback endpoint or method" }, 404);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return json(
        { error: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
        400,
      );
    }
    if (error instanceof SyntaxError || error instanceof URIError) {
      return json({ error: "Invalid feedback request JSON" }, 400);
    }
    const message = error instanceof Error ? error.message : "Feedback operation failed";
    if (/not found/i.test(message)) return json({ error: message }, 404);
    if (/credential vault|must not be empty|into itself|too large/i.test(message)) {
      return json({ error: message }, 400);
    }
    return json(
      { error: "Feedback storage is unavailable. Check its path and permissions, then retry." },
      503,
    );
  }
}
