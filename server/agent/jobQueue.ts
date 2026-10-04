import { db } from "../db";
import { eq, and, sql, gte, asc } from "drizzle-orm";
import * as schema from "@shared/schema";
import type { SubAgentResult, SubAgentType } from "./subagents";
import { runSubAgent, BUILD_FEATURE_WORKER_SYSTEM_PROMPT } from "./subagents";
import {
  buildCompactCloudBackgroundResultPacket,
  maxCloudBackgroundModelTurnsForBudget,
  type ValidatedCloudBackgroundJobInput,
  validateCloudBackgroundJobInput,
} from "./cloudBackgroundEscalation";
import { runGoalDecomposition } from "./goalDecomposer";
import { runNamedAgent } from "./runNamedAgent";
import { runEphemeralAgentSession, type EphemeralAgentKind } from "./ephemeralAgents";
import { buildEphemeralWorkerResultDeliverable } from "./ephemeralWorkerDeliverable";
import { runWeeklyPatternJob } from "../memory/weeklyJob";
import { getValidGoogleTokens } from "../userTokenStore";
import type { ToolContext } from "./types";
import { notifyUser, getChannel } from "../channels/registry";
import { postToDiscordChannelById, sendToDiscordUser, sendFileToDiscordChannel, sendFileToDiscordUser } from "../discord/manager";
import type { ChannelSendOpts } from "../channels/types";
import { _notifyJobCompleteCore } from "./notifyJobCompleteCore";
import { onWorkflowJobComplete, onWorkflowJobFail } from "./workflowEngine";
import { emit as diagEmit } from "../diagnostics/diagnosticsService";
import { logSystemError } from "./errorLogger";
import { submitAgentJob as _submitAgentJob, getModelForJobType as _getModelForJobType, type SubmitJobInput, type AgentJobType as _AgentJobType } from "./jobClient";
import { runAgent } from "./harness";
import { verifyJobOutput } from "./orchestrator";
import { routeModelTurn } from "./modelRouter";
import { readRecentErrorsTool, listSourceFilesTool, readSourceFileTool, proposeCodeChangeTool } from "./tools/selfEditTools";
import { fetchCalendarTool } from "./tools/calendar";
import { researchHasSourceUrls } from "./researchUtils";
import { markdownToPdfBuffer } from "./tools/exportPdf";
import { normalizeApprovalReceipt } from "./approvalReceipt";
import { decideJobFailureRecovery } from "./jobObservability";
import { buildWorkerRuntimeEvent, resolveWorkerType, withWorkerRuntimeEvent } from "./workerRuntime";
import { getProviderStatus } from "./providers/modelProviderAuthProfiles";
import {
  buildFeatureProgressLabel,
  buildFeatureProgressPercent,
  type BuildFeatureProgressInput,
} from "./buildFeatureJobCore";
import { recoverStaleResourcePausedJobsAfterVoice } from "./voiceRuntimeResourceScheduler";
import { requestsReportFile } from "./backgroundJobHandoff";
import { staleJobRequeueUpdate } from "./jobRequeue";

// Re-export from the shared client so existing callers don't break.
export type { NotifyJobCompleteDeps } from "./notifyJobCompleteCore";
export { _notifyJobCompleteCore };
export type AgentJobType = _AgentJobType;
export type { SubmitJobInput };
export const submitAgentJob = _submitAgentJob;
export const getModelForJobType = _getModelForJobType;

function getRevisionDeliverableMeta(jobInput: Record<string, unknown>): Record<string, unknown> {
  const revisionOfDeliverableId = typeof jobInput.revisionOfDeliverableId === "string"
    ? jobInput.revisionOfDeliverableId
    : undefined;
  const revisionOfJobId = typeof jobInput.revisionOfJobId === "string"
    ? jobInput.revisionOfJobId
    : undefined;
  const revisionInstructions = typeof jobInput.revisionInstructions === "string"
    ? jobInput.revisionInstructions
    : undefined;

  if (!revisionOfDeliverableId && !revisionOfJobId && !revisionInstructions) return {};

  return {
    revision: true,
    ...(revisionOfDeliverableId ? { revisionOfDeliverableId } : {}),
    ...(revisionOfJobId ? { revisionOfJobId } : {}),
    ...(revisionInstructions ? { revisionInstructions } : {}),
  };
}

async function notifyJobComplete(
  userId: string,
  agentType: AgentJobType,
  title: string,
  body: string,
  originChannel?: string,
  originDiscordChannelId?: string,
  opts: ChannelSendOpts = {},
): Promise<void> {
  const text = `Jarvis (${agentType}): ${title}\n\n${body}`;
  // Normalise for comparison — ctx.channel values like "Discord #general",
  // "Discord", "Telegram" must all be matched case-insensitively.
  const origin = (originChannel ?? "").toLowerCase();

  // Discord's maximum file size for non-Nitro servers.
  const DISCORD_MAX_FILE_BYTES = 25 * 1024 * 1024;

  /**
   * Send file attachments from opts to a Discord channel or DM.
   * Documents and files are uploaded as Discord attachments; if a PDF exceeds
   * the 25 MB limit a text fallback note is posted instead.
   */
  async function sendDiscordAttachments(channelId: string | null): Promise<void> {
    const { attachmentToBuffer, imageFilename } = await import("../channels/attachmentHelpers");
    const attachments = opts.attachments || [];
    for (const att of attachments) {
      if (att.kind === "document") {
        // `document` attachments carry a Buffer/string in `content`.
        const fileContent = Buffer.isBuffer(att.content)
          ? att.content
          : Buffer.from(att.content as string);

        if (fileContent.length > DISCORD_MAX_FILE_BYTES) {
          const sizeMb = (fileContent.length / 1024 / 1024).toFixed(1);
          // Include the Drive link when available so the user can access the file.
          const driveClause = att.driveLink
            ? ` You can also open it directly on Google Drive: ${att.driveLink}`
            : " You can download the full report from your Jarvis inbox, then use Save to Drive if you want an external copy.";
          const sizeNote =
            `⚠️ The generated PDF (${sizeMb} MB) exceeds Discord's 25 MB file size limit and could not be attached directly.${driveClause}`;
          if (channelId) {
            await postToDiscordChannelById(userId, channelId, sizeNote).catch(() => {});
          } else {
            await sendToDiscordUser(userId, sizeNote).catch(() => {});
          }
          continue;
        }

        const sent = channelId
          ? await sendFileToDiscordChannel(userId, channelId, att.filename, fileContent, att.caption).catch(() => false)
          : await sendFileToDiscordUser(userId, att.filename, fileContent, att.caption).catch(() => false);
        if (!sent) {
          console.warn(`[JobQueue] Discord document attachment failed — userId=${userId} file=${att.filename}`);
        }
      } else if (att.kind === "file") {
        // `file` attachments carry their content via `url` or `data`, not `content`.
        const buf = await attachmentToBuffer(att).catch(() => null);
        if (!buf) {
          console.warn(`[JobQueue] Discord file attachment ${att.filename} had no usable source — skipping`);
          continue;
        }
        if (buf.length > DISCORD_MAX_FILE_BYTES) {
          const sizeMb = (buf.length / 1024 / 1024).toFixed(1);
          const sizeNote = `⚠️ The file ${att.filename} (${sizeMb} MB) exceeds Discord's 25 MB limit and could not be attached directly. You can download it from your Jarvis inbox.`;
          if (channelId) {
            await postToDiscordChannelById(userId, channelId, sizeNote).catch(() => {});
          } else {
            await sendToDiscordUser(userId, sizeNote).catch(() => {});
          }
          continue;
        }
        const sent = channelId
          ? await sendFileToDiscordChannel(userId, channelId, att.filename, buf, att.caption).catch(() => false)
          : await sendFileToDiscordUser(userId, att.filename, buf, att.caption).catch(() => false);
        if (!sent) {
          console.warn(`[JobQueue] Discord file attachment failed — userId=${userId} file=${att.filename}`);
        }
      } else if (att.kind === "image") {
        // Resolve image to a buffer and send as a Discord file upload.
        const buf = await attachmentToBuffer(att).catch(() => null);
        if (buf) {
          const imgName = imageFilename(att.mimeType);
          const sent = channelId
            ? await sendFileToDiscordChannel(userId, channelId, imgName, buf, att.caption).catch(() => false)
            : await sendFileToDiscordUser(userId, imgName, buf, att.caption).catch(() => false);
          if (!sent) console.warn(`[JobQueue] Discord image attachment failed — userId=${userId}`);
        }
      }
      // markdown attachments are already merged into the text body before this point
    }
  }

  try {
    if (origin.startsWith("discord")) {
      // Route back to the originating Discord channel + in_app inbox.
      // Telegram (and any other external channel) is intentionally NOT notified.
      const notified: string[] = [];
      if (originDiscordChannelId) {
        const sent = await postToDiscordChannelById(userId, originDiscordChannelId, text);
        if (sent) {
          notified.push(`discord:channel:${originDiscordChannelId}`);
          await sendDiscordAttachments(originDiscordChannelId);
        } else {
          // Channel post failed (bot lost access etc.) — fall back to DM.
          const dmSent = await sendToDiscordUser(userId, text);
          if (dmSent) {
            notified.push("discord:dm");
            await sendDiscordAttachments(null);
          }
        }
      } else {
        // No specific channel ID stored — deliver via user's Discord DM.
        const dmSent = await sendToDiscordUser(userId, text);
        if (dmSent) {
          notified.push("discord:dm");
          await sendDiscordAttachments(null);
        }
      }
      // Always surface the result in the in-app inbox as well (with attachments if any).
      const inAppCh = getChannel("in_app");
      if (inAppCh) {
        await inAppCh.sendMessage(userId, text, { notificationType: "approval_request", ...opts }).catch(() => {});
        notified.push("in_app");
      }
      console.log(`[JobQueue] notifyJobComplete originChannel=${originChannel} → [${notified.join(", ") || "none"}]`);
      return;
    }

    if (origin === "heartbeat/crew") {
      // Internal heartbeat crew diagnostics belong in diagnostic_events, not
      // user notification channels. Sending these through notifyUser can leak
      // backend triage/planning output into Telegram or create inbox loops.
      await diagEmit({
        userId,
        subsystem: "heartbeat",
        severity: "info",
        message: `Heartbeat crew job completed: ${agentType} - ${title}`.slice(0, 500),
        metadata: {
          originChannel,
          agentType,
          title,
          bodyPreview: body.slice(0, 2000),
        },
      }).catch(() => {});
      console.log(`[JobQueue] notifyJobComplete originChannel=${originChannel} -> [diagnostics]`);
      return;
    }

    if (origin === "telegram") {
      // Telegram-originated jobs go to Telegram + in_app only.
      // We call the channels directly rather than notifyUser to avoid the
      // registry's cross-channel fallback routing (which could reach Discord).
      const notified: string[] = [];
      const telegramCh = getChannel("telegram");
      if (telegramCh) {
        const r = await telegramCh.sendMessage(userId, text, { notificationType: "approval_request", ...opts }).catch(() => ({ ok: false as const }));
        if (r.ok) notified.push("telegram");
      }
      const inAppCh = getChannel("in_app");
      if (inAppCh) {
        await inAppCh.sendMessage(userId, text, { notificationType: "approval_request", ...opts }).catch(() => {});
        notified.push("in_app");
      }
      console.log(`[JobQueue] notifyJobComplete originChannel=${originChannel} → [${notified.join(", ") || "none"}]`);
      return;
    }

    if (origin === "slack" || origin === "whatsapp") {
      const notified: string[] = [];
      const originCh = getChannel(origin);
      if (originCh) {
        const result = await originCh
          .sendMessage(userId, text, {
            notificationType: "approval_request",
            ...opts,
            ...(origin === "slack" && originDiscordChannelId
              ? { threadKey: originDiscordChannelId }
              : {}),
          })
          .catch(() => ({ ok: false as const }));
        if (result.ok) notified.push(origin);
      }
      const inAppCh = getChannel("in_app");
      if (inAppCh) {
        await inAppCh.sendMessage(userId, text, { notificationType: "approval_request", ...opts }).catch(() => {});
        notified.push("in_app");
      }
      console.log(`[JobQueue] notifyJobComplete originChannel=${originChannel} → [${notified.join(", ") || "none"}]`);
      return;
    }

    if (origin === "app" || origin === "coach" || origin === "appchat" || origin === "voice") {
      // In-app (or voice) only — no external channel notification.
      const inAppCh = getChannel("in_app");
      if (inAppCh) {
        await inAppCh.sendMessage(userId, text, { notificationType: "approval_request", ...opts }).catch(() => {});
      }
      console.log(`[JobQueue] notifyJobComplete originChannel=${originChannel} → [in_app]`);
      return;
    }

    // Absent or unrecognised origin (proactive/scheduled jobs such as weekly_pattern,
    // morning brief, heartbeat) → use the user's configured channel preferences as before.
    const results = await notifyUser(userId, "approval_request", text, opts);
    const delivered = results.filter((r) => r.result.ok).map((r) => r.channel).join(", ");
    console.log(`[JobQueue] notifyJobComplete originChannel=${originChannel || "none"} → [${delivered || "none"}]`);
  } catch (err) {
    console.error("[JobQueue] notify failed:", err);
  }
}

// ── Research notification coordinator ────────────────────────────────────────
// Research jobs queued in the same 60-second window belong to the same
// "batch" (typically one user message that caused the coach to queue multiple
// jobs). We group them by finding an existing batch whose anchor createdAt is
// within 60 seconds of the incoming job's createdAt (true sliding window, not
// a floor-divided bucket, so minute-boundary jobs are handled correctly).
//
// When a research job completes it registers itself with the coordinator. The
// coordinator waits up to NOTIFICATION_FLUSH_DELAY_MS for more sibling jobs
// to complete. Once the timer fires it also queries the DB for any sibling
// research jobs that completed in that window but were not registered
// (e.g. processed in parallel or before a restart). It then sends exactly ONE
// notification for the whole batch.
//
// Safety guarantee: the timer always fires (even if siblings fail/cancel),
// so no completed research job is ever left without a notification.

interface BatchedResearchJob {
  title: string;
  body: string;
  /** DB agent_jobs.id — used to locate the deliverable for consolidation. */
  jobId?: string;
  /** Whether this job's prompt explicitly requested a PDF or Word document. */
  promptedPdf?: boolean;
  /** Originating channel (e.g. "Discord #general") for most-common-origin routing. */
  originChannel?: string;
  /** Channel/thread destination used by origins that support direct routing. */
  originDestination?: string;
}

interface BatchedResearchNotification {
  userId: string;
  /** Origin plus direct destination; prevents cross-channel/thread batching. */
  scope: string;
  /** createdAt of the first job in this batch (ms since epoch). Used for window matching. */
  anchorTime: number;
  /** Each job's content, origin info (for routing), and PDF metadata (for consolidation). */
  jobs: BatchedResearchJob[];
  timer: ReturnType<typeof setTimeout>;
}

/** key: `${userId}:research:${anchorTime}` */
const researchNotificationBatches = new Map<string, BatchedResearchNotification>();

/**
 * Tracks anchor times of already-flushed research batches per user so that
 * late-completing siblings in the same window are suppressed rather than
 * triggering a second notification.
 * Map: userId → [{anchorTime, flushedAt}]
 */
const flushedResearchBatches = new Map<string, Array<{ anchorTime: number; flushedAt: number; scope: string }>>();

function researchBatchScope(originChannel?: string, originDestination?: string): string {
  const channel = (originChannel ?? "in_app").trim().toLowerCase() || "in_app";
  return `${channel}:${originDestination ?? ""}`;
}

/** True sibling window — must match the guard in queueBackgroundJob. */
const SIBLING_WINDOW_MS = 60 * 1000;

/** How long we keep flushed-batch records to suppress late arrivals. */
const FLUSHED_BATCH_TTL_MS = 10 * 60 * 1000;

/**
 * How long we wait after the first job in a batch completes before flushing.
 * Long enough for a sibling completing seconds later to join; short enough
 * that the user doesn't wait excessively after a solo research job finishes.
 */
const NOTIFICATION_FLUSH_DELAY_MS = 30 * 1000;

