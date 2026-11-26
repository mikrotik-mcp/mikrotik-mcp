/**
 * SQLite persistence and multi-stage deduplication store for LLM tool feedback.
 *
 * `bun:sqlite` is imported **dynamically** inside {@link openFeedbackStore} so
 * the static import graph stays Node-loadable.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import {
  computeFeedbackFingerprint,
  higherImpact,
  normalizeOperation,
  scoreFeedbackSimilarity,
  tokenizeCanonical,
} from "./dedup";
import {
  FindFeedbackSchema,
  feedbackImpacts,
  feedbackKinds,
  normalizeSubmitFeedbackInput,
  normalizeUpdateFeedbackInput,
  sanitizeFeedbackText,
} from "./types";
import type {
  FeedbackImpact,
  FeedbackIssue,
  FeedbackKind,
  FeedbackListResult,
  FeedbackOccurrence,
  FeedbackSource,
  FeedbackStatus,
  FeedbackSummary,
  FindFeedbackInput,
  SubmitFeedbackInput,
  SubmitFeedbackResult,
  UpdateFeedbackInput,
} from "./types";

export interface FeedbackStore {
  submit(input: SubmitFeedbackInput, source?: FeedbackSource): SubmitFeedbackResult;
  list(input?: Partial<FindFeedbackInput>): FeedbackListResult;
  get(id: number): {
    issue: FeedbackIssue;
    occurrences: FeedbackOccurrence[];
    similar: { issue: FeedbackIssue; similarity: number }[];
  } | null;
  update(id: number, input: UpdateFeedbackInput, memoryFactId?: number | null): FeedbackIssue;
  merge(targetId: number, sourceId: number): FeedbackIssue;
  deleteIssues(ids: number[]): number;
  clear(): number;
  summary(): FeedbackSummary;
  close(): void;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS feedback_issues (
     id                    INTEGER PRIMARY KEY AUTOINCREMENT,
     fingerprint           TEXT NOT NULL UNIQUE,
     kind                  TEXT NOT NULL,
     impact                TEXT NOT NULL,
     status                TEXT NOT NULL DEFAULT 'open',
     operation             TEXT,
     normalized_operation  TEXT NOT NULL DEFAULT '',
     title                 TEXT NOT NULL,
     detail                TEXT NOT NULL,
     expected              TEXT,
     actual_error          TEXT,
     workaround            TEXT,
     suggested_fix         TEXT,
     resolution_note       TEXT,
     fixed_in_version      TEXT,
     replacement_tool      TEXT,
     memory_fact_id        INTEGER,
     github_issue_url      TEXT,
     tags                  TEXT NOT NULL DEFAULT '[]',
     occurrences           INTEGER NOT NULL DEFAULT 1,
     first_seen_at         INTEGER NOT NULL,
     last_seen_at          INTEGER NOT NULL,
     resolved_at           INTEGER,
     reopened_count        INTEGER NOT NULL DEFAULT 0,
     last_source           TEXT NOT NULL DEFAULT 'llm',
     last_call_id          TEXT,
     last_device           TEXT,
     last_routeros_version TEXT,
     last_agent_model      TEXT
   )`,
  "CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback_issues(status, last_seen_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_feedback_op ON feedback_issues(normalized_operation, last_seen_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_feedback_occ ON feedback_issues(occurrences DESC, last_seen_at DESC)",
  `CREATE TABLE IF NOT EXISTS feedback_occurrences (
     id               INTEGER PRIMARY KEY AUTOINCREMENT,
     issue_id         INTEGER NOT NULL REFERENCES feedback_issues(id) ON DELETE CASCADE,
     ts               INTEGER NOT NULL,
     source           TEXT NOT NULL DEFAULT 'llm',
     call_id          TEXT,
     device           TEXT,
     routeros_version TEXT,
     agent_model      TEXT,
     detail           TEXT,
     actual_error     TEXT,
     workaround       TEXT
   )`,
  "CREATE INDEX IF NOT EXISTS idx_feedback_occ_issue ON feedback_occurrences(issue_id, ts DESC)",
];

const MIGRATION_STATEMENTS = [
  "ALTER TABLE feedback_issues ADD COLUMN fixed_in_version TEXT",
  "ALTER TABLE feedback_issues ADD COLUMN replacement_tool TEXT",
  "ALTER TABLE feedback_issues ADD COLUMN memory_fact_id INTEGER",
  "ALTER TABLE feedback_issues ADD COLUMN github_issue_url TEXT",
];

const MAX_OCCURRENCES_PER_ISSUE = 50;

interface IssueRow {
  id: number;
  fingerprint: string;
  kind: FeedbackKind;
  impact: FeedbackImpact;
  status: FeedbackStatus;
  operation: string | null;
  normalized_operation: string;
  title: string;
  detail: string;
  expected: string | null;
  actual_error: string | null;
  workaround: string | null;
  suggested_fix: string | null;
  resolution_note: string | null;
  fixed_in_version: string | null;
  replacement_tool: string | null;
  memory_fact_id: number | null;
  github_issue_url: string | null;
  tags: string;
  occurrences: number;
  first_seen_at: number;
  last_seen_at: number;
  resolved_at: number | null;
  reopened_count: number;
  last_source: FeedbackSource;
  last_call_id: string | null;
  last_device: string | null;
  last_routeros_version: string | null;
  last_agent_model: string | null;
}

interface OccurrenceRow {
  id: number;
  issue_id: number;
  ts: number;
  source: FeedbackSource;
  call_id: string | null;
  device: string | null;
  routeros_version: string | null;
  agent_model: string | null;
  detail: string | null;
  actual_error: string | null;
  workaround: string | null;
}

function parseTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function rowToIssue(r: IssueRow): FeedbackIssue {
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    kind: r.kind,
    impact: r.impact,
    status: r.status,
    operation: r.operation,
    title: r.title,
    detail: r.detail,
    expected: r.expected,
    actualError: r.actual_error,
    workaround: r.workaround,
    suggestedFix: r.suggested_fix,
    resolutionNote: r.resolution_note,
    fixedInVersion: r.fixed_in_version ?? null,
    replacementTool: r.replacement_tool ?? null,
    memoryFactId: r.memory_fact_id ?? null,
    githubIssueUrl: r.github_issue_url ?? null,
    tags: parseTags(r.tags),
    occurrences: r.occurrences,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    resolvedAt: r.resolved_at,
    reopenedCount: r.reopened_count,
    lastSource: r.last_source,
    lastCallId: r.last_call_id,
    lastDevice: r.last_device,
    lastRouterosVersion: r.last_routeros_version,
    lastAgentModel: r.last_agent_model,
  };
}

function rowToOccurrence(r: OccurrenceRow): FeedbackOccurrence {
  return {
    id: r.id,
    issueId: r.issue_id,
    ts: r.ts,
    source: r.source,
    callId: r.call_id,
    device: r.device,
    routerosVersion: r.routeros_version,
    agentModel: r.agent_model,
    detail: r.detail,
    actualError: r.actual_error,
    workaround: r.workaround,
  };
}

function buildAdvice(issue: FeedbackIssue, action: SubmitFeedbackResult["action"]): string {
  const parts: string[] = [];
  if (action === "created") {
    parts.push(
      `Feedback #${issue.id} recorded (${issue.kind}, impact=${issue.impact}). Future identical or similar reports will automatically increment this issue's occurrence counter.`,
    );
  } else if (action === "Reopened existing") {
    parts.push(
      `Matched previously resolved feedback #${issue.id} ("${issue.title}") — reopened and incremented to ×${issue.occurrences} occurrences.`,
    );
  } else {
    parts.push(
      `Deduplicated into existing feedback #${issue.id} ("${issue.title}") — incremented to ×${issue.occurrences} occurrences. Do NOT submit another report for this same issue.`,
    );
  }
  if (issue.fixedInVersion) {
    parts.push(`Fixed/added in version: ${issue.fixedInVersion}.`);
  }
  if (issue.replacementTool) {
    parts.push(
      `Implemented tool / capability to use now: ${issue.replacementTool} (invoke it directly or via invoke_tool).`,
    );
  }
  if (issue.resolutionNote) {
    parts.push(`Operator resolution / guidance: ${issue.resolutionNote}`);
  }
  if (issue.workaround) {
    parts.push(`Known workaround: ${issue.workaround}`);
  }
  return parts.join(" ");
}

class SqliteFeedbackStore implements FeedbackStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    db.run("PRAGMA busy_timeout = 1000");
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA foreign_keys = ON");
    for (const stmt of SCHEMA_STATEMENTS) db.run(stmt);
    for (const stmt of MIGRATION_STATEMENTS) {
      try {
        db.run(stmt);
      } catch {
        /* column already exists on upgraded databases */
      }
    }
  }

  private getIssueRow(id: number): IssueRow | null {
    return (
      (this.db.query("SELECT * FROM feedback_issues WHERE id = ?").get(id) as IssueRow | null) ??
      null
    );
  }

  private recordOccurrence(
    issueId: number,
    now: number,
    source: FeedbackSource,
    data: {
      callId: string | null;
      device: string | null;
      routerosVersion: string | null;
      agentModel: string | null;
      detail: string | null;
      actualError: string | null;
      workaround: string | null;
    },
  ): void {
    this.db.run(
      `INSERT INTO feedback_occurrences (
         issue_id, ts, source, call_id, device, routeros_version, agent_model, detail, actual_error, workaround
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        issueId,
        now,
        source,
        data.callId,
        data.device,
        data.routerosVersion,
        data.agentModel,
        data.detail,
        data.actualError,
        data.workaround,
      ],
    );
    // Bound per-issue occurrence rows to the latest MAX_OCCURRENCES_PER_ISSUE
    this.db.run(
      `DELETE FROM feedback_occurrences
       WHERE issue_id = ?
         AND id NOT IN (
           SELECT id FROM feedback_occurrences
           WHERE issue_id = ?
           ORDER BY ts DESC, id DESC
           LIMIT ?
         )`,
      [issueId, issueId, MAX_OCCURRENCES_PER_ISSUE],
    );
  }

  submit(rawInput: SubmitFeedbackInput, source: FeedbackSource = "llm"): SubmitFeedbackResult {
    const parsed = normalizeSubmitFeedbackInput(rawInput);
    const title = sanitizeFeedbackText(parsed.title);
    const detail = sanitizeFeedbackText(parsed.detail);
    if (!title || !detail) {
      throw new Error("Feedback title and detail must not be empty.");
    }
    const expected = sanitizeFeedbackText(parsed.expected);
    const actualError = sanitizeFeedbackText(parsed.actual_error);
    const workaround = sanitizeFeedbackText(parsed.workaround);
    const suggestedFix = sanitizeFeedbackText(parsed.suggested_fix);
    const operation = parsed.operation?.trim() || null;
    const normalizedOp = normalizeOperation(operation);
    const callId = parsed.call_id?.trim() || null;
    const device = parsed.device?.trim() || null;
    const routerosVersion = parsed.routeros_version?.trim() || null;
    const agentModel = parsed.agent_model?.trim() || null;
    const incomingTags = [
      ...new Set(parsed.tags.map((t) => t.trim().toLowerCase()).filter(Boolean)),
    ];

    const fingerprint = computeFeedbackFingerprint({
      kind: parsed.kind,
      operation,
      title,
      actualError,
    });

    const now = Date.now();

    return this.db.transaction((): SubmitFeedbackResult => {
      // Stage 1: Exact fingerprint match
      let matchedRow =
        (this.db
          .query("SELECT * FROM feedback_issues WHERE fingerprint = ?")
          .get(fingerprint) as IssueRow | null) ?? null;
      let matchStage: SubmitFeedbackResult["matchStage"] = matchedRow
        ? "exact_fingerprint"
        : "none";
      let similarity = matchedRow ? 1 : 0;

      // Stage 2: Weighted fuzzy similarity across candidate issues (unless force_new is true)
      if (!matchedRow && !parsed.force_new) {
        const candidates = (
          normalizedOp
            ? this.db
                .query(
                  `SELECT * FROM feedback_issues
                   WHERE normalized_operation = ? OR normalized_operation = ''
                   ORDER BY last_seen_at DESC LIMIT 200`,
                )
                .all(normalizedOp)
            : this.db
                .query("SELECT * FROM feedback_issues ORDER BY last_seen_at DESC LIMIT 200")
                .all()
        ) as IssueRow[];

        let bestRow: IssueRow | null = null;
        let bestScore = 0;
        for (const cand of candidates) {
          const issue = rowToIssue(cand);
          const { score, matches } = scoreFeedbackSimilarity(
            {
              kind: parsed.kind,
              operation,
              title,
              detail,
              actualError,
            },
            issue,
          );
          if (matches && score > bestScore) {
            bestScore = score;
            bestRow = cand;
          }
        }
        if (bestRow) {
          matchedRow = bestRow;
          matchStage = "fuzzy_similarity";
          similarity = bestScore;
        }
      }

      if (matchedRow) {
        const existing = rowToIssue(matchedRow);
        const mergedTags = [...new Set([...existing.tags, ...incomingTags])].slice(0, 16);
        const nextImpact = higherImpact(existing.impact, parsed.impact);
        const wasResolved = existing.status === "resolved";
        const nextStatus: FeedbackStatus = wasResolved ? "open" : existing.status;
        const nextReopened = wasResolved ? existing.reopenedCount + 1 : existing.reopenedCount;
        const nextResolvedAt = wasResolved ? null : existing.resolvedAt;

        this.db.run(
          `UPDATE feedback_issues
           SET occurrences           = occurrences + 1,
               last_seen_at          = ?,
               impact                = ?,
               status                = ?,
               resolved_at           = ?,
               reopened_count        = ?,
               expected              = COALESCE(expected, ?),
               actual_error          = COALESCE(?, actual_error),
               workaround            = COALESCE(?, workaround),
               suggested_fix         = COALESCE(?, suggested_fix),
               tags                  = ?,
               last_source           = ?,
               last_call_id          = COALESCE(?, last_call_id),
               last_device           = COALESCE(?, last_device),
               last_routeros_version = COALESCE(?, last_routeros_version),
               last_agent_model      = COALESCE(?, last_agent_model)
           WHERE id = ?`,
          [
            now,
            nextImpact,
            nextStatus,
            nextResolvedAt,
            nextReopened,
            expected,
            actualError,
            workaround,
            suggestedFix,
            JSON.stringify(mergedTags),
            source,
            callId,
            device,
            routerosVersion,
            agentModel,
            existing.id,
          ],
        );

        this.recordOccurrence(existing.id, now, source, {
          callId,
          device,
          routerosVersion,
          agentModel,
          detail,
          actualError,
          workaround,
        });

        const updated = rowToIssue(this.getIssueRow(existing.id)!);
        const action: SubmitFeedbackResult["action"] = wasResolved
          ? "Reopened existing"
          : "Incremented existing";
        return {
          action,
          deduplicated: true,
          matchStage,
          similarity,
          issue: updated,
          advice: buildAdvice(updated, action),
        };
      }

      // If force_new is true and a fingerprint collision existed, salt the fingerprint
      let finalFingerprint = fingerprint;
      if (
        this.db.query("SELECT 1 FROM feedback_issues WHERE fingerprint = ?").get(finalFingerprint)
      ) {
        finalFingerprint = `${fingerprint}-${now}`;
      }

      const insertResult = this.db.run(
        `INSERT INTO feedback_issues (
           fingerprint, kind, impact, status, operation, normalized_operation,
           title, detail, expected, actual_error, workaround, suggested_fix,
           resolution_note, tags, occurrences, first_seen_at, last_seen_at,
           resolved_at, reopened_count, last_source, last_call_id, last_device,
           last_routeros_version, last_agent_model
         ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?, NULL, 0, ?, ?, ?, ?, ?)`,
        [
          finalFingerprint,
          parsed.kind,
          parsed.impact,
          operation,
          normalizedOp,
          title,
          detail,
          expected,
          actualError,
          workaround,
          suggestedFix,
          JSON.stringify(incomingTags),
          now,
          now,
          source,
          callId,
          device,
          routerosVersion,
          agentModel,
        ],
      );

      const newId = Number(insertResult.lastInsertRowid);
      this.recordOccurrence(newId, now, source, {
        callId,
        device,
        routerosVersion,
        agentModel,
        detail,
        actualError,
        workaround,
      });

      const created = rowToIssue(this.getIssueRow(newId)!);
      return {
        action: "created",
        deduplicated: false,
        matchStage: "none",
        similarity: 0,
        issue: created,
        advice: buildAdvice(created, "created"),
      };
    })();
  }

  list(rawInput: Partial<FindFeedbackInput> = {}): FeedbackListResult {
    const parsed = FindFeedbackSchema.parse(rawInput);
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (parsed.status !== "all") {
      clauses.push("status = ?");
      params.push(parsed.status);
    }
    if (parsed.kind) {
      clauses.push("kind = ?");
      params.push(parsed.kind);
    }
    if (parsed.impact) {
      clauses.push("impact = ?");
      params.push(parsed.impact);
    }
    if (parsed.operation) {
      const normOp = normalizeOperation(parsed.operation);
      clauses.push("(normalized_operation = ? OR LOWER(COALESCE(operation, '')) LIKE ?)");
      params.push(normOp, `%${normOp}%`);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const allRows = this.db
      .query(`SELECT * FROM feedback_issues ${whereSql}`)
      .all(...params) as IssueRow[];

    let items = allRows.map(rowToIssue);

    // Query filtering (supports both literal substring and canonical token matching)
    const q = parsed.query.trim().toLowerCase();
    if (q) {
      const qTokens = tokenizeCanonical(q);
      const qNormOp = normalizeOperation(q);
      items = items.filter((item) => {
        const haystack = [
          item.title,
          item.detail,
          item.operation ?? "",
          item.actualError ?? "",
          item.workaround ?? "",
          item.resolutionNote ?? "",
          item.fixedInVersion ?? "",
          item.replacementTool ?? "",
          item.tags.join(" "),
        ]
          .join(" ")
          .toLowerCase();
        if (haystack.includes(q)) return true;
        if (qNormOp && normalizeOperation(item.operation).includes(qNormOp)) return true;
        if (qTokens.length > 0) {
          const itemTokens = new Set(tokenizeCanonical(haystack));
          const matched = qTokens.filter((t) => itemTokens.has(t)).length;
          return matched >= Math.ceil(qTokens.length * 0.6);
        }
        return false;
      });
    }

    const impactWeight: Record<FeedbackImpact, number> = {
      blocker: 4,
      degraded: 3,
      friction: 2,
      suggestion: 1,
    };

    items.sort((a, b) => {
      if (parsed.sort === "recent") {
        return b.lastSeenAt - a.lastSeenAt || b.occurrences - a.occurrences;
      }
      if (parsed.sort === "first_seen") {
        return b.firstSeenAt - a.firstSeenAt;
      }
      if (parsed.sort === "impact") {
        return (
          impactWeight[b.impact] - impactWeight[a.impact] ||
          b.occurrences - a.occurrences ||
          b.lastSeenAt - a.lastSeenAt
        );
      }
      // Default: 'occurrences'
      return (
        b.occurrences - a.occurrences ||
        impactWeight[b.impact] - impactWeight[a.impact] ||
        b.lastSeenAt - a.lastSeenAt
      );
    });

    const total = items.length;
    const paged = items.slice(parsed.offset, parsed.offset + parsed.limit);

    return {
      items: paged,
      total,
      limit: parsed.limit,
      offset: parsed.offset,
      summary: this.summary(),
    };
  }

  get(id: number): {
    issue: FeedbackIssue;
    occurrences: FeedbackOccurrence[];
    similar: { issue: FeedbackIssue; similarity: number }[];
  } | null {
    const row = this.getIssueRow(id);
    if (!row) return null;
    const issue = rowToIssue(row);
    const occRows = this.db
      .query(
        "SELECT * FROM feedback_occurrences WHERE issue_id = ? ORDER BY ts DESC, id DESC LIMIT ?",
      )
      .all(id, MAX_OCCURRENCES_PER_ISSUE) as OccurrenceRow[];

    const others = this.db
      .query("SELECT * FROM feedback_issues WHERE id != ? ORDER BY last_seen_at DESC LIMIT 100")
      .all(id) as IssueRow[];

    const similar = others
      .map((otherRow) => {
        const other = rowToIssue(otherRow);
        const { score } = scoreFeedbackSimilarity(
          {
            kind: issue.kind,
            operation: issue.operation,
            title: issue.title,
            detail: issue.detail,
            actualError: issue.actualError,
          },
          other,
        );
        return { issue: other, similarity: score };
      })
      .filter((x) => x.similarity >= 0.35)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 6);

    return {
      issue,
      occurrences: occRows.map(rowToOccurrence),
      similar,
    };
  }

  update(id: number, rawInput: UpdateFeedbackInput, memoryFactId?: number | null): FeedbackIssue {
    const existingRow = this.getIssueRow(id);
    if (!existingRow) throw new Error(`Feedback issue #${id} not found`);
    const existing = rowToIssue(existingRow);
    const parsed = normalizeUpdateFeedbackInput(rawInput);

    const nextStatus = parsed.status ?? existing.status;
    const nextImpact = parsed.impact ?? existing.impact;
    const nextKind = parsed.kind ?? existing.kind;
    const nextTitle =
      parsed.title !== undefined
        ? (sanitizeFeedbackText(parsed.title) ?? existing.title)
        : existing.title;
    const nextDetail =
      parsed.detail !== undefined
        ? (sanitizeFeedbackText(parsed.detail) ?? existing.detail)
        : existing.detail;
    const nextExpected =
      parsed.expected !== undefined ? sanitizeFeedbackText(parsed.expected) : existing.expected;
    const nextWorkaround =
      parsed.workaround !== undefined
        ? sanitizeFeedbackText(parsed.workaround)
        : existing.workaround;
    const nextSuggestedFix =
      parsed.suggested_fix !== undefined
        ? sanitizeFeedbackText(parsed.suggested_fix)
        : existing.suggestedFix;
    const nextResolutionNote =
      parsed.resolution_note !== undefined
        ? sanitizeFeedbackText(parsed.resolution_note)
        : existing.resolutionNote;
    const nextFixedInVersion =
      parsed.fixed_in_version !== undefined
        ? sanitizeFeedbackText(parsed.fixed_in_version)
        : existing.fixedInVersion;
    const nextReplacementTool =
      parsed.replacement_tool !== undefined
        ? sanitizeFeedbackText(parsed.replacement_tool)
        : existing.replacementTool;
    const nextGithubIssueUrl =
      parsed.github_issue_url !== undefined
        ? sanitizeFeedbackText(parsed.github_issue_url)
        : existing.githubIssueUrl;
    const nextMemoryFactId = memoryFactId !== undefined ? memoryFactId : existing.memoryFactId;
    const nextTags =
      parsed.tags !== undefined
        ? [...new Set(parsed.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))]
        : existing.tags;

    const now = Date.now();
    let nextResolvedAt = existing.resolvedAt;
    if (nextStatus === "resolved" && existing.status !== "resolved") {
      nextResolvedAt = now;
    } else if (nextStatus !== "resolved") {
      nextResolvedAt = null;
    }

    this.db.run(
      `UPDATE feedback_issues
       SET status           = ?,
           impact           = ?,
           kind             = ?,
           title            = ?,
           detail           = ?,
           expected         = ?,
           workaround       = ?,
           suggested_fix    = ?,
           resolution_note  = ?,
           fixed_in_version = ?,
           replacement_tool = ?,
           memory_fact_id   = ?,
           github_issue_url = ?,
           tags             = ?,
           resolved_at      = ?
       WHERE id = ?`,
      [
        nextStatus,
        nextImpact,
        nextKind,
        nextTitle,
        nextDetail,
        nextExpected,
        nextWorkaround,
        nextSuggestedFix,
        nextResolutionNote,
        nextFixedInVersion,
        nextReplacementTool,
        nextMemoryFactId,
        nextGithubIssueUrl,
        JSON.stringify(nextTags),
        nextResolvedAt,
        id,
      ],
    );

    return rowToIssue(this.getIssueRow(id)!);
  }

  merge(targetId: number, sourceId: number): FeedbackIssue {
    if (targetId === sourceId) {
      throw new Error("Cannot merge a feedback issue into itself.");
    }
    return this.db.transaction(() => {
      const targetRow = this.getIssueRow(targetId);
      const sourceRow = this.getIssueRow(sourceId);
      if (!targetRow) throw new Error(`Target feedback issue #${targetId} not found`);
      if (!sourceRow) throw new Error(`Source feedback issue #${sourceId} not found`);

      const target = rowToIssue(targetRow);
      const source = rowToIssue(sourceRow);

      const mergedTags = [...new Set([...target.tags, ...source.tags])].slice(0, 16);
      const mergedImpact = higherImpact(target.impact, source.impact);
      const firstSeen = Math.min(target.firstSeenAt, source.firstSeenAt);
      const lastSeen = Math.max(target.lastSeenAt, source.lastSeenAt);

      this.db.run(
        `UPDATE feedback_issues
         SET occurrences           = occurrences + ?,
             first_seen_at         = ?,
             last_seen_at          = ?,
             impact                = ?,
             expected              = COALESCE(expected, ?),
             actual_error          = COALESCE(actual_error, ?),
             workaround            = COALESCE(workaround, ?),
             suggested_fix         = COALESCE(suggested_fix, ?),
             resolution_note       = COALESCE(resolution_note, ?),
             fixed_in_version      = COALESCE(fixed_in_version, ?),
             replacement_tool      = COALESCE(replacement_tool, ?),
             memory_fact_id        = COALESCE(memory_fact_id, ?),
             github_issue_url      = COALESCE(github_issue_url, ?),
             tags                  = ?,
             reopened_count        = reopened_count + ?
         WHERE id = ?`,
        [
          source.occurrences,
          firstSeen,
          lastSeen,
          mergedImpact,
          source.expected,
          source.actualError,
          source.workaround,
          source.suggestedFix,
          source.resolutionNote,
          source.fixedInVersion,
          source.replacementTool,
          source.memoryFactId,
          source.githubIssueUrl,
          JSON.stringify(mergedTags),
          source.reopenedCount,
          targetId,
        ],
      );

      this.db.run("UPDATE feedback_occurrences SET issue_id = ? WHERE issue_id = ?", [
        targetId,
        sourceId,
      ]);
      this.db.run("DELETE FROM feedback_issues WHERE id = ?", [sourceId]);

      return rowToIssue(this.getIssueRow(targetId)!);
    })();
  }

  deleteIssues(ids: number[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    const res = this.db.run(`DELETE FROM feedback_issues WHERE id IN (${placeholders})`, ids);
    return Number(res.changes);
  }

  clear(): number {
    const res = this.db.run("DELETE FROM feedback_issues");
    return Number(res.changes);
  }

  summary(): FeedbackSummary {
    const rows = this.db.query("SELECT * FROM feedback_issues").all() as IssueRow[];
    const byKind = Object.fromEntries(feedbackKinds.map((k) => [k, 0])) as Record<
      FeedbackKind,
      number
    >;
    const byImpact = Object.fromEntries(feedbackImpacts.map((i) => [i, 0])) as Record<
      FeedbackImpact,
      number
    >;

    let totalOccurrences = 0;
    let openIssues = 0;
    let inProgressIssues = 0;
    let resolvedIssues = 0;
    let wontFixIssues = 0;
    let blockersOpen = 0;

    const opMap = new Map<
      string,
      {
        operation: string;
        issues: number;
        occurrences: number;
        openIssues: number;
        highestImpact: FeedbackImpact;
      }
    >();

    for (const r of rows) {
      totalOccurrences += r.occurrences;
      byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
      byImpact[r.impact] = (byImpact[r.impact] ?? 0) + 1;

      if (r.status === "open") openIssues++;
      else if (r.status === "in_progress") inProgressIssues++;
      else if (r.status === "resolved") resolvedIssues++;
      else if (r.status === "wont_fix") wontFixIssues++;

      if ((r.status === "open" || r.status === "in_progress") && r.impact === "blocker") {
        blockersOpen++;
      }

      const opKey = r.normalized_operation || r.operation || "(general)";
      const displayOp = r.operation || "(general)";
      const cur = opMap.get(opKey) ?? {
        operation: displayOp,
        issues: 0,
        occurrences: 0,
        openIssues: 0,
        highestImpact: "suggestion" as FeedbackImpact,
      };
      cur.issues++;
      cur.occurrences += r.occurrences;
      if (r.status === "open" || r.status === "in_progress") cur.openIssues++;
      cur.highestImpact = higherImpact(cur.highestImpact, r.impact);
      opMap.set(opKey, cur);
    }

    const topOperations = [...opMap.values()]
      .sort((a, b) => b.occurrences - a.occurrences || b.openIssues - a.openIssues)
      .slice(0, 10);

    return {
      totalIssues: rows.length,
      totalOccurrences,
      openIssues,
      inProgressIssues,
      resolvedIssues,
      wontFixIssues,
      blockersOpen,
      repeatOccurrencesSaved: Math.max(0, totalOccurrences - rows.length),
      byKind,
      byImpact,
      topOperations,
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore double-close */
    }
  }
}

export async function openFeedbackStore(dbPath = ":memory:"): Promise<FeedbackStore> {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const { Database } = await import("bun:sqlite");
  return new SqliteFeedbackStore(new Database(dbPath));
}