async function flushResearchBatch(key: string): Promise<void> {
  const batch = researchNotificationBatches.get(key);
  if (!batch) return;
  researchNotificationBatches.delete(key);

  const { userId, anchorTime, jobs, scope } = batch;
  if (jobs.length === 0) return;

  // Before sending, query the DB for sibling research jobs that completed in
  // the same ±60 s window but were never registered with the in-memory
  // coordinator (e.g. processed in a parallel worker tick or a prior restart).
  // Merge any extras into the total count so the combined notification is
  // accurate. This is best-effort — failures fall through safely.
  let allSiblingJobIds: string[] = jobs.filter((j) => j.jobId).map((j) => j.jobId!);
  const pdfRequestedByJobId = new Map(
    jobs.flatMap((job) => job.jobId ? [[job.jobId, job.promptedPdf === true] as const] : []),
  );
  try {
    const windowStart = new Date(anchorTime - SIBLING_WINDOW_MS);
    const windowEnd   = new Date(anchorTime + SIBLING_WINDOW_MS);
    const allSiblings = await db
      .select({ id: schema.agentJobs.id, title: schema.agentJobs.title, prompt: schema.agentJobs.prompt, input: schema.agentJobs.input })
      .from(schema.agentJobs)
      .where(
        and(
          eq(schema.agentJobs.userId, userId),
          eq(schema.agentJobs.agentType, "research"),
          eq(schema.agentJobs.status, "complete"),
          gte(schema.agentJobs.createdAt, windowStart),
          sql`${schema.agentJobs.createdAt} <= ${windowEnd}`,
        ),
      );
    const knownIds = new Set(allSiblingJobIds);
    for (const row of allSiblings) {
      const input = row.input && typeof row.input === "object" && !Array.isArray(row.input)
        ? row.input as Record<string, unknown>
        : {};
      const siblingOrigin = typeof input.originChannel === "string" ? input.originChannel : undefined;
      const siblingDestination = typeof input.originDiscordChannelId === "string"
        ? input.originDiscordChannelId
        : siblingOrigin?.toLowerCase() === "slack" && typeof input.originChannelId === "string"
          ? input.originChannelId
          : undefined;
      if (researchBatchScope(siblingOrigin, siblingDestination) !== scope) continue;
      const t = row.title ?? "";
      const promptedPdf = requestsReportFile(row.prompt ?? "");
      pdfRequestedByJobId.set(row.id, promptedPdf);
      if (!knownIds.has(row.id)) {
        jobs.push({ title: t, body: "", originChannel: siblingOrigin, originDestination: siblingDestination, jobId: row.id, promptedPdf });
        allSiblingJobIds.push(row.id);
        knownIds.add(row.id);
      }
    }
  } catch {
    // Non-fatal: flush with only the in-memory jobs.
  }

  // Record this window as flushed so any late-completing siblings are suppressed.
  const now = Date.now();
  const userFlushed = flushedResearchBatches.get(userId) ?? [];
  // Evict stale entries before appending.
  const fresh = userFlushed.filter((f) => now - f.flushedAt < FLUSHED_BATCH_TTL_MS);
  fresh.push({ anchorTime, flushedAt: now, scope });
  flushedResearchBatches.set(userId, fresh);

  // ── Resolve most-common originating channel for routing ──────────────────
  // Ensures the single batched notification goes to the right channel even if
  // a few sibling jobs somehow came from a different channel.
  const originCounts = new Map<string, number>();
  for (const j of jobs) {
    if (j.originChannel) {
      const originKey = j.originChannel.toLowerCase();
      originCounts.set(originKey, (originCounts.get(originKey) ?? 0) + 1);
    }
  }
  let batchOriginChannel: string | undefined;
  let batchOriginDestination: string | undefined;
  if (originCounts.size > 0) {
    let maxCount = 0;
    for (const [ch, count] of originCounts.entries()) {
      if (count > maxCount) { maxCount = count; batchOriginChannel = ch; }
    }
    // Preserve the direct destination for Discord channels and Slack threads.
    if (batchOriginChannel?.startsWith("discord") || batchOriginChannel === "slack") {
      batchOriginDestination = jobs.find(
        (job) => job.originChannel?.toLowerCase() === batchOriginChannel && job.originDestination,
      )?.originDestination;
    }
  }

  // ── Consolidate sibling deliverables into ONE ────────────────────────────
  // When multiple research jobs were queued for the same request, each one
  // inserted its own deliverable. Merge them into a single deliverable so
  // the inbox shows one item, not N.
  let mergedDeliverableId: string | null = null;
  let mergedTitle = jobs[0].title;
  let mergedBody = "";
  let wantsPdf = jobs.some((job) => job.promptedPdf);
  const notifyOpts: ChannelSendOpts = {};
  let pdfNote = "";
  let batchAttachment: NonNullable<ChannelSendOpts["attachments"]>[number] | null = null;

  if (allSiblingJobIds.length > 0) {
    try {
      const hasActiveDeliverables = await db.transaction(async (tx) => {
        // Lock every candidate through consolidation so review actions cannot
        // edit, discard, or revise a sibling between this read and its update
        // or deletion.
        const siblingDeliverables = await tx
          .select()
          .from(schema.deliverables)
          .where(
            and(
              eq(schema.deliverables.userId, userId),
              sql`${schema.deliverables.jobId} = ANY(${allSiblingJobIds})`,
            ),
          )
          .orderBy(asc(schema.deliverables.createdAt))
          .for("update");
        const activeSiblingDeliverables = siblingDeliverables.filter(
          (deliverable) => deliverable.status === "pending_approval" && !deliverable.driveLink,
        );
        let artifactBaseMeta = (activeSiblingDeliverables[0]?.meta as Record<string, unknown> | null) ?? {};
        const activeJobIds = new Set(
          activeSiblingDeliverables
            .map((deliverable) => deliverable.jobId)
            .filter((jobId): jobId is string => typeof jobId === "string"),
        );
        jobs.splice(0, jobs.length, ...jobs.filter((batchJob) => !batchJob.jobId || activeJobIds.has(batchJob.jobId)));
        wantsPdf = jobs.some((job) => job.promptedPdf)
          || Array.from(activeJobIds).some((jobId) => pdfRequestedByJobId.get(jobId) === true);
        if (jobs.length === 0) return false;

        if (activeSiblingDeliverables.length > 1) {
          // Merge all bodies into one consolidated report
          const sections = activeSiblingDeliverables.map((d, i) => {
            const heading = d.title && d.title !== activeSiblingDeliverables[0].title
              ? `\n\n---\n\n## ${d.title}\n\n`
              : i === 0 ? "" : "\n\n---\n\n";
            return `${heading}${d.body || ""}`;
          });
          mergedBody = sections.join("").trim();
          mergedTitle = `Research: ${activeSiblingDeliverables[0].title}`;
          // Update the first deliverable with merged content
          const firstDeliverable = activeSiblingDeliverables[0];
          const firstId = firstDeliverable.id;
          const mergedMeta = {
            ...((firstDeliverable.meta as Record<string, unknown> | null) ?? {}),
            hasDownloadableArtifact: false,
          };
          delete mergedMeta.pdfGenerated;
          delete mergedMeta.pdfFilename;
          delete mergedMeta.pdfDriveLink;
          delete mergedMeta.pdfError;
          delete mergedMeta.fallbackFilename;
          artifactBaseMeta = mergedMeta;
          await tx
            .update(schema.deliverables)
            .set({
              title: mergedTitle,
              body: mergedBody,
              summary: `Consolidated from ${activeSiblingDeliverables.length} research threads.`,
              meta: mergedMeta,
              driveLink: null,
            })
            .where(eq(schema.deliverables.id, firstId));
          if (!wantsPdf) {
            await tx
              .delete(schema.deliverableArtifacts)
              .where(eq(schema.deliverableArtifacts.deliverableId, firstId));
          }
          mergedDeliverableId = firstId;
          // Point all sibling jobs' result.deliverableId to the merged deliverable
          // so job-level views don't end up with stale / deleted IDs.
          for (const d of activeSiblingDeliverables.slice(1)) {
            try {
              const [sibJob] = await tx
                .select()
                .from(schema.agentJobs)
                .where(eq(schema.agentJobs.id, d.jobId ?? ""))
                .limit(1);
              if (sibJob) {
                const currentResult = (sibJob.result as Record<string, unknown>) ?? {};
                await tx
                  .update(schema.agentJobs)
                  .set({ result: { ...currentResult, deliverableId: firstId, mergedInto: firstId } })
                  .where(eq(schema.agentJobs.id, sibJob.id));
              }
            } catch {
              // Non-fatal — stale pointer is cosmetic
            }
            await tx.delete(schema.deliverables).where(eq(schema.deliverables.id, d.id));
          }
          console.log(`[JobQueue] consolidated ${activeSiblingDeliverables.length} research deliverables → ${firstId}`);
        } else if (activeSiblingDeliverables.length === 1) {
          mergedDeliverableId = activeSiblingDeliverables[0].id;
          mergedBody = activeSiblingDeliverables[0].body || "";
          mergedTitle = activeSiblingDeliverables[0].title || mergedTitle;
        }

        if (wantsPdf && mergedBody && mergedDeliverableId) {
          let filename: string;
          let mimeType: string;
          let content: Buffer;
          let caption = mergedTitle;
          try {
            content = await markdownToPdfBuffer(mergedTitle, mergedBody);
            filename = mergedTitle.replace(/[^A-Za-z0-9._\- ]+/g, "_").slice(0, 80).trim() + ".pdf";
            mimeType = "application/pdf";
            pdfNote = `\n\n📄 PDF attached and available in Inbox. Use Save to Drive if you want an external copy.`;
            console.log(`[JobQueue] generated durable consolidated PDF for batch anchorTime=${anchorTime} size=${content.length}B`);
          } catch (pdfErr) {
            const message = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
            console.error("[JobQueue] batch PDF generation failed:", message);
            filename = mergedTitle.replace(/[^A-Za-z0-9._\- ]+/g, "_").slice(0, 80).trim() + ".md";
            mimeType = "text/markdown";
            content = Buffer.from(mergedBody, "utf8");
            caption = `${mergedTitle} (PDF failed — Markdown fallback)`;
            pdfNote = `\n\n⚠️ PDF generation failed — the Markdown fallback is available in Inbox.`;
          }

          // Keep rendering inside the row-lock transaction so approval cannot
          // observe a merged report without its requested artifact. Move this
          // to a durable outbox only if render throughput becomes a bottleneck.
          await tx
            .delete(schema.deliverableArtifacts)
            .where(eq(schema.deliverableArtifacts.deliverableId, mergedDeliverableId));
          await tx.insert(schema.deliverableArtifacts).values({
            deliverableId: mergedDeliverableId,
            userId,
            filename,
            mimeType,
            sizeBytes: content.length,
            data: content,
          });
          await tx
            .update(schema.deliverables)
            .set({
              meta: {
                ...artifactBaseMeta,
                pdfGenerated: mimeType === "application/pdf",
                pdfFilename: filename,
                hasDownloadableArtifact: true,
              },
              driveLink: null,
            })
            .where(eq(schema.deliverables.id, mergedDeliverableId));
          batchAttachment = {
            kind: "document",
            filename,
            content,
            caption,
            mimeType,
          };
        }
        return true;
      });
      if (!hasActiveDeliverables) return;
    } catch (mergeErr) {
      batchAttachment = null;
      pdfNote = "";
      console.error("[JobQueue] deliverable merge failed (non-fatal):", mergeErr);
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  if (batchAttachment) notifyOpts.attachments = [batchAttachment];
  // ─────────────────────────────────────────────────────────────────────────

  const bodiedJobs = jobs.filter((j) => j.body);
  const notifyBody = (bodiedJobs[0]?.body ?? jobs[0].body) + pdfNote;

  const hasPdfAttachment = (notifyOpts.attachments?.length ?? 0) > 0;
  console.log(
    `[JobQueue] research batch flush: ${jobs.length} job(s), deliverable=${mergedDeliverableId ?? "none"}, pdf=${hasPdfAttachment} → userId=${userId}`,
  );

  if (jobs.length === 1) {
    await notifyJobComplete(userId, "research", mergedTitle, notifyBody, batchOriginChannel, batchOriginDestination, notifyOpts);
  } else {
    const combinedTitle = `Research complete (${jobs.length} results) — ${mergedTitle}`;
    console.log(`[JobQueue] flushing batched research notification: ${jobs.length} job(s) → userId=${userId} batchOriginChannel=${batchOriginChannel || "none"}`);
    await notifyJobComplete(userId, "research", combinedTitle, notifyBody, batchOriginChannel, batchOriginDestination, notifyOpts);
  }
}

/**
 * Register a completed research job with the notification coordinator.
 * Uses true sliding-window matching (±60 s on actual createdAt ms) so
 * minute-boundary jobs are correctly batched together.
 *
 * If the sibling window was already flushed (notification already sent), the
 * late arrival is suppressed to prevent a second notification for the same
 * research request.
 */
function scheduleResearchNotification(
  userId: string,
  createdAt: Date,
  deliverableTitle: string,
  notifyBody: string,
  originChannel?: string,
  originDestination?: string,
  jobId?: string,
  promptedPdf?: boolean,
): void {
  const newTime = createdAt.getTime();
  const now = Date.now();
  const scope = researchBatchScope(originChannel, originDestination);

  // Check whether a batch for this window was already flushed (notification sent).
  const userFlushed = flushedResearchBatches.get(userId) ?? [];
  const alreadyFlushed = userFlushed.some(
    (f) =>
      Math.abs(f.anchorTime - newTime) <= SIBLING_WINDOW_MS &&
      f.scope === scope &&
      now - f.flushedAt < FLUSHED_BATCH_TTL_MS,
  );
  if (alreadyFlushed) {
    console.log(
      `[JobQueue] suppressing late research notification (batch already sent) for userId=${userId} title="${deliverableTitle.slice(0, 60)}"`,
    );
    return;
  }

  // Find an existing pending batch for this user whose anchor is within 60 s.
  for (const [key, batch] of researchNotificationBatches.entries()) {
    if (batch.userId !== userId) continue;
    if (batch.scope !== scope) continue;
    if (Math.abs(batch.anchorTime - newTime) <= SIBLING_WINDOW_MS) {
      batch.jobs.push({ title: deliverableTitle, body: notifyBody, originChannel, originDestination, jobId, promptedPdf });
      // Debounce: extend the flush timer so it fires after the last arrival.
      clearTimeout(batch.timer);
      batch.timer = setTimeout(() => flushResearchBatch(key).catch((e) =>
        console.error("[JobQueue] flushResearchBatch failed:", e),
      ), NOTIFICATION_FLUSH_DELAY_MS);
      return;
    }
  }

  // No matching batch — start a new one. Per-job origin is tracked so that
  // flushResearchBatch can compute the most-common origin across all siblings.
  const key = `${userId}:research:${scope}:${newTime}`;
  const timer = setTimeout(() => flushResearchBatch(key).catch((e) =>
    console.error("[JobQueue] flushResearchBatch failed:", e),
  ), NOTIFICATION_FLUSH_DELAY_MS);
  researchNotificationBatches.set(key, {
    userId,
    scope,
    anchorTime: newTime,
    jobs: [{ title: deliverableTitle, body: notifyBody, originChannel, originDestination, jobId, promptedPdf }],
    timer,
  });
}

/**
 * Notify the user that a sub-agent job completed.
 * Research jobs are batched within a 60-second sibling window — exactly one
 * notification is sent per batch via a debounced coordinator.
 * All other agent types receive an immediate individual notification.
 * Both paths respect the originChannel stored in job.input to avoid
 * cross-channel leakage (e.g. Discord research should not notify Telegram).
 */
async function notifySubAgentJobComplete(
  job: typeof schema.agentJobs.$inferSelect,
  deliverableTitle: string,
  notifyBody: string,
  jobId?: string,
  promptedPdf?: boolean,
  opts: ChannelSendOpts = {},
): Promise<void> {
  const jobInput = (job.input as Record<string, unknown>) ?? {};
  const originChannel = typeof jobInput.originChannel === "string" ? jobInput.originChannel : undefined;
  const originDiscordChannelId = typeof jobInput.originDiscordChannelId === "string" ? jobInput.originDiscordChannelId : undefined;
  const originChannelId = typeof jobInput.originChannelId === "string" ? jobInput.originChannelId : undefined;
  const originDestination = originDiscordChannelId
    || (originChannel?.toLowerCase() === "slack" ? originChannelId : undefined);

  if (job.agentType !== "research" || !job.createdAt) {
    await notifyJobComplete(job.userId, job.agentType as AgentJobType, deliverableTitle, notifyBody, originChannel, originDestination, opts);
    return;
  }
  scheduleResearchNotification(job.userId, new Date(job.createdAt), deliverableTitle, notifyBody, originChannel, originDestination, jobId, promptedPdf);
}
// ─────────────────────────────────────────────────────────────────────────────

const TICK_MS = 15 * 1000;
const MAX_JOB_DURATION_MS = 5 * 60 * 1000;
const RESOURCE_PAUSE_RECOVERY_POLL_MS = 5 * 60 * 1000;
const QUEUE_BACKGROUND_JOB_TOOL = "queue_background_job";

let workerRunning = false;
let workerStarted = false;
let stopRequested = false;
let resourcePauseRecoveryTimer: ReturnType<typeof setInterval> | null = null;

function jobInputOf(job: { input: unknown }): Record<string, unknown> {
  return (job.input && typeof job.input === "object" ? job.input : {}) as Record<string, unknown>;
}

function cloudBackgroundEstimatedSpendOf(jobInput: Record<string, unknown>): number {
  const task = jobInput.cloudBackgroundTask;
  if (!task || typeof task !== "object" || Array.isArray(task)) return 0;
  const value = (task as Record<string, unknown>).estimatedSpentUsd;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value * 100) / 100
    : 0;
}

function withCloudBackgroundEstimatedSpend(
  jobInput: Record<string, unknown>,
  estimatedSpentUsd: number,
): Record<string, unknown> {
  const task = jobInput.cloudBackgroundTask;
  if (!task || typeof task !== "object" || Array.isArray(task)) return jobInput;
  return {
    ...jobInput,
    cloudBackgroundTask: {
      ...(task as Record<string, unknown>),
      estimatedSpentUsd,
    },
  };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function budgetCents(value: unknown): number | null {
  if (value == null) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.round(numberValue * 100) : null;
}

async function cloudBackgroundApprovalGateMatches(opts: {
  userId: string;
  agentType: string;
  prompt: string;
  task: ValidatedCloudBackgroundJobInput;
}): Promise<boolean> {
  const [gate] = await db
    .select({
      toolArgs: schema.agentApprovalGates.toolArgs,
      resolvedAt: schema.agentApprovalGates.resolvedAt,
      expiresAt: schema.agentApprovalGates.expiresAt,
    })
    .from(schema.agentApprovalGates)
    .where(and(
      eq(schema.agentApprovalGates.id, opts.task.approvalGateId),
      eq(schema.agentApprovalGates.userId, opts.userId),
      eq(schema.agentApprovalGates.toolName, QUEUE_BACKGROUND_JOB_TOOL),
      eq(schema.agentApprovalGates.status, "approved"),
    ))
    .limit(1);

  const gateArgs = recordOf(gate?.toolArgs);
  if (!gateArgs || gateArgs.task_scoped_cloud !== true) return false;
  if (!(gate.resolvedAt instanceof Date) || !(gate.expiresAt instanceof Date)) return false;
  if (gate.resolvedAt.getTime() > gate.expiresAt.getTime()) return false;

  const budgetMatches = opts.task.providerAuthType !== "api_key"
    || budgetCents(gateArgs.cloud_budget_usd) === budgetCents(opts.task.budgetUsd);

  return (
    stringField(gateArgs.agent_type) === opts.agentType &&
    stringField(gateArgs.prompt) === opts.prompt.trim() &&
    stringField(gateArgs.cloud_provider_id) === opts.task.providerId &&
    stringField(gateArgs.cloud_provider_auth_type) === opts.task.providerAuthType &&
    budgetMatches
  );
}

async function appendWorkerEventToJob(opts: {
  jobId: string;
  agentType: string;
  title: string;
  input: Record<string, unknown>;
  type: "started" | "progress" | "approval_required" | "retrying" | "completed" | "failed" | "cancelled";
  message: string;
  userVisible?: boolean;
  progress?: { currentStep: string; percent?: number };
  checkpoint?: { id: string; reason: string; requiredFor: string; gateId?: string };
  retryAttempt?: number;
  metadata?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select({ input: schema.agentJobs.input })
      .from(schema.agentJobs)
      .where(eq(schema.agentJobs.id, opts.jobId))
      .limit(1)
      .for("update");
    const currentInput = job?.input && typeof job.input === "object" && !Array.isArray(job.input)
      ? job.input as Record<string, unknown>
      : opts.input;
    const workerType = resolveWorkerType({ agentType: opts.agentType, input: currentInput });
    const nextInput = withWorkerRuntimeEvent(
      currentInput,
      buildWorkerRuntimeEvent({
        type: opts.type,
        workerType,
        message: opts.message,
        userVisible: opts.userVisible ?? false,
        progress: opts.progress,
        checkpoint: opts.checkpoint,
        retryAttempt: opts.retryAttempt,
        metadata: opts.metadata,
      }),
    );
    if (!job) return nextInput;

    const inputPatch = {
      workerRuntime: nextInput.workerRuntime,
      workerType: nextInput.workerType,
    };
    const [updated] = await tx
      .update(schema.agentJobs)
      .set({ input: sql`${schema.agentJobs.input} || ${JSON.stringify(inputPatch)}::jsonb` })
      .where(eq(schema.agentJobs.id, opts.jobId))
      .returning({ input: schema.agentJobs.input });
    return updated?.input && typeof updated.input === "object" && !Array.isArray(updated.input)
      ? updated.input as Record<string, unknown>
      : nextInput;
  });
}

async function appendWorkerProgressToJob(opts: {
  jobId: string;
  agentType: string;
  title: string;
  input: Record<string, unknown>;
  currentStep: string;
  percent: number;
  metadata?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  return appendWorkerEventToJob({
    jobId: opts.jobId,
    agentType: opts.agentType,
    title: opts.title,
    input: opts.input,
    type: "progress",
    message: opts.currentStep,
    userVisible: true,
    progress: { currentStep: opts.currentStep, percent: opts.percent },
    metadata: opts.metadata,
  });
}

async function appendWorkerEventById(opts: {
  jobId: string;
  type: "completed" | "failed" | "cancelled";
  message: string;
  userVisible?: boolean;
  progress?: { currentStep: string; percent?: number };
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const [job] = await db
    .select()
    .from(schema.agentJobs)
    .where(eq(schema.agentJobs.id, opts.jobId))
    .limit(1);
  if (!job) return;
  await appendWorkerEventToJob({
    jobId: opts.jobId,
    agentType: job.agentType,
    title: job.title,
    input: jobInputOf(job),
    type: opts.type,
    message: opts.message,
    userVisible: opts.userVisible,
    progress: opts.progress,
    metadata: opts.metadata,
  }).catch((err) => console.warn(`[JobQueue] worker event append failed for ${opts.jobId}:`, err));
}

async function claimNextJob(): Promise<typeof schema.agentJobs.$inferSelect | null> {
  // Pick the oldest queued job whose user has no currently-running job.
  // Use a single SQL CTE so the claim is atomic across worker restarts.
  // Important: raw SQL returns column names verbatim (snake_case), so we
  // claim the id here, then do a typed Drizzle select to get a properly
  // mapped camelCase row.
  const claimed = await db.execute<{ id: string }>(sql`
    WITH busy_users AS (
      SELECT DISTINCT user_id FROM agent_jobs WHERE status IN ('running', 'cancelling')
    ),
    candidate AS (
      SELECT id FROM agent_jobs
      WHERE status = 'queued'
        AND (
          user_id NOT IN (SELECT user_id FROM busy_users)
          -- Parent-child bypass: allow a queued child job to run concurrently when its
          -- declared parent job is currently running (used for build_feature research jobs).
          OR (
            (input->>'parentJobId') IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM agent_jobs parent_job
              WHERE parent_job.id = (agent_jobs.input->>'parentJobId')
                AND parent_job.status IN ('running', 'cancelling')
            )
          )
        )
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE agent_jobs SET status = 'running', started_at = NOW()
    WHERE id IN (SELECT id FROM candidate)
    RETURNING id
  `);
  const claimedId = claimed.rows?.[0]?.id;
  if (!claimedId) return null;

  const [row] = await db
    .select()
    .from(schema.agentJobs)
    .where(eq(schema.agentJobs.id, claimedId))
    .limit(1);
  return row || null;
}

async function failJob(jobId: string, message: string, userId?: string): Promise<void> {
  await appendWorkerEventById({
    jobId,
    type: "failed",
    message: `Job failed: ${message.slice(0, 200)}`,
    userVisible: true,
    progress: { currentStep: "Failed" },
    metadata: { error: message.slice(0, 1000) },
  });
  try {
    await db
      .update(schema.agentJobs)
      .set({ status: "failed", error: message.slice(0, 2000), completedAt: new Date() })
      .where(eq(schema.agentJobs.id, jobId));
  } catch (err) {
    console.error(`[JobQueue] failJob ${jobId} write failed:`, err);
  }
  diagEmit({
    userId,
    subsystem: "job_queue",
    severity: "error",
    message: `Job ${jobId} failed: ${message.slice(0, 200)}`,
    metadata: { jobId },
  }).catch(() => {});
}

/**
 * Returns true when an error message looks like a transient infrastructure
 * problem (auth expiry, network blip, rate-limit) that is NOT a capability gap.
 *
 * Only permanent logic/parsing/tool failures should be recorded as gaps.
 */
function isTransientJobError(msg: string): boolean {
  const lower = msg.toLowerCase();
  // Auth / credential problems — user needs to re-authorise, not a missing tool
  if (/\b(401|403|unauthori[sz]ed|forbidden|invalid.?grant|token.?expired?|refresh.?token|invalid.?token|credentials?|authentication.?fail)\b/.test(lower)) return true;
  // Network / socket problems
  if (/\b(econnrefused|econnreset|etimedout|enotfound|epipe|econnaborted|socket.?hang.?up|network.?error|connection.?refused|connection.?reset)\b/.test(lower)) return true;
  // Rate limits
  if (/\b(429|rate.?limit|too.?many.?requests|quota.?exceeded)\b/.test(lower)) return true;
  // Timeout catch-all (but not "timeout" inside error messages about logic)
  if (/\btimeout\b/.test(lower) && !/\bparse|format|schema\b/.test(lower)) return true;
  return false;
}

/**
 * Record a permanently-failed background job as a capability gap so the Sunday
 * analysis can surface it alongside chat-detected gaps.
 *
 * Skips transient auth/network failures — they are infrastructure problems,
 * not missing capabilities.
 *
 * Fire-and-forget via setImmediate — never blocks the job failure path.
 */
function recordJobCapabilityGap(
  job: { id: string; userId: string; agentType: string; title: string },
  errorMessage: string,
): void {
  if (isTransientJobError(errorMessage)) {
    console.log(`[JobQueue] skipping capability gap for transient error on job ${job.id}: ${errorMessage.slice(0, 120)}`);
    return;
  }
  setImmediate(() => {
    const userMessage = `[${job.agentType}] ${job.title}`.slice(0, 500);
    const replySnippet = errorMessage.slice(0, 300);
    db.insert(schema.capabilityGaps).values({
      userId: job.userId,
      userMessage,
      agentReplySnippet: replySnippet,
      detectedReason: "job_failure",
      channel: "background_job",
      source: "job",
    }).catch((err: unknown) => {
      console.error(`[JobQueue] capability gap insert failed for job ${job.id}:`, err);
    });
  });
}

async function completeJob(
  jobId: string,
  payload: { result: Record<string, unknown>; turns: number; toolCallsCount: number },
): Promise<void> {
  await appendWorkerEventById({
    jobId,
    type: "completed",
    message: "Job completed",
    userVisible: true,
    progress: { currentStep: "Complete", percent: 100 },
    metadata: { result: payload.result },
  });
  await db
    .update(schema.agentJobs)
    .set({
      status: "complete",
      result: payload.result,
      turns: payload.turns,
      toolCallsCount: payload.toolCallsCount,
      completedAt: new Date(),
    })
    .where(eq(schema.agentJobs.id, jobId));
}

async function processJob(job: typeof schema.agentJobs.$inferSelect): Promise<void> {
  console.log(`[JobQueue] running job ${job.id} type=${job.agentType} user=${job.userId}`);

  const jobAbortController = new AbortController();
  const watchdog = setTimeout(() => {
    console.warn(`[JobQueue] job ${job.id} exceeded ${MAX_JOB_DURATION_MS}ms`);
    if (job.agentType === "app_project") {
      jobAbortController.abort(new Error(`Project worker timed out after ${MAX_JOB_DURATION_MS}ms`));
    }
  }, MAX_JOB_DURATION_MS);

  let latestJobInput = jobInputOf(job);

  try {
    // Extract origin channel stored at queue time — used to route the completion
    // notification back to the right channel rather than spamming all channels.
    let jobInput = latestJobInput;
    jobInput = await appendWorkerEventToJob({
      jobId: job.id,
      agentType: job.agentType,
      title: job.title,
      input: jobInput,
      type: "started",
      message: `Started ${job.title}`,
      userVisible: true,
      progress: { currentStep: "Running", percent: 5 },
    }).catch((err) => {
      console.warn(`[JobQueue] worker start event failed for ${job.id}:`, err);
      return jobInput;
    });
    latestJobInput = jobInput;
    const originChannel = typeof jobInput.originChannel === "string" ? jobInput.originChannel : undefined;
    const originChannelId = typeof jobInput.originChannelId === "string" ? jobInput.originChannelId : undefined;
    const originDiscordChannelId = typeof jobInput.originDiscordChannelId === "string" ? jobInput.originDiscordChannelId : undefined;
    const originNotificationDestination = originDiscordChannelId
      || (originChannel?.toLowerCase() === "slack" ? originChannelId : undefined);
    const approvalReceipt = normalizeApprovalReceipt(jobInput.approvalReceipt);
    if (typeof jobInput.approvalGateId === "string") {
      jobInput = await appendWorkerEventToJob({
        jobId: job.id,
        agentType: job.agentType,
        title: job.title,
        input: jobInput,
        type: "approval_required",
        message: "Approval checkpoint is linked to this job",
        userVisible: true,
        progress: { currentStep: "Waiting for approval" },
        checkpoint: {
          id: jobInput.approvalGateId,
          gateId: jobInput.approvalGateId,
          reason: typeof jobInput.approvalReason === "string" ? jobInput.approvalReason : "User approval required",
          requiredFor: typeof jobInput.approvalToolName === "string" ? jobInput.approvalToolName : job.agentType,
        },
      }).catch(() => jobInput);
      latestJobInput = jobInput;
    }

    // Helper: fire the workflow hook if this job belongs to a workflow step.
    const wfId    = jobInput.workflowId    as string | undefined;
    const wfStep  = jobInput.workflowStepIndex as number | undefined;
    const hasWorkflow = !!wfId && wfStep !== undefined;

    if (job.agentType === "weekly_pattern") {
      const result = await runWeeklyPatternJob(job.userId);
      await completeJob(job.id, {
        result: { weekOf: result.weekOf, patterns: result.patternCount, promoted: result.promotedMemories },
        turns: 1,
        toolCallsCount: 0,
      });
      diagEmit({
        userId: job.userId,
        subsystem: "job_queue",
        severity: "info",
        message: `Job ${job.id} (weekly_pattern) completed — ${result.patternCount} patterns`,
        metadata: { jobId: job.id, agentType: job.agentType, recovery: true },
      }).catch(() => {});
      console.log(`[JobQueue] complete weekly_pattern job ${job.id} → ${result.patternCount} patterns`);
      const pendingReviewCount = result.pendingReviewCount ?? 0;
      let pendingLine = "";
      if (pendingReviewCount > 0) {
        const previews = (result.pendingReviewPreviews ?? []).slice(0, 5);
        const previewList = previews.length > 0
          ? "\n" + previews.map((p, i) => `  ${i + 1}. ${p.length > 80 ? p.slice(0, 80) + "…" : p}`).join("\n")
          : "";
        pendingLine = `\n\n🧠 ${pendingReviewCount} new long-term memor${pendingReviewCount === 1 ? "y is" : "ies are"} waiting for your approval before JARVIS uses ${pendingReviewCount === 1 ? "it" : "them"}:${previewList}\n\nOpen the Profile tab → Memory Review section to keep, edit, or discard each one.`;
      }
      const weeklyMsg = result.driveLink
        ? `${result.patternCount} pattern(s) identified, ${result.promotedMemories} promoted to long-term memory.\n${result.summary}\n\n📁 Saved to Google Drive: ${result.driveLink}${pendingLine}`
        : `${result.patternCount} pattern(s) identified, ${result.promotedMemories} promoted to long-term memory.\n${result.summary}${pendingLine}`;
      await notifyJobComplete(
        job.userId,
        "weekly_pattern",
        `Weekly review (${result.weekOf})`,
        weeklyMsg,
      );
      if (hasWorkflow) {
        await onWorkflowJobComplete(wfId!, wfStep!, job.id, result.summary || weeklyMsg).catch((e) =>
          console.error("[JobQueue] workflow hook failed:", e),
        );
      }
      return;
    }

    // ── Named-agent task (orchestrator-dispatched) ─────────────────────────
    if (job.agentType === "named_agent_task") {
      const input = (job.input as Record<string, unknown>) ?? {};
      const namedAgentId = String(input.namedAgentId ?? "");
      const agentName = String(input.agentName ?? "Agent");
      const iterationCount = typeof input.iterationCount === "number" ? input.iterationCount : 0;
      // Optional per-request model override from the orchestrator.
      const namedAgentModel = typeof input.model === "string" ? input.model : undefined;

      if (!namedAgentId) throw new Error("named_agent_task job missing namedAgentId");

      console.log(
        `[JobQueue] named_agent_task agent=${agentName}(${namedAgentId}) iteration=${iterationCount + 1}`,
      );

      const result = await runNamedAgent({
        agentId: namedAgentId,
        userId: job.userId,
        userMessage: job.prompt,
        platform: "orchestrator",
        initiatedBy: "jarvis",
        model: namedAgentModel,
        approvalReceipt,
        jobId: job.id,
      });

      await completeJob(job.id, {
        result: {
          output: result.reply,
          agentId: namedAgentId,
          agentName,
          iterationCount,
        },
        turns: result.turns,
        toolCallsCount: result.toolCalls?.length ?? 0,
      });

      console.log(
        `[JobQueue] named_agent_task complete: agent=${agentName} job=${job.id} ` +
          `turns=${result.turns} iteration=${iterationCount + 1}`,
      );

      const snippet = result.reply.slice(0, 280);
      await notifyJobComplete(
        job.userId,
        "named_agent_task",
        `${agentName} — ${job.title}`,
        `Iteration ${iterationCount + 1} complete. Review output and approve or request a revision.\n\n${snippet}${result.reply.length > 280 ? "…" : ""}`,
        originChannel,
        originDiscordChannelId,
      );

      if (hasWorkflow) {
        await onWorkflowJobComplete(wfId!, wfStep!, job.id, result.reply.slice(0, 1200)).catch((e) =>
          console.error("[JobQueue] workflow hook failed:", e),
        );
      }
      return;
    }

    // ── Custom user-defined agent ──────────────────────────────────────────────
    if (job.agentType === "ephemeral_agent_task") {
      const ephemeralAgent = jobInput.ephemeralAgent && typeof jobInput.ephemeralAgent === "object"
        ? jobInput.ephemeralAgent as Record<string, unknown>
        : {};
      const rawKind = typeof ephemeralAgent.kind === "string" ? ephemeralAgent.kind : "task_worker";
      const kind: EphemeralAgentKind = rawKind === "task_worker" ? "task_worker" : "task_worker";
      const platform = typeof jobInput.originChannel === "string" ? jobInput.originChannel : (originChannel || "app");

      console.log(`[JobQueue] ephemeral_agent_task kind=${kind} job=${job.id}`);

      jobInput = await appendWorkerProgressToJob({
        jobId: job.id,
        agentType: job.agentType,
        title: job.title,
        input: jobInput,
        currentStep: "Preparing temporary worker",
        percent: 20,
        metadata: { kind },
      }).catch((err) => {
        console.warn(`[JobQueue] ephemeral_agent_task progress append failed for ${job.id}:`, err);
        return jobInput;
      });
      latestJobInput = jobInput;

      jobInput = await appendWorkerProgressToJob({
        jobId: job.id,
        agentType: job.agentType,
        title: job.title,
        input: jobInput,
        currentStep: "Running temporary worker",
        percent: 55,
        metadata: { kind },
      }).catch((err) => {
        console.warn(`[JobQueue] ephemeral_agent_task running progress append failed for ${job.id}:`, err);
        return jobInput;
      });
      latestJobInput = jobInput;

      const result = await runEphemeralAgentSession({
        userId: job.userId,
        kind,
        userRequest: job.prompt || job.title,
        platform,
        channelId: originDiscordChannelId,
        parentTaskId: job.id,
      });

      jobInput = await appendWorkerProgressToJob({
        jobId: job.id,
        agentType: job.agentType,
        title: job.title,
        input: jobInput,
        currentStep: "Preparing review deliverable",
        percent: 85,
        metadata: {
          ephemeralAgentId: result.agentId,
          turns: result.turns,
          toolCalls: result.toolCalls?.length ?? 0,
        },
      }).catch((err) => {
        console.warn(`[JobQueue] ephemeral_agent_task deliverable progress append failed for ${job.id}:`, err);
        return jobInput;
      });
      latestJobInput = jobInput;

      const [deliverable] = await db
        .insert(schema.deliverables)
        .values(buildEphemeralWorkerResultDeliverable(job, result, kind))
        .returning({ id: schema.deliverables.id });
      const deliverableId = deliverable?.id || "";

      jobInput = await appendWorkerProgressToJob({
        jobId: job.id,
        agentType: job.agentType,
        title: job.title,
        input: jobInput,
        currentStep: "Review deliverable ready",
        percent: 95,
        metadata: { deliverableId },
      }).catch((err) => {
        console.warn(`[JobQueue] ephemeral_agent_task review progress append failed for ${job.id}:`, err);
        return jobInput;
      });
      latestJobInput = jobInput;

      await completeJob(job.id, {
        result: {
          output: result.reply,
          deliverableId,
          ephemeralAgentId: result.agentId,
          kind,
        },
        turns: result.turns,
        toolCallsCount: result.toolCalls?.length ?? 0,
      });

      console.log(
        `[JobQueue] ephemeral_agent_task complete: kind=${kind} job=${job.id} deliverable=${deliverableId} turns=${result.turns}`,
      );

      await notifyJobComplete(
        job.userId,
        "ephemeral_agent_task",
        job.title,
        result.reply,
        originChannel,
        originDiscordChannelId,
      );

      if (hasWorkflow) {
        await onWorkflowJobComplete(wfId!, wfStep!, job.id, result.reply.slice(0, 1200)).catch((e) =>
          console.error("[JobQueue] workflow hook failed:", e),
        );
      }
      return;
    }

    if (job.agentType === "custom_agent") {
      const input = (job.input as Record<string, unknown>) ?? {};
      const customAgentId = String(input.customAgentId ?? "");

      if (!customAgentId) throw new Error("custom_agent job missing customAgentId");

      const { db: _db } = await import("../db");
      const { customAgents } = await import("@shared/schema");
      const { eq: _eq } = await import("drizzle-orm");

      const [agentDef] = await _db
        .select()
        .from(customAgents)
        .where(_eq(customAgents.id, customAgentId))
        .limit(1);

      if (!agentDef) throw new Error(`Custom agent ${customAgentId} not found`);

      const tokens = await getValidGoogleTokens(job.userId).catch(() => []);
      const googleAccessToken = tokens?.[0] || null;
      const ctx: ToolContext = {
        userId: job.userId,
        googleAccessToken,
        channel: originChannel || `JobQueue/custom_agent`,
        originChannelId,
        jobId: job.id,
        state: { pendingAttachments: [] },
        ...(originDiscordChannelId ? { discordChannelId: originDiscordChannelId } : {}),
      };

      const modelOverride = typeof input.model === "string"
        ? input.model
        : agentDef.model ?? undefined;

      let customSub = await runSubAgent({
        agentType: agentDef.baseType as SubAgentType,
        prompt: job.prompt,
        defaultTitle: job.title,
        context: ctx,
        model: modelOverride,
        extraSystemPrompt: agentDef.extraPrompt ?? undefined,
        approvalReceipt,
      });

      // ── Codex OAuth verification loop (custom_agent) ──────────────────────
      const MAX_CUSTOM_VERIFY_RETRIES = 2;
      let customVerificationPassed: boolean | null = null;
      let customVerificationRetries = 0;
      {
        const { getModel } = await import("../lib/modelPrefs");
        const orchModel = await getModel(job.userId, "orchestrator");
        let correctionContext: string | undefined;

        for (let attempt = 0; attempt <= MAX_CUSTOM_VERIFY_RETRIES; attempt++) {
          const verification = await verifyJobOutput({
            agentType: "custom_agent",
            originalPrompt: job.prompt,
            result: customSub.body,
            orchestratorModel: orchModel,
            userId: job.userId,
            correctionContext,
          });

          if (verification.passed === true) {
            customVerificationPassed = true;
            break;
          }

          if (verification.passed === null) {
            // Verifier timed out or errored — fail-open: deliver as-is, status unknown
            customVerificationPassed = null;
            console.log(
              `[JobQueue] verify unknown (timeout/error) for custom_agent job ${job.id} — delivering with null status: ${verification.reason}`,
            );
            break;
          }

          // passed === false: content rejected — retry if attempts remain
          correctionContext = verification.reason;
          if (attempt < MAX_CUSTOM_VERIFY_RETRIES) {
            customVerificationRetries++;
            console.log(
              `[JobQueue] verify retry ${attempt + 1}/${MAX_CUSTOM_VERIFY_RETRIES} for custom_agent job ${job.id}: ${verification.reason}`,
            );
            const revisedPrompt =
              `${job.prompt}\n\n` +
              `[Previous attempt was rejected for: ${correctionContext}. Please address this in your response.]`;
            customSub = await runSubAgent({
              agentType: agentDef.baseType as SubAgentType,
              prompt: revisedPrompt,
              defaultTitle: job.title,
              context: ctx,
              model: modelOverride,
              extraSystemPrompt: agentDef.extraPrompt ?? undefined,
              approvalReceipt,
            });
          } else {
            customVerificationPassed = false;
            console.log(
              `[JobQueue] verify exhausted for custom_agent job ${job.id} after ${MAX_CUSTOM_VERIFY_RETRIES} retries — delivering best result`,
            );
          }
        }
      }
      customSub.meta.verificationPassed = customVerificationPassed;
      customSub.meta.verificationRetries = customVerificationRetries;
      // ─────────────────────────────────────────────────────────────────────

      const sub = customSub;

      const { db: __db } = await import("../db");
      const { deliverables: _deliverables } = await import("@shared/schema");

      const inserted = await __db
        .insert(_deliverables)
        .values({
          userId: job.userId,
          jobId: job.id,
          agentType: "custom_agent",
          type: sub.type,
          title: `[${agentDef.name}] ${sub.title}`,
          summary: sub.summary,
          body: sub.body,
          meta: { ...sub.meta, ...getRevisionDeliverableMeta(jobInput), customAgentId, customAgentName: agentDef.name },
        })
        .returning({ id: _deliverables.id });

      const deliverableId = inserted[0]?.id || "";

      await completeJob(job.id, {
        result: { deliverableId, type: sub.type, title: sub.title, customAgentId },
        turns: sub.turns,
        toolCallsCount: sub.toolCallsCount,
      });

      console.log(
        `[JobQueue] complete custom_agent job ${job.id} agent="${agentDef.name}" deliverable=${deliverableId}`,
      );

      const notifyMsg = sub.body || sub.summary || "Ready for review";
      await notifyJobComplete(
        job.userId,
        "custom_agent",
        `${agentDef.name}: ${sub.title}`,
        notifyMsg,
        originChannel,
        originDiscordChannelId,
      );

      if (hasWorkflow) {
        const wfOutput = `${sub.title}\n\n${sub.summary || ""}\n\n${sub.body?.slice(0, 1200) || ""}`.trim();
        await onWorkflowJobComplete(wfId!, wfStep!, job.id, wfOutput).catch((e) =>
          console.error("[JobQueue] workflow hook failed:", e),
        );
      }
      return;
    }

    if (job.agentType === "goal_decompose") {
      const result = await runGoalDecomposition(job);
      await completeJob(job.id, {
        result: { goalTreeId: result.goalTreeId, phases: result.phaseCount },
        turns: result.turns,
        toolCallsCount: result.toolCallsCount,
      });
      diagEmit({
        userId: job.userId,
        subsystem: "job_queue",
        severity: "info",
        message: `Job ${job.id} (goal_decompose) completed — ${result.phaseCount} phases`,
        metadata: { jobId: job.id, agentType: job.agentType, recovery: true },
      }).catch(() => {});
      console.log(`[JobQueue] complete goal_decompose job ${job.id} → tree ${result.goalTreeId}`);
      const goalMsg = `Goal broken into ${result.phaseCount} phase(s). Open the Goals tab to review.`;
      await notifyJobComplete(job.userId, "goal_decompose", job.title, goalMsg, originChannel, originDiscordChannelId);
      if (hasWorkflow) {
        await onWorkflowJobComplete(wfId!, wfStep!, job.id, goalMsg).catch((e) =>
          console.error("[JobQueue] workflow hook failed:", e),
        );
      }
      return;
    }

    // ── Jarvis Project session ─────────────────────────────────────────────────
    if (job.agentType === "project_session") {
      const input = (job.input as Record<string, unknown>) ?? {};
      const projectId = String(input.projectId ?? "");
      if (!projectId) throw new Error("project_session job missing projectId");
      const userAnswer = typeof input.userAnswer === "string" ? input.userAnswer : undefined;

      console.log(`[JobQueue] project_session start: project=${projectId}${userAnswer ? " (with user answer)" : ""}`);
      const { runProjectSession } = await import("./projectRunner");
      const sessionResult = await runProjectSession(projectId, userAnswer);

      await completeJob(job.id, {
        result: {
          projectId,
          status: sessionResult.status,
          stepsCompleted: sessionResult.stepsCompleted,
          summary: sessionResult.summary,
        },
        turns: 1,
        toolCallsCount: 0,
      });

      console.log(
        `[JobQueue] project_session complete: project=${projectId} status=${sessionResult.status} stepsCompleted=${sessionResult.stepsCompleted}`,
      );
      return;
    }

    // ── Standalone app build project session ───────────────────────────────────
    if (job.agentType === "app_project") {
      const input = (job.input as Record<string, unknown>) ?? {};
      const projectId = String(input.projectId ?? "");
      if (!projectId) throw new Error("app_project job missing projectId");
      const userAnswer = typeof input.userAnswer === "string" ? input.userAnswer : undefined;
      const originChannel = typeof input.originChannel === "string" ? input.originChannel : undefined;

      console.log(`[JobQueue] app_project start: project=${projectId}${userAnswer ? " (with user answer)" : ""}`);
      const { runAppProjectSession } = await import("./appProjectRunner");
      const sessionResult = await runAppProjectSession(projectId, 1, userAnswer, jobAbortController.signal);

      if (sessionResult.status === "complete") {
        const { packageAndDeliverApp } = await import("./appDelivery");
        try {
          await packageAndDeliverApp(projectId, job.userId, originChannel, jobAbortController.signal);
        } catch (deliveryErr) {
          console.error(`[JobQueue] app_project delivery failed for ${projectId}:`, deliveryErr);
          await db
            .update(schema.jarvisProjects)
            .set({ status: "building", updatedAt: new Date() })
            .where(eq(schema.jarvisProjects.id, projectId));
          throw deliveryErr;
        }
      }

      await completeJob(job.id, {
        result: {
          projectId,
          status: sessionResult.status,
          stepsCompleted: sessionResult.stepsCompleted,
          summary: sessionResult.summary,
        },
        turns: 1,
        toolCallsCount: 0,
      });

      console.log(
        `[JobQueue] app_project complete: project=${projectId} status=${sessionResult.status} stepsCompleted=${sessionResult.stepsCompleted}`,
      );
      return;
    }

    // ── General-purpose diagnostic agent (e.g. auto-debug from IntegrationValidator) ─
    if (job.agentType === "general") {
      const generalCtx: ToolContext = {
        userId: job.userId,
        googleAccessToken: null,
        channel: originChannel || `JobQueue/general`,
        originChannelId,
        jobId: job.id,
        state: { pendingAttachments: [] },
        ...(originDiscordChannelId ? { discordChannelId: originDiscordChannelId } : {}),
      };

      const debugTools = [
        readRecentErrorsTool,
        listSourceFilesTool,
        readSourceFileTool,
        proposeCodeChangeTool,
      ];

      const result = await runAgent({
        messages: [
          {
            role: "system",
            content: `You are Jarvis, an AI assistant running a background diagnostic task.
The user is NOT present in this conversation. Your job is to investigate an error, diagnose the root
cause, and either propose a code fix or send a plain-English diagnosis to the user's inbox.

Always conclude by either calling propose_code_change (if a targeted code fix is appropriate) or by
writing a clear inbox message explaining what is broken and what the user should do.`,
          },
          { role: "user", content: job.prompt },
        ],
        tools: debugTools,
        context: generalCtx,
        maxTurns: 8,
      });

      await completeJob(job.id, {
        result: { output: result.reply, agentType: "general" },
        turns: result.turns,
        toolCallsCount: result.toolCalls?.length ?? 0,
      });

      console.log(`[JobQueue] complete general job ${job.id} turns=${result.turns}`);

      const generalReply = result.reply?.trim()
        ? result.reply.slice(0, 3000)
        : "Auto-debug ran but produced no summary. Please check the Proposals tab or review recent error logs for details.";
      await notifyJobComplete(job.userId, "general", job.title, generalReply, originChannel, originDiscordChannelId);

      if (hasWorkflow) {
        await onWorkflowJobComplete(wfId!, wfStep!, job.id, generalReply).catch((e) =>
          console.error("[JobQueue] workflow hook failed:", e),
        );
      }
      return;
    }

    // ── Morning brief agent ──────────────────────────────────────────────────
    if (job.agentType === "morning_brief") {
      const briefTokens = await getValidGoogleTokens(job.userId).catch(() => []);
      const briefGoogleToken = briefTokens?.[0] || null;
      const briefCtx: ToolContext = {
        userId: job.userId,
        googleAccessToken: briefGoogleToken,
        channel: originChannel || `JobQueue/morning_brief`,
        originChannelId,
        jobId: job.id,
        state: { pendingAttachments: [] },
        ...(originDiscordChannelId ? { discordChannelId: originDiscordChannelId } : {}),
      };
      const briefTools = briefGoogleToken ? [fetchCalendarTool] : [];
      const briefModelOverride = typeof jobInput.model === "string" ? jobInput.model : undefined;

      const briefResult = await runAgent({
        messages: [
          {
            role: "system",
            content: `You are Jarvis, generating an on-demand morning briefing for the user. The user is NOT in this conversation.

Your job: produce a concise, actionable briefing they can act on immediately.

Structure your response as follows (plain markdown, no extra headers):

## ☀️ Morning Briefing

**Today at a glance** — 2-3 sentences summarising the key focus for the day.

**Calendar** — if you called fetch_calendar, list upcoming events for today/tomorrow. If no calendar is connected, skip this section.

**Goals & priorities** — Summarise what the user should focus on. If no specific goals are in the prompt, suggest a general productivity focus.

**Quick wins** — 2-3 small, specific actions the user can complete today.

Keep the whole briefing under 300 words. Be warm but direct. No filler phrases.`,
          },
          { role: "user", content: job.prompt },
        ],
        tools: briefTools,
        context: briefCtx,
        maxTurns: 4,
        model: briefModelOverride,
      });

      await completeJob(job.id, {
        result: { output: briefResult.reply, agentType: "morning_brief" },
        turns: briefResult.turns,
        toolCallsCount: briefResult.toolCalls?.length ?? 0,
      });

      console.log(`[JobQueue] complete morning_brief job ${job.id} turns=${briefResult.turns}`);

      const briefReply = briefResult.reply?.trim()
        ? briefResult.reply.slice(0, 3000)
        : "Your morning briefing is ready. No summary was produced — please try again.";
      await notifyJobComplete(job.userId, "morning_brief", job.title, briefReply, originChannel, originDiscordChannelId);

      if (hasWorkflow) {
        await onWorkflowJobComplete(wfId!, wfStep!, job.id, briefReply).catch((e) =>
          console.error("[JobQueue] workflow hook failed:", e),
        );
      }
      return;
    }

    // ── Build-feature multi-step job ─────────────────────────────────────────
    if (job.agentType === "build_feature") {
      // Lazy imports to avoid circular dependency at module load time
      const { applyCodeChangeTool } = await import("./tools/applyCodeChangeTool");
      const { runShellTool: buildShellTool } = await import("./tools/runShellTool");
      const { cleanupJobWorkspace, execInWorkspaceTool } = await import("./tools/codeExecution");
      const { getModel } = await import("../lib/modelPrefs");

      const orchModel = await getModel(job.userId, "orchestrator");

      const buildCtx: ToolContext = {
        userId: job.userId,
        googleAccessToken: null,
        channel: originChannel || `JobQueue/build_feature`,
        originChannelId,
        jobId: job.id,
        state: { pendingAttachments: [] },
        ...(originDiscordChannelId ? { discordChannelId: originDiscordChannelId } : {}),
      };

      /** Persist progress state into agent_jobs.input (merge, not replace). */
      const persistProgress = async (updates: Record<string, unknown>): Promise<void> => {
        const [updated] = await db.update(schema.agentJobs)
          .set({ input: sql`${schema.agentJobs.input} || ${JSON.stringify(updates)}::jsonb` })
          .where(eq(schema.agentJobs.id, job.id))
          .returning({ input: schema.agentJobs.input });
        jobInput = updated ? jobInputOf(updated) : { ...jobInput, ...updates };
      };

      /** Fire a brief progress notification to the origin channel. */
      const sendBuildPing = (text: string): Promise<void> =>
        notifyJobComplete(job.userId, "build_feature", job.title, text, originChannel, originDiscordChannelId);

      const recordBuildProgress = async (input: BuildFeatureProgressInput): Promise<void> => {
        const currentStep = buildFeatureProgressLabel(input);
        jobInput = await appendWorkerProgressToJob({
          jobId: job.id,
          agentType: job.agentType,
          title: job.title,
          input: jobInput,
          currentStep,
          percent: buildFeatureProgressPercent(input),
          metadata: {
            phase: input.phase,
            stepIndex: input.stepIndex,
            stepCount: input.stepCount,
            stepLabel: input.stepLabel,
            attempt: input.attempt,
          },
        }).catch((err) => {
          console.warn(`[JobQueue] build_feature progress append failed for ${job.id}:`, err);
          return jobInput;
        });
        latestJobInput = jobInput;
      };

      const baseFeatureDescription = String(jobInput.feature_description ?? job.prompt);
      const conversationContext = jobInput.conversationContext ? String(jobInput.conversationContext) : "";
      const featureDescription = conversationContext
        ? `Conversation context (for follow-up understanding):\n${conversationContext}\n\nLatest request: ${baseFeatureDescription}`
        : baseFeatureDescription;

      // ── Phase 1: Research (if requested and not already completed) ──────────
      // Research is queued as a standard agent_jobs record.  claimNextJob has a
      // parent-child bypass: when a queued job's input.parentJobId matches a currently
      // running job, it is allowed to run concurrently (no deadlock).
      // Max wait: 5 minutes, then proceed without research.
      let researchBody = String(jobInput.researchBody ?? "");
      if (Boolean(jobInput.research_required ?? false) && !researchBody) {
        await recordBuildProgress({ phase: "research" });
        let researchJobId = String(jobInput.researchJobId ?? "");

        if (!researchJobId) {
          researchJobId = (await submitAgentJob({
            userId: job.userId,
            agentType: "research",
            title: `Research for build: ${featureDescription.slice(0, 80)}`,
            prompt: `Research context for building this Jarvis feature: ${featureDescription}`,
            input: { parentJobId: job.id, originChannel, originDiscordChannelId },
          })).id;
          await persistProgress({ researchJobId });
          await recordBuildProgress({ phase: "research" });
          await sendBuildPing(`🔍 Background research queued (job ${researchJobId.slice(0, 8)}…) — waiting up to 5 min`);
        }

        // Poll for the research job to reach a terminal state (max 5 minutes).
        const RESEARCH_POLL_INTERVAL_MS = 10_000;
        const RESEARCH_MAX_WAIT_MS = 5 * 60 * 1000;
        const researchPollStart = Date.now();
        let researchStatus = "";
        while (Date.now() - researchPollStart < RESEARCH_MAX_WAIT_MS) {
          const [row] = await db
            .select({ status: schema.agentJobs.status })
            .from(schema.agentJobs)
            .where(eq(schema.agentJobs.id, researchJobId))
            .limit(1);
          researchStatus = row?.status ?? "unknown";
          if (researchStatus === "complete" || researchStatus === "failed") break;
          await recordBuildProgress({ phase: "research" });
          await new Promise((r) => setTimeout(r, RESEARCH_POLL_INTERVAL_MS));
        }

        if (researchStatus === "complete") {
          const [deliv] = await db
            .select({ body: schema.deliverables.body })
            .from(schema.deliverables)
            .where(eq(schema.deliverables.jobId, researchJobId))
            .limit(1);
          if (deliv?.body) {
            researchBody = deliv.body.slice(0, 4000);
            await persistProgress({ researchBody });
            await recordBuildProgress({ phase: "planning" });
            console.log(`[JobQueue] build_feature job ${job.id} — research complete (${researchBody.length} chars)`);
          }
        } else {
          console.warn(`[JobQueue] build_feature job ${job.id} — research job ${researchJobId} did not complete (status=${researchStatus}), proceeding without research`);
          await recordBuildProgress({ phase: "planning" });
        }
      }

      // ── Phase 2: Plan with Codex OAuth ──────────────────────────────────────
      interface BuildStep {
        step_id: string;
        label: string;
        what_to_build: string;
        acceptance_criteria: string;
        files_affected: string[];
      }

      let plan = (jobInput.plan as BuildStep[] | null) ?? null;

      if (!plan) {
        await recordBuildProgress({ phase: "planning" });
        const planCtx = [
          featureDescription,
          researchBody ? `\n\nResearch findings:\n${researchBody}` : "",
        ].join("");

        const planResp = await routeModelTurn({
          tier: "smart",
          maxCompletionTokens: 8192,
          stream: false,
          toolChoice: "none",
          userId: job.userId,
          disableRuntimeStateCard: true,
          logPrefix: "[BuildFeaturePlan]",
          messages: [
            {
              role: "system",
              content: `You are an expert TypeScript/Node.js engineer planning how to build a new Jarvis tool or feature.
Decompose the feature into discrete, independently verifiable implementation steps.
Output a JSON array inside a \`\`\`json block. Each element:
{
  "step_id": "s1",
  "label": "Short verb phrase (4-6 words)",
  "what_to_build": "Detailed implementation instruction for a code worker",
  "acceptance_criteria": "Concrete, measurable criterion — what makes this step done correctly",
  "files_affected": ["server/agent/tools/foo.ts"]
}

Jarvis tool patterns:
- Tools live in server/agent/tools/<name>.ts and export \`const <name>Tool: AgentTool\`
- New tools must be registered in server/agent/tools/index.ts (ALL_TOOLS + telegramCoachTools)
- Express routes go in server/<name>Routes.ts, mounted in server/index.ts
- Shared DB schema lives in shared/schema.ts (Drizzle ORM + drizzle-kit)

Keep the plan minimal: 2-5 steps for most features. Each step is one focused code change.`,
            },
            { role: "user", content: `Feature to build:\n${planCtx}` },
          ],
        });

        const planText = planResp.textContent ?? "";
        const jsonMatch = planText.match(/```json\s*([\s\S]*?)\s*```/);
        const raw = jsonMatch ? jsonMatch[1] : planText.trim();

        try {
          const parsed = JSON.parse(raw);
          plan = (Array.isArray(parsed) ? parsed : [parsed]).map(
            (item: Record<string, unknown>, i: number): BuildStep => ({
              step_id: String(item.step_id ?? `s${i + 1}`),
              label: String(item.label ?? `Step ${i + 1}`),
              what_to_build: String(item.what_to_build ?? featureDescription),
              acceptance_criteria: String(item.acceptance_criteria ?? "Implements the described change correctly"),
              files_affected: Array.isArray(item.files_affected)
                ? (item.files_affected as unknown[]).map(String)
                : [],
            })
          );
        } catch {
          plan = [{
            step_id: "s1",
            label: "Implement feature",
            what_to_build: featureDescription,
            acceptance_criteria: "Feature is implemented and TypeScript type-check passes",
            files_affected: [],
          }];
        }

        await persistProgress({ plan, currentStepIndex: 0, completedSteps: [] });
        await recordBuildProgress({ phase: "step_started", stepIndex: 0, stepCount: plan.length, stepLabel: plan[0]?.label });
        console.log(`[JobQueue] build_feature job ${job.id} — plan with ${plan.length} step(s)`);
        await sendBuildPing(`📋 Build plan ready (${plan.length} step${plan.length === 1 ? "" : "s"}) — beginning implementation`);
      }

      // ── Phase 3: Implement + verify loop (per step) ─────────────────────────
      const currentStepIndex: number =
        typeof jobInput.currentStepIndex === "number" ? jobInput.currentStepIndex : 0;
      const completedSteps: Record<string, unknown>[] = Array.isArray(jobInput.completedSteps)
        ? (jobInput.completedSteps as Record<string, unknown>[])
        : [];

      const workerTools = [
        applyCodeChangeTool,
        buildShellTool,
        listSourceFilesTool,
        readSourceFileTool,
        execInWorkspaceTool,
      ];

      const MAX_STEP_RETRIES = 2;

      for (let stepIdx = currentStepIndex; stepIdx < plan.length; stepIdx++) {
        const step = plan[stepIdx];
        let stepPassed = false;
        let stepRetries = 0;
        let correctionContext: string | undefined;

        console.log(
          `[JobQueue] build_feature job ${job.id} — step ${stepIdx + 1}/${plan.length}: "${step.label}"`
        );

        for (let attempt = 0; attempt <= MAX_STEP_RETRIES; attempt++) {
          await recordBuildProgress({
            phase: "step_started",
            stepIndex: stepIdx,
            stepCount: plan.length,
            stepLabel: step.label,
            attempt,
          });
          const workerPrompt = [
            `Implement build step: "${step.label}"`,
            ``,
            `WHAT TO BUILD:`,
            step.what_to_build,
            ``,
            `ACCEPTANCE CRITERIA:`,
            step.acceptance_criteria,
            ``,
            `FILES LIKELY AFFECTED:`,
            step.files_affected.length > 0
              ? step.files_affected.join(", ")
              : "TBD — use list_source_files to explore first",
            ``,
            `BUILD CONTEXT:`,
            `Feature: ${featureDescription.slice(0, 400)}`,
            `Job ID: ${job.id}  ← use this as job_id when calling exec_in_workspace`,
            researchBody ? `Research: ${researchBody.slice(0, 500)}` : "",
            correctionContext
              ? `\nPrevious attempt rejected — fix specifically: ${correctionContext}`
              : "",
          ].filter(Boolean).join("\n");

          const workerResult = await runAgent({
            model: "gpt-4.1-mini",
            messages: [
              { role: "system", content: BUILD_FEATURE_WORKER_SYSTEM_PROMPT },
              { role: "user", content: workerPrompt },
            ],
            tools: workerTools,
            context: buildCtx,
            maxTurns: 8,
            maxCompletionTokens: 2000,
          });

          const workerOutput = workerResult.reply || "(no output)";

          // b. Mechanical gate: TypeScript type_check must pass before AI review
          await recordBuildProgress({ phase: "type_check", stepIndex: stepIdx, stepCount: plan.length, stepLabel: step.label });
          const typeCheckResult = await buildShellTool.execute({ command: "type_check" }, buildCtx);

          if (!typeCheckResult.ok) {
            correctionContext = `TypeScript type-check failed:\n${typeCheckResult.content.slice(0, 800)}`;
            stepRetries++;
            if (attempt < MAX_STEP_RETRIES) {
              console.log(
                `[JobQueue] build_feature step "${step.label}" type-check retry ${stepRetries}/${MAX_STEP_RETRIES}`
              );
              continue;  // retry — do NOT proceed to AI verify when type-check fails
            }
            // Final attempt still failing type-check → step fails immediately
            console.log(
              `[JobQueue] build_feature step "${step.label}" type-check failed on final attempt — step FAILED`
            );
            break;  // stepPassed remains false
          }

          // c. AI verify: Codex OAuth checks whether the step meets acceptance criteria
          //    Only reached if type_check passed above.
          //    Enrich input with actual file excerpts so the verifier has code evidence.
          const fileSnippets: string[] = [];
          for (const filePath of step.files_affected.slice(0, 3)) {
            if (!filePath || filePath.includes("TBD")) continue;
            try {
              const fileRead = await readSourceFileTool.execute({ file_path: filePath }, buildCtx);
              if (fileRead.ok && fileRead.content) {
                fileSnippets.push(`### ${filePath}\n\`\`\`\n${fileRead.content.slice(0, 700)}\n\`\`\``);
              }
            } catch { /* non-fatal */ }
          }

          const verifyInput = [
            `Worker output:\n${workerOutput.slice(0, 800)}`,
            `\nTypeScript type-check: ✅ passed`,
            fileSnippets.length > 0
              ? `\n\nActual file excerpts (post-implementation):\n${fileSnippets.join("\n\n")}`
              : "",
          ].filter(Boolean).join("\n");

          await recordBuildProgress({ phase: "verifying", stepIndex: stepIdx, stepCount: plan.length, stepLabel: step.label });
          const verification = await verifyJobOutput({
            agentType: "build_feature",
            originalPrompt: `Step: ${step.label}\nAcceptance criteria: ${step.acceptance_criteria}`,
            result: verifyInput,
            orchestratorModel: orchModel,
            userId: job.userId,
            correctionContext,
          });

          if (verification.passed === true) {
            stepPassed = true;
            break;
          }

          if (verification.passed === null) {
            // Verifier timed out — fail-closed: treat as failure for build_feature
            console.log(
              `[JobQueue] build_feature step "${step.label}" verifier timed out — treating as failure`
            );
            if (attempt < MAX_STEP_RETRIES) {
              correctionContext = "AI verifier timed out — retrying step from scratch";
              stepRetries++;
              continue;
            }
            // All retries used — step fails
            break;
          }

          // AI verify returned passed=false
          if (attempt < MAX_STEP_RETRIES) {
            correctionContext = verification.reason;
            stepRetries++;
            console.log(
              `[JobQueue] build_feature step "${step.label}" AI-verify retry ${stepRetries}/${MAX_STEP_RETRIES}: ${verification.reason}`
            );
          }
        }

        // d. Step complete — persist progress
        completedSteps.push({
          step_id: step.step_id,
          label: step.label,
          passed: stepPassed,
          retries: stepRetries,
        });

        const nextStepIdx = stepIdx + 1;
        await persistProgress({
          currentStepIndex: nextStepIdx,
          completedSteps,
          verificationPassed: stepPassed,
          verificationRetries: stepRetries,
        });
        await recordBuildProgress({
          phase: "step_completed",
          stepIndex: stepIdx,
          stepCount: plan.length,
          stepLabel: step.label,
        });

        // If all retries exhausted and step still failed → abort the build
        if (!stepPassed) {
          const failReason =
            `Build aborted at step ${stepIdx + 1}/${plan.length} — "${step.label}" ` +
            `failed verification after ${stepRetries + 1} attempt(s). ` +
            (correctionContext ? `Last rejection: ${correctionContext.slice(0, 300)}` : "");
          await sendBuildPing(
            `❌ Build failed at step "${step.label}" (${stepIdx + 1}/${plan.length}) — ` +
            `all ${stepRetries + 1} attempt(s) exhausted. Aborting.`
          );
          await cleanupJobWorkspace(job.id).catch(() => {});
          await failJob(job.id, failReason, job.userId);
          // Record as a capability gap so Jarvis learns from persistent build failures.
          // recordJobCapabilityGap already filters transient errors internally.
          recordJobCapabilityGap(job, failReason);
          diagEmit({
            userId: job.userId,
            subsystem: "job_queue",
            severity: "warning",
            message: `Job ${job.id} (build_feature) aborted at step "${step.label}"`,
            metadata: { jobId: job.id, agentType: job.agentType, failedStep: step.step_id },
          }).catch(() => {});
          if (hasWorkflow) {
            await onWorkflowJobFail(wfId!, wfStep!, failReason).catch((e) =>
              console.error("[JobQueue] workflow fail hook error:", e),
            );
          }
          return;
        }

        // Progress ping to origin channel
        const nextStep = nextStepIdx < plan.length ? plan[nextStepIdx] : null;
        const retryNote = stepRetries > 0
          ? ` (${stepRetries} retr${stepRetries === 1 ? "y" : "ies"})`
          : "";
        await sendBuildPing(
          `✅ Step ${stepIdx + 1}/${plan.length} complete — "${step.label}"${retryNote}\n` +
          (nextStep ? `Next: "${nextStep.label}"` : "All steps done — running final check…")
        );
      }

      // ── Phase 4: Final type-check + smoke tests + Codex OAuth synthesis ────────
      await recordBuildProgress({ phase: "final_check" });
      const finalTypeCheck = await buildShellTool.execute({ command: "type_check" }, buildCtx);

      // Run the test suite as a smoke test (non-fatal — used only to enrich the summary)
      let finalTestResult: { ok: boolean; content: string } | null = null;
      try {
        await recordBuildProgress({ phase: "smoke_tests" });
        finalTestResult = await buildShellTool.execute({ command: "run_tests" }, buildCtx);
        console.log(
          `[JobQueue] build_feature job ${job.id} — smoke tests: ${finalTestResult.ok ? "✅ passed" : "❌ failed"}`
        );
      } catch (testErr) {
        console.warn(`[JobQueue] build_feature smoke-test invocation failed (non-fatal):`, testErr);
      }

      const stepSummaryLines = completedSteps.map((s, i) =>
        `${i + 1}. ${String(s.label ?? "")} — ${s.passed ? "✅ passed" : "⚠️ had issues"} (${Number(s.retries ?? 0)} retr${Number(s.retries ?? 0) === 1 ? "y" : "ies"})`
      );

      let synthesis = stepSummaryLines.join("\n");
      try {
        await recordBuildProgress({ phase: "synthesis" });
        const synthResp = await routeModelTurn({
          tier: "smart",
          maxCompletionTokens: 600,
          stream: false,
          toolChoice: "none",
          userId: job.userId,
          logPrefix: "[BuildFeatureSynthesis]",
          disableRuntimeStateCard: true,
          messages: [
            {
              role: "system",
              content: `You are Jarvis summarizing a completed multi-step feature build. Be concise and specific.`,
            },
            {
              role: "user",
              content: [
                `Feature built: ${featureDescription}`,
                ``,
                `Steps completed:`,
                stepSummaryLines.join("\n"),
                ``,
                `Final TypeScript type-check: ${finalTypeCheck.ok ? "✅ passed" : `⚠️ ${finalTypeCheck.content.slice(0, 200)}`}`,
                finalTestResult
                  ? `Smoke tests (npm test): ${finalTestResult.ok ? "✅ passed" : `⚠️ ${finalTestResult.content.slice(0, 300)}`}`
                  : "",
                ``,
                `Write a clear 3-5 sentence summary of what was built, what files changed, and any caveats.`,
              ].filter(Boolean).join("\n"),
            },
          ],
        });
        synthesis = synthResp.textContent?.trim() || synthesis;
      } catch (synthErr) {
        console.error(`[JobQueue] build_feature synthesis failed (non-fatal):`, synthErr);
      }

      // Clean up temp workspace
      await cleanupJobWorkspace(job.id).catch(() => {});

      // Schedule server restart to activate new code
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 2_000);

      // Collect the unique files that were declared as changed across all plan steps
      const changedFiles: string[] = [
        ...new Set(plan.flatMap((s) => s.files_affected ?? []).filter((f) => f && !f.includes("TBD"))),
      ];

      const allPassed = completedSteps.every((s) => s.passed === true);
      await completeJob(job.id, {
        result: {
          featureDescription,
          stepsCompleted: plan.length,
          allPassed,
          completedSteps,
          changedFiles,
          finalTypeCheckPassed: finalTypeCheck.ok,
          finalTestsPassed: finalTestResult?.ok ?? null,
        },
        turns: plan.length,
        toolCallsCount: completedSteps.length,
      });

      diagEmit({
        userId: job.userId,
        subsystem: "job_queue",
        severity: "info",
        message: `Job ${job.id} (build_feature) completed — ${plan.length} step(s), allPassed=${allPassed}`,
        metadata: { jobId: job.id, agentType: job.agentType },
      }).catch(() => {});

      const changedFilesSection =
        changedFiles.length > 0
          ? `\n**Files changed:** ${changedFiles.join(", ")}`
          : "";

      const finalMsg = [
        `✅ Build complete — ${plan.length} step${plan.length === 1 ? "" : "s"}${allPassed ? ", all passed" : ""}`,
        ``,
        synthesis,
        changedFilesSection,
        `The server is restarting to activate the new feature.`,
      ].filter(Boolean).join("\n");

      console.log(`[JobQueue] complete build_feature job ${job.id} → ${plan.length} steps, allPassed=${allPassed}`);
      await notifyJobComplete(job.userId, "build_feature", job.title, finalMsg, originChannel, originDiscordChannelId);

      if (hasWorkflow) {
        await onWorkflowJobComplete(wfId!, wfStep!, job.id, synthesis.slice(0, 1200)).catch((e) =>
          console.error("[JobQueue] workflow hook failed:", e),
        );
      }

      // If this build was submitted by the capability gap analyzer, mark the
      // source gap rows as addressed — but ONLY when the build actually passed.
      // (Gaps are NOT marked at submission time to preserve them for re-analysis
      // if the build later fails.)
      if (allPassed) {
        const capGapEntries = Array.isArray(jobInput.capabilityGapEntries)
          ? (jobInput.capabilityGapEntries as Array<{ userMessage: string; detectedReason: string }>)
          : [];
        if (capGapEntries.length > 0) {
          import("./capabilityGapAnalyzer")
            .then(({ markCapabilityGapEntriesAddressed }) => {
              markCapabilityGapEntriesAddressed(job.userId, capGapEntries);
            })
            .catch((err) => {
              console.warn("[JobQueue] build_feature: gap-marking import failed (non-fatal):", err);
            });
        }
      }

      return;
    }

    // ── Deep-research multi-phase job ─────────────────────────────────────────
    if (job.agentType === "deep_research") {
      const { planResearch } = await import("./deepResearchPlanner");

      const DEEP_POLL_INTERVAL_MS = 10_000;
      const PHASE_MAX_WAIT_MS = 8 * 60 * 1000;
      const SYNTHESIS_MAX_WAIT_MS = 4 * 60 * 1000;

      /**
       * Poll a list of job IDs until all reach a terminal state or the timeout
       * elapses. Returns a map of jobId → { status, body }.
       */
      async function pollChildJobs(
        childIds: string[],
        maxWaitMs: number,
      ): Promise<Map<string, { status: string; body: string }>> {
        const results = new Map<string, { status: string; body: string }>();
        const pollStart = Date.now();

        while (
          Date.now() - pollStart < maxWaitMs &&
          results.size < childIds.length
        ) {
          for (const childId of childIds) {
            if (results.has(childId)) continue;
            const [row] = await db
              .select({ status: schema.agentJobs.status })
              .from(schema.agentJobs)
              .where(eq(schema.agentJobs.id, childId))
              .limit(1);
            const status = row?.status ?? "unknown";
            if (status === "complete" || status === "failed") {
              let body = "";
              if (status === "complete") {
                const [deliv] = await db
                  .select({ body: schema.deliverables.body })
                  .from(schema.deliverables)
                  .where(eq(schema.deliverables.jobId, childId))
                  .limit(1);
                body = deliv?.body ?? "";
              }
              results.set(childId, { status, body });
            }
          }
          if (results.size < childIds.length) {
            await new Promise((r) => setTimeout(r, DEEP_POLL_INTERVAL_MS));
          }
        }

        // Mark any remaining as timed out
        for (const childId of childIds) {
          if (!results.has(childId)) {
            console.warn(`[JobQueue] deep_research child job ${childId} timed out`);
            results.set(childId, { status: "timeout", body: "" });
          }
        }

        return results;
      }

      /**
       * Submit N research child jobs for a list of topics and return their IDs.
       */
      async function submitResearchJobs(
        topics: string[],
        labelSuffix: string,
        priorContext?: string,
      ): Promise<string[]> {
        const ids: string[] = [];
        for (const topic of topics) {
          const childInput: Record<string, unknown> = {
            parentJobId: job.id,
            originChannel,
            originChannelId,
            originDiscordChannelId,
            model: "gpt-4.1-mini",
          };
          if (priorContext) {
            childInput.priorContext = priorContext;
          }
          const { id: childId } = await submitAgentJob({
            userId: job.userId,
            agentType: "research",
            title: `${labelSuffix}: ${topic.slice(0, 70)}`,
            prompt: topic,
            input: childInput,
          });
          ids.push(childId);
          console.log(`[JobQueue] deep_research ${job.id} — submitted child ${childId} (${labelSuffix}): "${topic.slice(0, 60)}"`);
        }
        return ids;
      }

      try {
        // ── Step 1: Plan ──────────────────────────────────────────────────────
        await notifyJobComplete(
          job.userId,
          "deep_research",
          job.title,
          "Planning research phases…",
          originChannel,
          originNotificationDestination,
        );

        let plan = await planResearch(job.prompt, job.userId);

        // Fallback: if planner produces no mainTopics somehow, use raw prompt
        if (!plan.mainTopics.length) {
          plan = { prerequisiteTopics: [], mainTopics: [job.prompt], synthesisGoal: job.prompt };
        }

        console.log(
          `[JobQueue] deep_research ${job.id} — plan: prereqs=${plan.prerequisiteTopics.length} main=${plan.mainTopics.length}`,
        );

        // ── Step 2: Phase 1 — Prerequisite research ───────────────────────────
        let priorContext = "";

        if (plan.prerequisiteTopics.length > 0) {
          await notifyJobComplete(
            job.userId,
            "deep_research",
            job.title,
            `Phase 1: researching ${plan.prerequisiteTopics.length} prerequisite topic(s)…`,
            originChannel,
            originNotificationDestination,
          );

          const phase1Ids = await submitResearchJobs(
            plan.prerequisiteTopics,
            "Phase 1",
          );
          const phase1Results = await pollChildJobs(phase1Ids, PHASE_MAX_WAIT_MS);

          const phase1Bodies: string[] = [];
          for (const [childId, result] of phase1Results) {
            if (result.body) {
              const topic = plan.prerequisiteTopics[phase1Ids.indexOf(childId)] ?? "";
              phase1Bodies.push(`### ${topic || childId}\n\n${result.body}`);
            }
          }

          if (phase1Bodies.length > 0) {
            priorContext = phase1Bodies.join("\n\n---\n\n");
            console.log(
              `[JobQueue] deep_research ${job.id} — Phase 1 complete: ${phase1Bodies.length} results, ${priorContext.length} chars of context`,
            );
          } else {
            console.warn(`[JobQueue] deep_research ${job.id} — Phase 1 produced no usable context, proceeding`);
          }
        }

        // ── Step 3: Phase 2 — Main research (with Phase 1 context) ───────────
        await notifyJobComplete(
          job.userId,
          "deep_research",
          job.title,
          `Phase 2: researching ${plan.mainTopics.length} main topic(s)…`,
          originChannel,
          originNotificationDestination,
        );

        const phase2Ids = await submitResearchJobs(
          plan.mainTopics,
          "Phase 2",
          priorContext || undefined,
        );
        const phase2Results = await pollChildJobs(phase2Ids, PHASE_MAX_WAIT_MS);

        // Collect all deliverable bodies (Phase 1 context + Phase 2 results)
        const allBodies: string[] = [];

        if (priorContext) {
          allBodies.push(`## Background Context (Phase 1)\n\n${priorContext}`);
        }

        for (const [childId, result] of phase2Results) {
          if (result.body) {
            const topicIdx = phase2Ids.indexOf(childId);
            const topic = plan.mainTopics[topicIdx] ?? "";
            allBodies.push(`## ${topic || childId}\n\n${result.body}`);
          }
        }

        if (allBodies.length === 0) {
          // Absolute fallback: preserve the limited result in the requested file
          // format so partial failure does not remove the Inbox download.
          const fallbackBody = priorContext || "Deep research could not complete — all phases timed out or failed.";
          const fallbackMeta: Record<string, unknown> = { deepResearch: true, fallback: true };
          const fallbackNotifyOpts: ChannelSendOpts = {};
          let fallbackArtifact: { filename: string; mimeType: string; content: Buffer } | null = null;
          let fallbackNote = "";
          if (requestsReportFile(job.prompt)) {
            const filenameBase = job.title.replace(/[^A-Za-z0-9._\- ]+/g, "_").slice(0, 80).trim() || "Jarvis research report";
            try {
              const content = await markdownToPdfBuffer(job.title, fallbackBody);
              const filename = `${filenameBase}.pdf`;
              fallbackArtifact = { filename, mimeType: "application/pdf", content };
              fallbackMeta.pdfGenerated = true;
              fallbackMeta.pdfFilename = filename;
              fallbackMeta.hasDownloadableArtifact = true;
              fallbackNotifyOpts.attachments = [{
                kind: "document",
                filename,
                content,
                caption: `${job.title} (limited results)`,
                mimeType: "application/pdf",
              }];
              fallbackNote = `\n\n📄 Limited-results PDF generated and available in Inbox.`;
            } catch (pdfErr) {
              const message = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
              const filename = `${filenameBase}.md`;
              const content = Buffer.from(fallbackBody, "utf8");
              fallbackArtifact = { filename, mimeType: "text/markdown", content };
              fallbackMeta.pdfGenerated = false;
              fallbackMeta.pdfError = message;
              fallbackMeta.fallbackFilename = filename;
              fallbackMeta.hasDownloadableArtifact = true;
              fallbackNotifyOpts.attachments = [{
                kind: "document",
                filename,
                content,
                caption: `${job.title} (limited Markdown fallback)`,
                mimeType: "text/markdown",
              }];
              fallbackNote = `\n\n⚠️ PDF generation failed; a limited-results Markdown file is available in Inbox.`;
            }
          }
          await db.transaction(async (tx) => {
            const [created] = await tx.insert(schema.deliverables).values({
              userId: job.userId,
              jobId: job.id,
              agentType: "deep_research",
              type: "research",
              title: job.title,
              summary: "Deep research completed with limited results.",
              body: fallbackBody,
              meta: fallbackMeta,
              driveLink: null,
            }).returning({ id: schema.deliverables.id });
            if (fallbackArtifact && created) {
              await tx.insert(schema.deliverableArtifacts).values({
                deliverableId: created.id,
                userId: job.userId,
                filename: fallbackArtifact.filename,
                mimeType: fallbackArtifact.mimeType,
                sizeBytes: fallbackArtifact.content.length,
                data: fallbackArtifact.content,
              });
            }
          });
          await completeJob(job.id, {
            result: { type: "research", title: job.title },
            turns: 0,
            toolCallsCount: 0,
          });
          await notifyJobComplete(
            job.userId,
            "deep_research",
            job.title,
            fallbackBody + fallbackNote,
            originChannel,
            originNotificationDestination,
            fallbackNotifyOpts,
          );
          return;
        }

        // ── Step 4: Synthesis (or pass-through for single result) ─────────────
        let finalBody = "";
        let finalTitle = job.title;

        const phase2BodiesOnly = phase2Results
          ? [...phase2Results.values()].map((r) => r.body).filter(Boolean)
          : [];

        if (phase2BodiesOnly.length === 1 && !priorContext) {
          // Only one deliverable total — deliver it directly
          finalBody = phase2BodiesOnly[0] ?? allBodies[0] ?? "";
          console.log(`[JobQueue] deep_research ${job.id} — single deliverable, skipping synthesis`);
        } else {
          // Multiple deliverables — run synthesis
          await notifyJobComplete(
            job.userId,
            "deep_research",
            job.title,
            "Synthesising findings into one report…",
            originChannel,
            originNotificationDestination,
          );

          const synthesisPrompt =
            `Synthesise the following research into one coherent report:\n\n` +
            `${allBodies.join("\n\n---\n\n")}\n\n` +
            `Synthesis goal: ${plan.synthesisGoal}`;

          const [synthId] = await submitResearchJobs(
            [synthesisPrompt],
            "Synthesis",
          );
          const synthResults = await pollChildJobs([synthId], SYNTHESIS_MAX_WAIT_MS);
          const synthResult = synthResults.get(synthId);

          if (synthResult?.status === "complete" && synthResult.body) {
            finalBody = synthResult.body;
            console.log(`[JobQueue] deep_research ${job.id} — synthesis complete (${finalBody.length} chars)`);
          } else {
            // Synthesis failed/timed out — concatenate all bodies as fallback
            finalBody = allBodies.join("\n\n---\n\n");
            console.warn(`[JobQueue] deep_research ${job.id} — synthesis failed/timed out, delivering concatenated results`);
          }
        }

        // ── Step 5: Save deliverable and notify ───────────────────────────────
        // Deep research returns before the normal research notification batch,
        // so it must create requested files here instead of merely promising one.
        const notifyOpts: ChannelSendOpts = {};
        const artifactMeta: Record<string, unknown> = {};
        let artifactNote = "";
        let durableArtifact: { filename: string; mimeType: string; content: Buffer } | null = null;

        if (requestsReportFile(job.prompt)) {
          const filenameBase = finalTitle.replace(/[^A-Za-z0-9._\- ]+/g, "_").slice(0, 80).trim() || "Jarvis research report";
          try {
            const pdfBuffer = await markdownToPdfBuffer(finalTitle, finalBody);
            const filename = `${filenameBase}.pdf`;

            // Keep reviewable output inside Jarvis until the user explicitly
            // chooses Save to Drive. The save route handles Drive preferences,
            // scope validation, folder selection, and the external write.
            notifyOpts.attachments = [{
              kind: "document",
              filename,
              content: pdfBuffer,
              caption: finalTitle,
              mimeType: "application/pdf",
            }];
            durableArtifact = { filename, mimeType: "application/pdf", content: pdfBuffer };
            artifactMeta.pdfGenerated = true;
            artifactMeta.pdfFilename = filename;
            artifactMeta.hasDownloadableArtifact = true;
            artifactNote = `\n\n📄 PDF generated (${filename}). It is attached on channels that support job files; the report is also available in Inbox. Use Save to Drive if you want an external copy.`;
          } catch (pdfErr) {
            const filename = `${filenameBase}.md`;
            const message = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
            console.error(`[JobQueue] deep_research PDF generation failed for ${job.id}:`, message);
            notifyOpts.attachments = [{
              kind: "document",
              filename,
              content: finalBody,
              caption: `${finalTitle} (PDF unavailable — markdown fallback)`,
              mimeType: "text/markdown",
            }];
            durableArtifact = { filename, mimeType: "text/markdown", content: Buffer.from(finalBody, "utf8") };
            artifactMeta.pdfGenerated = false;
            artifactMeta.pdfError = message;
            artifactMeta.fallbackFilename = filename;
            artifactMeta.hasDownloadableArtifact = true;
            artifactNote = `\n\n⚠️ PDF generation failed; the complete report remains available in Inbox and is attached as ${filename} on supported channels.`;
          }
        }

        const summarySentence = finalBody.slice(0, 200).replace(/\n+/g, " ").trim();
        await db.transaction(async (tx) => {
          const [createdDeliverable] = await tx.insert(schema.deliverables).values({
            userId: job.userId,
            jobId: job.id,
            agentType: "deep_research",
            type: "research",
            title: finalTitle,
            summary: summarySentence,
            body: finalBody,
            meta: {
              deepResearch: true,
              prerequisiteTopics: plan.prerequisiteTopics,
              mainTopics: plan.mainTopics,
              synthesisGoal: plan.synthesisGoal,
              ...artifactMeta,
            },
            driveLink: null,
          }).returning({ id: schema.deliverables.id });

          if (durableArtifact && createdDeliverable) {
            await tx.insert(schema.deliverableArtifacts).values({
              deliverableId: createdDeliverable.id,
              userId: job.userId,
              filename: durableArtifact.filename,
              mimeType: durableArtifact.mimeType,
              sizeBytes: durableArtifact.content.length,
              data: durableArtifact.content,
            });
          }
        });

        await completeJob(job.id, {
          result: { type: "research", title: finalTitle },
          turns: 0,
          toolCallsCount: 0,
        });

        console.log(`[JobQueue] complete deep_research job ${job.id}`);

        await notifyJobComplete(
          job.userId,
          "deep_research",
          finalTitle,
          finalBody + artifactNote,
          originChannel,
          originNotificationDestination,
          notifyOpts,
        );

        if (hasWorkflow) {
          await onWorkflowJobComplete(wfId!, wfStep!, job.id, finalBody.slice(0, 1200)).catch((e) =>
            console.error("[JobQueue] workflow hook failed:", e),
          );
        }
      } catch (deepErr) {
        const deepMsg = deepErr instanceof Error ? deepErr.message : String(deepErr);
        console.error(`[JobQueue] deep_research job ${job.id} failed:`, deepErr);
        await failJob(job.id, deepMsg, job.userId);
        await notifyJobComplete(
          job.userId,
          "deep_research",
          job.title,
          `Deep research failed: ${deepMsg}`,
          originChannel,
          originNotificationDestination,
        );
      }
      return;
    }

    // Sub-agent run
    const tokens = await getValidGoogleTokens(job.userId).catch(() => []);
    const googleAccessToken = tokens?.[0] || null;
    const ctx: ToolContext = {
      userId: job.userId,
      googleAccessToken,
      channel: originChannel || `JobQueue/${job.agentType}`,
      originChannelId,
      jobId: job.id,
      state: { pendingAttachments: [] },
      ...(originDiscordChannelId ? { discordChannelId: originDiscordChannelId } : {}),
    };
    const jobAgentType = job.agentType as AgentJobType;

    const cloudBackgroundValidation = validateCloudBackgroundJobInput(jobInput);
    if (cloudBackgroundValidation?.ok === false) {
      await failJob(job.id, cloudBackgroundValidation.message, job.userId);
      await notifyJobComplete(
        job.userId,
        jobAgentType,
        job.title,
        cloudBackgroundValidation.message,
        originChannel,
        originDiscordChannelId,
      );
      return;
    }
    if (cloudBackgroundValidation?.ok) {
      const approvalGateVerified = await cloudBackgroundApprovalGateMatches({
        userId: job.userId,
        agentType: job.agentType,
        prompt: job.prompt || "",
        task: cloudBackgroundValidation.task,
      }).catch((err) => {
        console.warn(`[JobQueue] cloud background approval gate verification failed for ${job.id}:`, err);
        return false;
      });
      if (!approvalGateVerified) {
        const message = "Cloud background task approval could not be verified. Please approve it again before restarting this cloud task.";
        await failJob(job.id, message, job.userId);
        await notifyJobComplete(
          job.userId,
          jobAgentType,
          job.title,
          message,
          originChannel,
          originDiscordChannelId,
        );
        return;
      }
      const providerStatus = await getProviderStatus({ userId: job.userId }).catch(() => null);
      const approvedAuthStatus =
        providerStatus?.providers[cloudBackgroundValidation.task.providerId]
          ?.authTypes[cloudBackgroundValidation.task.providerAuthType];
      if (!approvedAuthStatus?.connected) {
        const message =
          `${cloudBackgroundValidation.task.providerLabel} is no longer connected with the approved ` +
          `${cloudBackgroundValidation.task.providerAuthType === "api_key" ? "API-key" : "subscription"} route. ` +
          "Reconnect it in Settings before restarting this cloud background task.";
        await failJob(job.id, message, job.userId);
        await notifyJobComplete(
          job.userId,
          jobAgentType,
          job.title,
          message,
          originChannel,
          originDiscordChannelId,
        );
        return;
      }
    }
    const cloudBackgroundTask = cloudBackgroundValidation?.ok ? cloudBackgroundValidation.task : null;
    const cloudBackgroundModel = cloudBackgroundValidation?.ok ? cloudBackgroundValidation.model : undefined;
    const cloudBackgroundMaxTurns = cloudBackgroundTask
      ? maxCloudBackgroundModelTurnsForBudget(cloudBackgroundTask.budgetUsd, 6)
      : undefined;
    let cloudBackgroundEstimatedSpentUsd = cloudBackgroundEstimatedSpendOf(jobInput);
    const persistCloudBackgroundEstimatedSpend = async (spentUsd: number) => {
      cloudBackgroundEstimatedSpentUsd = Math.round(Math.max(0, spentUsd) * 100) / 100;
      const spendInput = withCloudBackgroundEstimatedSpend(jobInput, cloudBackgroundEstimatedSpentUsd);
      const inputPatch = { cloudBackgroundTask: spendInput.cloudBackgroundTask };
      const [updated] = await db
        .update(schema.agentJobs)
        .set({ input: sql`${schema.agentJobs.input} || ${JSON.stringify(inputPatch)}::jsonb` })
        .where(eq(schema.agentJobs.id, job.id))
        .returning({ input: schema.agentJobs.input });
      jobInput = updated ? jobInputOf(updated) : { ...jobInput, ...inputPatch };
      latestJobInput = jobInput;
    };
    const cloudBackgroundBudgetGuardForRun = () =>
      cloudBackgroundTask && cloudBackgroundTask.providerAuthType === "api_key"
        ? {
            budgetUsd: cloudBackgroundTask.budgetUsd,
            spentUsd: cloudBackgroundEstimatedSpentUsd,
            onSpend: persistCloudBackgroundEstimatedSpend,
          }
        : undefined;
    const markCloudBackgroundBudgetStopped = (result: SubAgentResult) => {
      if (!cloudBackgroundTask) return;
      const summary = result.summary || "Cloud background task stopped before exceeding the approved budget.";
      const packet = buildCompactCloudBackgroundResultPacket({
        jobId: job.id,
        providerId: cloudBackgroundTask.providerId,
        status: "budget_stopped",
        summary,
        actions: ["Preserved the partial worker result before another model request could exceed budget."],
        partial: true,
        spentUsd: cloudBackgroundEstimatedSpentUsd,
        budgetUsd: cloudBackgroundTask.budgetUsd,
      });
      result.meta.cloudBackgroundBudgetStopped = true;
      result.meta.cloudBackgroundBudgetPacket = packet;
      result.meta.cloudBackgroundPartial = true;
      result.summary = summary.toLowerCase().startsWith("partial ")
        ? summary
        : `Partial cloud background result - ${summary}`;
      if (!/^## Partial cloud background result\b/i.test(result.body)) {
        result.body =
          `## Partial cloud background result\n\n` +
          `The approved cloud budget stopped this job before another model request. Partial work was preserved below.\n\n` +
          result.body;
      }
    };

    // Per-type model routing is handled at orchestrator-controlled spawn points
    // (queue_background_job, spawn_subagent) via getModelForJobType(). The model
    // arrives here via job.input.model. Other callers that omit input.model
    // preserve the original resolution path inside runSubAgent.
    const subAgentModelOverride =
      cloudBackgroundModel ?? (typeof jobInput.model === "string" ? jobInput.model : undefined);
    const cloudBackgroundPreferredAuthType =
      cloudBackgroundTask && cloudBackgroundTask.providerId === "openai"
        ? cloudBackgroundTask.providerAuthType
        : undefined;

    // Prior-context injection: deep_research Phase 2 jobs carry priorContext in
    // their input so Phase 1 findings can be injected into the system prompt.
    const priorContextRaw = typeof jobInput.priorContext === "string" ? jobInput.priorContext.trim() : "";
    const priorContextBlock = priorContextRaw
      ? `## Context from prior research phase\n${priorContextRaw}\n\nUse the above as background. Do not re-research topics already covered there — build on them.`
      : undefined;

    const cloudBackgroundInstructionsBlock = cloudBackgroundTask
      ? `## Task-scoped cloud output contract\n${cloudBackgroundTask.compactVerifiedPacketInstructions}`
      : undefined;
    const subAgentExtraSystemPrompt = [
      priorContextBlock,
      cloudBackgroundInstructionsBlock,
    ].filter((value): value is string => Boolean(value && value.trim())).join("\n\n") || undefined;

    let sub = await runSubAgent({
      agentType: job.agentType as SubAgentType,
      prompt: job.prompt,
      defaultTitle: job.title,
      context: ctx,
      model: subAgentModelOverride,
      forceModel: Boolean(cloudBackgroundTask),
      preferredAuthType: cloudBackgroundPreferredAuthType,
      cloudBudget: cloudBackgroundBudgetGuardForRun(),
      maxTurns: cloudBackgroundMaxTurns,
      extraSystemPrompt: subAgentExtraSystemPrompt,
      approvalReceipt,
    });
    if (cloudBackgroundTask && sub.finishReason === "budget_stopped") {
      markCloudBackgroundBudgetStopped(sub);
    }

    // ── Codex OAuth verification loop ─────────────────────────────────────────
    // Applies to user-facing deliverable types only. Skipped for system jobs
    // (weekly_pattern, named_agent_task, morning_brief, goal_decompose) which
    // are handled separately above with their own structured validation.
    const VERIFY_AGENT_TYPES = ["research", "writing", "planning", "email"];
    const MAX_JOB_VERIFY_RETRIES = 2;
    let verificationPassed: boolean | null = null;
    let verificationRetries = 0;
    let verificationReason: string | undefined;
    const skipVerifierForTaskScopedCloudJob = Boolean(cloudBackgroundTask);

    if (skipVerifierForTaskScopedCloudJob) {
      verificationReason = sub.finishReason === "budget_stopped"
        ? "budget_stopped"
        : "task_scoped_cloud_approved_route_guard";
      console.log(
        `[JobQueue] skipped verifier for task-scoped cloud job ${job.id}; verifier is outside the approved provider/auth route`,
      );
    } else if (VERIFY_AGENT_TYPES.includes(job.agentType)) {
      const { getModel } = await import("../lib/modelPrefs");
      const orchModel = await getModel(job.userId, "orchestrator");
      let correctionContext: string | undefined;

      for (let attempt = 0; attempt <= MAX_JOB_VERIFY_RETRIES; attempt++) {
        const verification = await verifyJobOutput({
          agentType: job.agentType,
          originalPrompt: job.prompt,
          result: sub.body,
          orchestratorModel: orchModel,
          userId: job.userId,
          correctionContext,
        });

        if (verification.passed === true) {
          verificationPassed = true;
          break;
        }

        if (verification.passed === null) {
          // Verifier timed out or errored — fail-open: deliver as-is, status unknown
          verificationPassed = null;
          console.log(
            `[JobQueue] verify unknown (timeout/error) for job ${job.id} — delivering with null status: ${verification.reason}`,
          );
          break;
        }

        // passed === false: content rejected — retry if attempts remain
        correctionContext = verification.reason;
        if (attempt < MAX_JOB_VERIFY_RETRIES) {
          if (cloudBackgroundTask && /stopped before the next model request/i.test(sub.body)) {
            verificationPassed = null;
            sub.meta.cloudBackgroundBudgetStopped = true;
            sub.meta.cloudBackgroundBudgetPacket = null;
            sub.summary = `Partial cloud background result — ${sub.summary}`;
            console.log(
              `[JobQueue] cloud budget stopped retry for job ${job.id} after estimated spend $${cloudBackgroundEstimatedSpentUsd.toFixed(2)}`,
            );
            break;
          }
          verificationRetries++;
          console.log(
            `[JobQueue] verify retry ${attempt + 1}/${MAX_JOB_VERIFY_RETRIES} for job ${job.id} (${job.agentType}): ${verification.reason}`,
          );
          const revisedPrompt =
            `${job.prompt}\n\n` +
            `[Previous attempt was rejected for: ${correctionContext}. Please address this in your response.]`;
          sub = await runSubAgent({
            agentType: job.agentType as SubAgentType,
            prompt: revisedPrompt,
            defaultTitle: job.title,
            context: ctx,
            model: subAgentModelOverride,
            forceModel: Boolean(cloudBackgroundTask),
            preferredAuthType: cloudBackgroundPreferredAuthType,
            cloudBudget: cloudBackgroundBudgetGuardForRun(),
            maxTurns: cloudBackgroundMaxTurns,
            approvalReceipt,
          });
          if (cloudBackgroundTask && sub.finishReason === "budget_stopped") {
            markCloudBackgroundBudgetStopped(sub);
          }
        } else {
          verificationPassed = false;
          console.log(
            `[JobQueue] verify exhausted for job ${job.id} after ${MAX_JOB_VERIFY_RETRIES} retries — delivering best result`,
          );
        }
      }
    }

    // Attach verification outcome to meta so the UI can surface a badge.
    sub.meta.verificationPassed = verificationPassed;
    sub.meta.verificationRetries = verificationRetries;
    if (verificationReason) {
      sub.meta.verificationReason = verificationReason;
    }
    if (cloudBackgroundTask) {
      sub.meta.cloudBackgroundTask = {
        ...cloudBackgroundTask,
        liveModelSwitch: false,
        estimatedSpentUsd: cloudBackgroundEstimatedSpentUsd,
        status: sub.meta.cloudBackgroundBudgetStopped ? "budget_stopped" : "complete",
        partial: Boolean(sub.meta.cloudBackgroundPartial),
      };
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (job.agentType === "research" && !researchHasSourceUrls(sub.body)) {
      sub.meta.noSourceUrls = true;
      const NO_SOURCES_BANNER =
        "> ⚠️ **No cited sources.** This result does not contain a ## Sources section with real URLs. " +
        "The research agent may not have performed a live web search. Verify any claims before acting on them.\n\n";
      sub.body = NO_SOURCES_BANNER + sub.body;
      sub.summary = "⚠️ No cited sources — " + sub.summary;
    }

    // ── Format request detection ──────────────────────────────────────────────
    // Persist requested PDFs with the deliverable transaction. Research may
    // later replace its per-job artifact with one consolidated batch artifact,
    // but the initial durable copy survives worker restarts before that timer.
    const wantsPdf = requestsReportFile(job.prompt || "");
    let pdfNote = "";
    let durableArtifact: { filename: string; mimeType: string; content: Buffer } | null = null;

    if (wantsPdf && (job.agentType === "writing" || job.agentType === "planning" || job.agentType === "research")) {
      const filenameBase = sub.title.replace(/[^A-Za-z0-9._\- ]+/g, "_").slice(0, 80).trim() || "Jarvis document";
      try {
        const pdfBuffer = await markdownToPdfBuffer(sub.title, sub.body);
        const filename = `${filenameBase}.pdf`;
        sub.meta.pdfGenerated = true;
        sub.meta.pdfFilename = filename;
        sub.meta.hasDownloadableArtifact = true;
        durableArtifact = { filename, mimeType: "application/pdf", content: pdfBuffer };
        if (job.agentType !== "research") {
          pdfNote = `\n\n📄 PDF attached and available in Inbox. Use Save to Drive if you want an external copy.`;
          (ctx.state.pendingAttachments ||= []).push({
            kind: "document",
            filename,
            content: pdfBuffer,
            caption: sub.title,
            mimeType: "application/pdf",
          });
        }
      } catch (pdfErr) {
        const pdfMsg = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
        const filename = `${filenameBase}.md`;
        console.error(`[JobQueue] ${job.agentType} PDF generation failed for job ${job.id}:`, pdfMsg);
        sub.meta.pdfGenerated = false;
        sub.meta.pdfError = pdfMsg;
        sub.meta.fallbackFilename = filename;
        sub.meta.hasDownloadableArtifact = true;
        durableArtifact = { filename, mimeType: "text/markdown", content: Buffer.from(sub.body, "utf8") };
        if (job.agentType !== "research") {
          pdfNote = `\n\n⚠️ PDF generation failed; the Markdown fallback is attached and available in Inbox.`;
          (ctx.state.pendingAttachments ||= []).push({
            kind: "document",
            filename,
            content: sub.body,
            caption: `${sub.title} (Markdown fallback)`,
            mimeType: "text/markdown",
          });
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    const deliverableMeta = { ...sub.meta, ...getRevisionDeliverableMeta(jobInput) };

    const deliverableId = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(schema.deliverables)
        .values({
          userId: job.userId,
          jobId: job.id,
          agentType: job.agentType,
          type: sub.type,
          title: sub.title,
          summary: sub.summary,
          body: sub.body,
          meta: deliverableMeta,
          driveLink: null,
        })
        .returning({ id: schema.deliverables.id });

      if (durableArtifact && inserted) {
        await tx.insert(schema.deliverableArtifacts).values({
          deliverableId: inserted.id,
          userId: job.userId,
          filename: durableArtifact.filename,
          mimeType: durableArtifact.mimeType,
          sizeBytes: durableArtifact.content.length,
          data: durableArtifact.content,
        });
      }
      return inserted?.id || "";
    });
    await completeJob(job.id, {
      result: { deliverableId, type: sub.type, title: sub.title },
      turns: sub.turns,
      toolCallsCount: sub.toolCallsCount,
    });
    diagEmit({
      userId: job.userId,
      subsystem: "job_queue",
      severity: "info",
      message: `Job ${job.id} (${job.agentType}) completed — deliverable ${deliverableId}`,
      metadata: { jobId: job.id, agentType: job.agentType, recovery: true },
    }).catch(() => {});
    console.log(`[JobQueue] complete ${job.agentType} job ${job.id} → deliverable ${deliverableId}`);
    const subNotifyMsg = (sub.body || sub.summary || "Ready for review") + pdfNote;

    // For writing jobs with PDF attachments, forward those attachments in the notification.
    // Research jobs: the batch coordinator handles attachments at flush time.
    const subNotifyOpts: ChannelSendOpts = {};
    if (job.agentType !== "research" && ctx.state.pendingAttachments && ctx.state.pendingAttachments.length > 0) {
      subNotifyOpts.attachments = ctx.state.pendingAttachments as ChannelSendOpts["attachments"];
    }

    // Use sibling-aware notification: if another job from the same batch is
    // still running, defer so the last one to finish sends one notification.
    await notifySubAgentJobComplete(job, sub.title, subNotifyMsg, job.id, wantsPdf && job.agentType === "research", subNotifyOpts);
    if (hasWorkflow) {
      const wfOutput = `${sub.title}\n\n${sub.summary || ""}\n\n${sub.body?.slice(0, 1200) || ""}`.trim();
      await onWorkflowJobComplete(wfId!, wfStep!, job.id, wfOutput).catch((e) =>
        console.error("[JobQueue] workflow hook failed:", e),
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[JobQueue] job ${job.id} failed:`, err);

    const jobInput = latestJobInput;
    const MAX_RETRIES = 2;
    const recovery = decideJobFailureRecovery({
      input: jobInput,
      errorMessage: msg,
      maxRetries: MAX_RETRIES,
    });

    // Log persistent errors to system_error_log for Jarvis self-debugging
    logSystemError({
      source: `jobQueue/${job.agentType}`,
      message: msg,
      error: err,
      level: "error",
      context: { jobId: job.id, agentType: job.agentType, retryCount: recovery.nextRetryCount },
      userId: job.userId,
    }).catch(() => {});

    if (recovery.action === "requeue") {
      console.log(`[JobQueue] re-queuing job ${job.id} (attempt ${recovery.nextRetryCount}/${MAX_RETRIES}) after error: ${msg}`);
      try {
        const retryBaseInput = recovery.nextInput ?? jobInput;
        const retryInput = withWorkerRuntimeEvent(
          retryBaseInput,
          buildWorkerRuntimeEvent({
            type: "retrying",
            workerType: resolveWorkerType({ agentType: job.agentType, input: retryBaseInput }),
            message: `Retrying after failure: ${msg.slice(0, 160)}`,
            userVisible: true,
            progress: { currentStep: `Retrying (${recovery.nextRetryCount}/${MAX_RETRIES})` },
            retryAttempt: recovery.nextRetryCount,
            metadata: { error: msg.slice(0, 1000) },
          }),
        );
        const retryInputPatch = {
          workerRuntime: retryInput.workerRuntime,
          workerType: retryInput.workerType,
          ...(Object.hasOwn(retryInput, "retryCount") ? { retryCount: retryInput.retryCount } : {}),
          ...(Object.hasOwn(retryInput, "providerThrottleCount")
            ? { providerThrottleCount: retryInput.providerThrottleCount }
            : {}),
        };
        const [requeued] = await db
          .update(schema.agentJobs)
          .set({
            status: "queued",
            startedAt: null,
            error: recovery.persistedError,
            input: sql`${schema.agentJobs.input} || ${JSON.stringify(retryInputPatch)}::jsonb`,
          })
          .where(and(eq(schema.agentJobs.id, job.id), eq(schema.agentJobs.status, "running")))
          .returning({ id: schema.agentJobs.id });
        if (!requeued) {
          console.log(`[JobQueue] skipped retry for ${job.id} because its status changed`);
          await db
            .update(schema.agentJobs)
            .set({ status: "cancelled", completedAt: new Date() })
            .where(and(eq(schema.agentJobs.id, job.id), eq(schema.agentJobs.status, "cancelling")));
        }
      } catch (retryErr) {
        console.error(`[JobQueue] failed to re-queue job ${job.id}:`, retryErr);
        await failJob(job.id, msg, job.userId);
      }
    } else {
      console.log(`[JobQueue] permanently failing job ${job.id} after ${MAX_RETRIES + 1} total attempts`);
      await failJob(job.id, msg, job.userId);
      if (job.agentType === "app_project" || job.agentType === "project_session") {
        const projectId = typeof jobInput.projectId === "string" ? jobInput.projectId : "";
        if (projectId) {
          await db
            .update(schema.jarvisProjects)
            .set({ status: "failed", nextRunAt: null, updatedAt: new Date() })
            .where(eq(schema.jarvisProjects.id, projectId));
        }
      }
      // Record as a capability gap if the failure is not transient (auth/network).
      recordJobCapabilityGap(job, msg);
      // Fail the workflow step if applicable.
      const wfId2   = jobInput.workflowId    as string | undefined;
      const wfStep2 = jobInput.workflowStepIndex as number | undefined;
      if (wfId2 && wfStep2 !== undefined) {
        await onWorkflowJobFail(wfId2, wfStep2, msg).catch((e) =>
          console.error("[JobQueue] workflow fail hook failed:", e),
        );
      }
    }
  } finally {
    clearTimeout(watchdog);
  }
}

async function tick(): Promise<void> {
  // Drain a few jobs per tick so multiple users don't starve each other.
  for (let i = 0; i < 5; i++) {
    const job = await claimNextJob();
    if (!job) return;
    // Run the job but don't block the tick — let it run in parallel for
    // different users (the SQL claim already enforces one-per-user).
    processJob(job).catch((err) => {
      console.error(`[JobQueue] processJob threw for ${job.id}:`, err);
    });
  }
}

/**
 * Recover any jobs that were running when the process died — return
 * them to the queue so the restarted worker picks them up.
 */
async function recoverStaleJobs(): Promise<void> {
  try {
    // Jobs stuck in 'running' when the process died — re-queue them.
    const requeued = await db
      .update(schema.agentJobs)
      .set(staleJobRequeueUpdate())
      .where(eq(schema.agentJobs.status, "running"))
      .returning({ id: schema.agentJobs.id });
    if (requeued.length > 0) {
      console.log(`[JobQueue] recovered ${requeued.length} stale running job(s) from previous process`);
    }
    // Jobs in 'cancelling' when the process died — mark them cancelled since
    // the user already requested cancellation and the worker is gone.
    const cancelled = await db
      .update(schema.agentJobs)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(eq(schema.agentJobs.status, "cancelling"))
      .returning({ id: schema.agentJobs.id });
    if (cancelled.length > 0) {
      console.log(`[JobQueue] cancelled ${cancelled.length} stale cancelling job(s) from previous process`);
    }
    await recoverStaleVoicePausedJobs("previous process");
  } catch (err) {
    console.error("[JobQueue] recoverStaleJobs failed:", err);
  }
}

async function recoverStaleVoicePausedJobs(source: string): Promise<void> {
  try {
    const resourceResumed = await recoverStaleResourcePausedJobsAfterVoice();
    if (resourceResumed.length > 0) {
      console.log(`[JobQueue] recovered ${resourceResumed.length} stale voice-paused job(s) from ${source}`);
    }
  } catch (err) {
    console.error(`[JobQueue] stale voice-paused recovery failed from ${source}:`, err);
  }
}

export function startJobQueueWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  stopRequested = false;

  recoverStaleJobs().catch((err) => console.error("[JobQueue] recover error:", err));
  resourcePauseRecoveryTimer = setInterval(() => {
    recoverStaleVoicePausedJobs("live recovery").catch((err) => {
      console.error("[JobQueue] live stale voice-paused recovery failed:", err);
    });
  }, RESOURCE_PAUSE_RECOVERY_POLL_MS);
  (resourcePauseRecoveryTimer as { unref?: () => void }).unref?.();

  const loop = async () => {
    if (stopRequested) return;
    if (workerRunning) {
      setTimeout(loop, TICK_MS);
      return;
    }
    workerRunning = true;
    try {
      await tick();
    } catch (err) {
      console.error("[JobQueue] tick error:", err);
    } finally {
      workerRunning = false;
      setTimeout(loop, TICK_MS);
    }
  };

  setTimeout(loop, 5000);
  console.log(`[JobQueue] worker started — polling every ${TICK_MS / 1000}s`);
}

export function stopJobQueueWorker(): void {
  stopRequested = true;
  if (resourcePauseRecoveryTimer) {
    clearInterval(resourcePauseRecoveryTimer);
    resourcePauseRecoveryTimer = null;
  }
}
