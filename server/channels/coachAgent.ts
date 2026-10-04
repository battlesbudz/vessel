import { db } from "../db";
import { eq, and, desc, sql, gte } from "drizzle-orm";
import * as schema from "@shared/schema";
import { runAgent } from "../agent/harness";
import { activationPlanner } from "../agent/activationPlanner";
import { parseChannelKey, resolveChannelTools } from "../agent/tools/channelTools";
import { filterToolsByGroups, type ToolGroup } from "../agent/tools/index";
import { getChannel } from "./registry";
import { getValidGoogleTokens } from "../userTokenStore";
import { getRecentEmailCommitments } from "../integrations/gmail";
import { getGoogleCalendarEvents } from "../integrations/googleCalendar";
import { getRecentInteractions, formatInteractionTimeline, logInteraction } from "../interactionLog";
import { getSoulPromptBlock } from "../memory/soul";
import { isUserPaired, isAndroidDaemonActive, isDesktopDaemonActive, isDaemonActionAllowed, hasDaemonPairing } from "../daemon/bridge";
import { buildYouTubeContextBlock } from "../utils/youtubeAutoFetch";
import type { ChannelAttachment } from "./types";
import { runFastOrchestratorReply, runOrchestrator } from "../agent/orchestrator";
import { getDeterministicFastReply, isFastInteractiveRequest, isFastLaneDeflection } from "../agent/fastInteractive";
import { preThink, postCheck } from "../agent/qualityLoop";
import { getModel, MODEL_DEFAULTS } from "../lib/modelPrefs";
import { contextRegistry } from "../agent/contextRegistry";
import { buildBudgetedContextBlock, BUDGET_PRESETS, truncateToBudget } from "../memory/contextBuilder";
import { processLivingContextUpdate } from "../workspace/livingContextRouter";
import { classifyBuildIntent, classifyBuildFollowUp, classifyStandaloneAppProjectIntent, classifyToolAwareRoute, isUnrelatedIntent, hasActiveBuildSession, classifyBuildResume, findBuildDescription, BUILD_ACK_MARKER, findSuspendedBuild, SUSPENDED_BUILD_REMINDED_MARKER, type StoredBuildSession } from "../agent/queryClassifier";
import { routeBuildIntent } from "../agent/buildIntentRouter";
import { routeAutonomyRequest } from "../agent/autonomyRuntime";
import { buildBackgroundJobPrompt } from "../agent/backgroundJobHandoff";
import { getCoachAppAgentId } from "../agent/coreAgentIds";
import { createSystemApprovalOnBeforeTool } from "../agent/systemApprovalGate";
import { resolvePhoneRuntimeRequestText } from "../agent/phoneRuntimeRouting";
import { ANDROID_PHONE_RUNTIME_TOOL_NAMES } from "../agent/androidPhoneRuntimeToolNames";
import { getCoachAgentSessionAgentId } from "./coachAgentSession";
import { listPendingPersonalCommitments } from "../commitments/dbCommitmentRepository";
import { recordStatusCheckFollowUp } from "../liveActions/baselineMetrics";
import {
  ensurePhoneRuntimeOperation,
  findReferencedPhoneRuntimeOperation,
  formatPhoneRuntimeOperationContext,
  isConcretePhoneRuntimeCommand,
  wrapPhoneRuntimeOperationTools,
} from "../agent/phoneRuntimeOperationStore";
// Side-effect import: registers workspace topic context provider.
import "../agent/providers/topicContext";

export interface CoachReplyInput {
  userId: string;
  userText: string;
  channelName: string; // "Telegram" | "WhatsApp" | "Slack" | "Daemon" | "Discord"
  imageUrl?: string;
  /** Optional streaming callback — called with each ~25-char chunk of the final
   *  reply so callers can progressively update an external message (e.g. Discord
   *  message edits). Not called for intermediate tool-call turns. */
  onToken?: (chunk: string) => void;
  /** Optional heartbeat callback fired during long Android automation runs
   *  (turn 15+, every 5 turns). Callers use this to keep the user informed
   *  without consuming an extra model turn. */
  onProgressMessage?: (message: string) => void;
  /** Current external chat/channel ID when the caller has one (Telegram chat ID, Discord channel ID, etc.). */
  originChannelId?: string;
  /** Stable inbound turn ID used to avoid double-counting transport retries. */
  statusObservationId?: string;
  /** True only when this invocation comes directly from a user inbound boundary. */
  observeStatusCheck?: boolean;
  /** Discord guild (server) ID — set when the request originates from a Discord guild channel.
   *  Surfaced in ToolContext so Discord-specific tools (e.g. deleteDiscordChannel) can
   *  identify the server without requiring a pre-configured workspace. */
  discordGuildId?: string;
  /** Discord text channel ID — DM or guild channel. Used by the speak tool to deliver audio. */
  discordChannelId?: string;
  /**
   * SDK session ID for native session resumption (mirrors named-agent pattern).
   *
   * When provided the coach pipeline attempts to resume the cached conversation
   * state from the server-side session store (in-process cache → DB) and skips
   * the `chat_history` DB fetch for that turn. On the first message this field
   * is absent; a new session is initialised and the returned `sdkSessionId`
   * should be forwarded to the caller so it can resume on the next turn.
   */
  sdkSessionId?: string;
  /**
   * Optional additional tools injected for a specific run (e.g. scheduler
   * injects `flag_task_needs_attention` scoped to the running task).
   * Merged into the channel's normal tool set before passing to the agent.
   */
  extraTools?: import("../agent/types").AgentTool[];
  /** Optional caller abort signal. Used by Telegram to enforce a user-facing SLA. */
  signal?: AbortSignal;
  /** Exact device-local eyeVue image bound to this camera-button turn. */
  eyeVueCapturedImagePath?: string;
}

export interface CoachReplyResult {
  reply: string;
  /** Raw reply from the agent before channel-level fallback normalization.
   *  Empty string when the model produced no text (e.g. silent streaming failure).
   *  Use this to detect "no response" without string-matching the fallback message. */
  rawReply: string;
  attachments: ChannelAttachment[];
  /**
   * SDK session ID to be forwarded to the caller for the next turn.
   *
   * Always returned — either a newly created session ID (first turn) or the
   * existing session ID passed in (continuation turns). Callers should store
   * this and send it back on the next message so the coach can skip the
   * `chat_history` DB fetch and resume from the in-process / DB cache.
   */
  sdkSessionId?: string;
}

const FORMAT_HINTS: Record<string, string> = {
  Telegram: "You're responding via Telegram. Match response length to the request: short and direct for simple questions, but complete and thorough for research, analysis, planning, or anything that needs a full answer. Never truncate or redirect the user to the app — deliver the full response here. Plain text, no markdown headers.",
  WhatsApp: "You're responding via WhatsApp. Keep messages SHORT (2-4 sentences). Plain text. WhatsApp supports *bold*, _italic_, `code` only — no markdown headers.",
  Slack: "You're responding via Slack DM. Keep messages SHORT (2-4 sentences). Use Slack mrkdwn (*bold*, _italic_, `code`, > quote). No markdown headers.",
  Daemon: "You're responding to a desktop daemon. Plain text only. The user sees the reply as a desktop notification — keep it under 2 sentences when possible.",
  Discord: "You're responding via Discord. Keep responses SHORT — 2-4 sentences max. Your total response MUST be under 1800 characters. Discord renders **bold**, _italic_, `code`, ```blocks```. No headers. If a task needs many steps, pick the single most important next action and say it clearly.",
  Gateway: "You're responding in the Jarvis Control UI. Be direct, operational, and complete enough for a power user managing agents, devices, jobs, and integrations from the dashboard. Markdown is supported, but avoid large decorative headers.",
  Voice: "You're responding via voice / Talk Mode — your reply will be read aloud on a phone speaker. Plain text only. No markdown, bullet points, or special characters. Keep your answer to 1-3 short, natural spoken sentences. Be direct and conversational.",
};

function getMaxTokensForChannel(channelName: string): number {
  if (channelName.startsWith("Discord")) return 1200;
  if (channelName === "Daemon") return 200;
  if (channelName === "Voice") return 250;
  if (channelName === "Gateway") return 4000;
  if (channelName === "Telegram") return 8000;
  return 2000;
}

function getTelegramE2eProbeId(userText?: string): string | null {
  const match = String(userText ?? "").match(/\bJTE2E_[A-Z0-9_:-]+\b/i);
  return match ? match[0].slice(0, 80) : null;
}

function logTelegramE2eReply(probeId: string | null, reply: string): void {
  if (!probeId) return;
  const compactReply = reply.replace(/\s+/g, " ").trim().slice(0, 1800);
  console.log(`[TelegramE2E] id=${probeId} reply=${JSON.stringify(compactReply)}`);
}

// Channel-agnostic coach pipeline shared by Telegram / WhatsApp / Slack /
// daemon adapters. Returns { reply, attachments } — the caller is
// responsible for delivery and post-send bookkeeping.
export async function persistFastCoachExchange(input: {
  userId: string;
  channelName: string;
  channelLower: string;
  userText: string;
  reply: string;
  coachSessionAgentId: string;
  sdkSessionId?: string;
  persistGlobalHistory?: boolean;
}): Promise<string | undefined> {
  const { userId, channelName, channelLower, userText, reply, coachSessionAgentId, sdkSessionId, persistGlobalHistory = true } = input;
  const userMsg = { id: Date.now().toString(), role: "user", content: userText };
  const assistantMsg = { id: (Date.now() + 1).toString(), role: "assistant", content: reply };

  await logInteraction(userId, channelLower as any, "outbound", reply).catch(() => {});

  if (persistGlobalHistory) {
    try {
      const rows = await db.select().from(schema.chatHistory).where(eq(schema.chatHistory.userId, userId)).limit(1);
      const existing = (rows[0]?.data as Array<{ id?: string; role: string; content: string }> | undefined) || [];
      const updatedChat = [assistantMsg, userMsg, ...existing].slice(0, 100);
      await db.insert(schema.chatHistory)
        .values({ userId, data: updatedChat })
        .onConflictDoUpdate({
          target: schema.chatHistory.userId,
          set: { data: updatedChat, updatedAt: new Date() },
        });
    } catch (err) {
      console.error("[coach] fast-lane chat history persist failed:", err);
    }
  }

  try {
    const { initSession, appendToSession } = await import("../agent/providers/sessionStore");
    const newUserMsg = { role: "user" as const, content: userText };
    const newAssistMsg = { role: "assistant" as const, content: reply };
    if (sdkSessionId) {
      await appendToSession(sdkSessionId, coachSessionAgentId, userId, [newUserMsg, newAssistMsg]);
      return sdkSessionId;
    }
    return await initSession(coachSessionAgentId, userId, [
      {
        role: "system" as const,
        content: `You are Jarvis responding via ${channelName}. This session includes fast-lane turns that must be treated as normal recent conversation.`,
      },
      newUserMsg,
      newAssistMsg,
    ]);
  } catch (err) {
    console.error("[coach] fast-lane session persist failed:", err);
    return sdkSessionId;
  }
}

export async function runCoachAgent(input: CoachReplyInput): Promise<CoachReplyResult> {
  const { userId, userText, channelName, imageUrl, onToken, onProgressMessage, originChannelId, discordGuildId, discordChannelId, signal } = input;
  const destinationScopedConversation = channelName === "Slack" || channelName.startsWith("Discord");
  const coachSessionAgentId = getCoachAgentSessionAgentId(userId);
  const channelLower = channelName.toLowerCase();
  const statusSurface = channelName.startsWith("Discord") ? "discord" : channelLower;
  const telegramE2eProbeId = channelName === "Telegram" ? getTelegramE2eProbeId(userText) : null;
  const telegramE2eLogSuffix = telegramE2eProbeId ? ` e2e=${telegramE2eProbeId}` : "";

  if (input.observeStatusCheck) {
    recordStatusCheckFollowUp({
      userId,
      message: userText,
      surface: statusSurface,
      observationId: input.statusObservationId,
    });
  }

  if (
    channelName === "Telegram" &&
    !imageUrl &&
    !input.extraTools?.length &&
    isFastInteractiveRequest(userText || "")
  ) {
    logInteraction(userId, channelLower as any, "inbound", userText || "[image]").catch(() => {});
    const deterministicReply = getDeterministicFastReply(userText || "");
    if (deterministicReply) {
      console.log(`[Telegram] route=deterministic_fast_reply${telegramE2eLogSuffix}`);
      logTelegramE2eReply(telegramE2eProbeId, deterministicReply);
      const fastSessionId = await persistFastCoachExchange({
        userId,
        channelName,
        channelLower,
        userText,
        reply: deterministicReply,
        coachSessionAgentId,
        sdkSessionId: input.sdkSessionId,
      });
      return {
        reply: deterministicReply,
        rawReply: deterministicReply,
        attachments: [],
        sdkSessionId: fastSessionId,
      };
    }
    try {
      const fastStartedAt = Date.now();
      console.log(`[Telegram] route=fast_orchestrator start${telegramE2eLogSuffix}`);
      const fastResult = await runFastOrchestratorReply({
        userId,
        userRequest: userText,
        channelName,
        signal,
      });
      console.log(`[Telegram] route=fast_orchestrator done durationMs=${Date.now() - fastStartedAt} traceId=${fastResult.traceId}${telegramE2eLogSuffix}`);
      if (!isFastLaneDeflection(fastResult.finalAnswer)) {
        logTelegramE2eReply(telegramE2eProbeId, fastResult.finalAnswer);
        const fastSessionId = await persistFastCoachExchange({
          userId,
          channelName,
          channelLower,
          userText,
          reply: fastResult.finalAnswer,
          coachSessionAgentId,
          sdkSessionId: input.sdkSessionId,
        });
        return {
          reply: fastResult.finalAnswer,
          rawReply: fastResult.finalAnswer,
          attachments: [],
          sdkSessionId: fastSessionId,
        };
      }
      console.log(`[Telegram] route=fast_orchestrator escalated_to_full reason=fast_deflection${telegramE2eLogSuffix}`);
    } catch (fastErr) {
      if (signal?.aborted || (fastErr as Error)?.name === "AbortError") throw fastErr;
      console.warn("[Telegram] orchestrator fast lane failed; falling back to full coach workflow:", fastErr);
    }
  }

  // ── Native session resumption (mirrors runNamedAgent pattern) ────────────────
  // When the caller provides a sdkSessionId, attempt to resume the cached
  // conversation from the server-side session store (in-process cache → DB).
  // On success the chat_history DB fetch is skipped and the cached message list
  // is used directly, saving a DB round-trip and accumulating history beyond
  // the 10-message rolling window that the DB-based path applies.
  let activeSessionId: string | undefined = input.sdkSessionId;
  let sessionResumed = false;
  let cachedSessionMessages: import("openai").default.Chat.Completions.ChatCompletionMessageParam[] = [];

  if (input.sdkSessionId) {
    try {
      const { resumeSession } = await import("../agent/providers/sessionStore");
      const resumed = await resumeSession(input.sdkSessionId, coachSessionAgentId, userId);
      if (resumed) {
        cachedSessionMessages = resumed.messages;
        sessionResumed = true;
        console.log(
          `[coach] session resumed: sdkSessionId=${input.sdkSessionId} messages=${cachedSessionMessages.length}`,
        );
      } else {
        console.warn(
          `[coach] session not found, falling back to full history: sdkSessionId=${input.sdkSessionId}`,
        );
        activeSessionId = undefined;
      }
    } catch (err) {
      console.warn("[coach] session resume error, falling back:", err);
      activeSessionId = undefined;
    }
  }

  let userGoals: any[] = [];
  let userStats: any = {};
  let userLifeContext: any = null;
  let userCommitments: any[] = [];
  let chatMessages: any[] = [];
  let gmailItems: any[] = [];
  let calendarEvents: any[] = [];
  let gmailConnected = false;
  let googleAccessToken: string | null = null;
  let recentlySurfacedItems: any[] = [];

  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const _quickDateStr = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  // Resolve the per-user orchestrator model once, then immediately chain preThink
  // so it fires with the correct model as soon as the DB row lands — still fully
  // parallel with the other DB queries below (zero net latency on the hot path).
  const _orchestratorModelPromise = getModel(userId, "orchestrator");
  const _preThinkPromise = _orchestratorModelPromise.then((m) =>
    preThink(userText || "", channelName + " " + _quickDateStr, m, userId, signal),
  );

  // ── Fire Google token lookup immediately so Gmail/Calendar API calls can
  // start in parallel with the main DB batch instead of waiting for it. ──
  const googleTokensPromise = getValidGoogleTokens(userId);
  // Tentative date key using UTC — close enough for most users to start
  // calendar fetches early; the real dateKey (timezone-adjusted) is
  // computed after prefs resolve and used for everything else.
  const _nowUtc = new Date();
  const tentativeDateKey = `${_nowUtc.getUTCFullYear()}-${String(_nowUtc.getUTCMonth() + 1).padStart(2, "0")}-${String(_nowUtc.getUTCDate()).padStart(2, "0")}`;
  // Non-throwing: any failure in token lookup or API calls degrades Gmail/Calendar
  // context gracefully instead of propagating up and failing the whole coach turn.
  const googleDataPromise = googleTokensPromise.then(async (tokens) => {
    if (!tokens || tokens.length === 0) return null;
    const [emailResult, ...calResults] = await Promise.allSettled([
      getRecentEmailCommitments(14, tokens[0]),
      ...tokens.map((t) => getGoogleCalendarEvents(tentativeDateKey, undefined, undefined, t)),
    ]);
    return { tokens, emailResult, calResults };
  }).catch((err) => {
    console.error("[coach] googleDataPromise error (non-fatal, degraded context):", err);
    return null;
  });

  const [goalsRow, statsRow, lcRow, chatRow, commitmentsRows, prefsRow, recentInteractionsResult, surfacedItemsResult, soulBlockResult, websiteCrawlResult, todayPlanRow, orchestratorModelResult, preThinkResult] = await Promise.allSettled([
    db.select().from(schema.goals).where(eq(schema.goals.userId, userId)).limit(1),
    db.select().from(schema.stats).where(eq(schema.stats.userId, userId)).limit(1),
    db.select().from(schema.lifeContext).where(eq(schema.lifeContext.userId, userId)).limit(1),
    // Skip chat_history fetch when the session cache is warm — the cached
    // message list replaces the rolling 10-message DB window.
    sessionResumed || destinationScopedConversation
      ? Promise.resolve([] as any[])
      : db.select().from(schema.chatHistory).where(eq(schema.chatHistory.userId, userId)).limit(1),
    listPendingPersonalCommitments(userId, 10),
    db.select().from(schema.userPreferences).where(eq(schema.userPreferences.userId, userId)).limit(1),
    getRecentInteractions(userId, 20),
    db.select({
      sourceType: schema.inboxItems.sourceType,
      subject: schema.inboxItems.subject,
      sender: schema.inboxItems.sender,
      snippet: schema.inboxItems.snippet,
      jarvisReason: schema.inboxItems.jarvisReason,
      surfacedAt: schema.inboxItems.surfacedAt,
    })
      .from(schema.inboxItems)
      .where(and(
        eq(schema.inboxItems.userId, userId),
        gte(schema.inboxItems.surfacedAt, twentyFourHoursAgo),
      ))
      .orderBy(desc(schema.inboxItems.surfacedAt))
      .limit(5),
    // Soul and website crawl blocks are independent of DB results — run them
    // concurrently with the rest of the batch instead of serially after it.
    getSoulPromptBlock(userId),
    (async () => {
      try {
        const { getWebsiteCrawlSummaryBlock } = await import("../websiteCrawler");
        return await getWebsiteCrawlSummaryBlock(userId);
      } catch { return ""; }
    })(),
    // todayPlan — fetched with tentative UTC date key so it runs in the
    // parallel batch; reconciled below if the user's timezone-adjusted date
    // differs from the UTC date (rare, only near day boundaries).
    db.select().from(schema.plans)
      .where(and(eq(schema.plans.userId, userId), eq(schema.plans.date, tentativeDateKey)))
      .limit(1),
    // Resolved per-user orchestrator model (already fired above).
    _orchestratorModelPromise,
    // Pre-think fires as soon as the model resolves (already chained above).
    _preThinkPromise,
  ]);

  logInteraction(userId, channelLower as any, "inbound", userText || "[image]").catch(() => {});
  if (userText) {
    processLivingContextUpdate({
      userId,
      text: userText,
      sourceType: "conversation",
      sourceRef: channelName,
    }).catch((err) => console.error(`[LivingContext/${channelName}] update failed:`, err));
  }

  let userTimezone = "America/New_York";
  if (goalsRow.status === "fulfilled") userGoals = (goalsRow.value[0]?.data as any[]) || [];
  if (statsRow.status === "fulfilled") userStats = statsRow.value[0]?.data || {};
  if (lcRow.status === "fulfilled") userLifeContext = lcRow.value[0]?.data || null;
  if (chatRow.status === "fulfilled") chatMessages = (chatRow.value[0]?.data as any[]) || [];
  if (commitmentsRows.status === "fulfilled") userCommitments = commitmentsRows.value;
  if (prefsRow.status === "fulfilled") {
    const prefs = (prefsRow.value[0]?.data as any) || {};
    if (prefs.timezone) userTimezone = prefs.timezone;
  }
  if (surfacedItemsResult.status === "fulfilled") {
    recentlySurfacedItems = surfacedItemsResult.value;
  }

  const orchestratorModel: string =
    orchestratorModelResult.status === "fulfilled"
      ? orchestratorModelResult.value
      : MODEL_DEFAULTS.orchestrator;

  const turnGuidance: string =
    preThinkResult.status === "fulfilled" ? (preThinkResult.value as string) : "";

  // Soul and website crawl blocks were fetched in the parallel batch above.
  const rawSoulBlock = soulBlockResult.status === "fulfilled" ? soulBlockResult.value : "";
  const soulBlock = rawSoulBlock
    ? buildBudgetedContextBlock({
        title: "User context from JARVIS Soul",
        items: [{ text: rawSoulBlock }],
        budget: BUDGET_PRESETS.coachTurn.soul,
      })
    : "";
  let websiteCrawlBlock = websiteCrawlResult.status === "fulfilled" ? websiteCrawlResult.value : "";

  const localForDateKey = new Date(new Date().toLocaleString("en-US", { timeZone: userTimezone }));
  const dateKey = `${localForDateKey.getFullYear()}-${String(localForDateKey.getMonth() + 1).padStart(2, "0")}-${String(localForDateKey.getDate()).padStart(2, "0")}`;

  // todayPlan was fetched in the parallel batch with tentativeDateKey (UTC).
  // Use that result directly in the common case; re-fetch only when the user's
  // real timezone-adjusted date differs (rare — only near UTC day boundaries).
  let todayPlan: any = null;
  if (todayPlanRow.status === "fulfilled") {
    todayPlan = (todayPlanRow.value[0]?.data as any) || null;
  }
  if (dateKey !== tentativeDateKey) {
    try {
      const planRows = await db.select().from(schema.plans)
        .where(and(eq(schema.plans.userId, userId), eq(schema.plans.date, dateKey))).limit(1);
      todayPlan = (planRows[0]?.data as any) || null;
    } catch (err) {
      console.error("[coach] plan re-fetch (timezone reconcile) failed:", err);
    }
  }

  // Join the Google data promise that was fired in parallel with the DB batch.
  const googleRaw = await googleDataPromise;
  if (googleRaw) {
    gmailConnected = true;
    googleAccessToken = googleRaw.tokens[0];
    const { emailResult, calResults } = googleRaw;
    if (emailResult.status === "fulfilled") gmailItems = emailResult.value;
    const seenEventIds = new Set<string>();
    for (const calResult of calResults) {
      if (calResult.status === "fulfilled") {
        for (const ev of calResult.value) {
          if (!seenEventIds.has(ev.id)) {
            seenEventIds.add(ev.id);
            calendarEvents.push(ev);
          }
        }
      }
    }
    // If the user's real date differs from the UTC tentative key used to kick
    // off the early calendar fetch, re-fetch with the correct date so events
    // from the right day are shown (affects users near timezone day boundaries).
    if (dateKey !== tentativeDateKey) {
      try {
        const reCalResults = await Promise.allSettled(
          googleRaw.tokens.map((t) => getGoogleCalendarEvents(dateKey, undefined, undefined, t)),
        );
        calendarEvents = [];
        const seenIds2 = new Set<string>();
        for (const calResult of reCalResults) {
          if (calResult.status === "fulfilled") {
            for (const ev of calResult.value) {
              if (!seenIds2.has(ev.id)) {
                seenIds2.add(ev.id);
                calendarEvents.push(ev);
              }
            }
          }
        }
      } catch (err) {
        console.error("[coach] calendar re-fetch (timezone reconcile) failed:", err);
      }
    }
  }

  // When the session was resumed the cached messages replace the DB window;
  // otherwise fall back to the last 10 messages from the chat_history table.
  const recentMessages = sessionResumed
    ? cachedSessionMessages.filter((m) => m.role !== "system")
    : chatMessages.slice(0, 10).reverse();
  const now = new Date();
  const dayOfWeek = now.toLocaleDateString("en-US", { weekday: "long" });
  const dateStr = now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const goalsText = userGoals.length > 0
    ? userGoals.map((g: any) => `- ${g.title} (${g.category}): ${g.current}/${g.target} ${g.unit}`).join("\n")
    : "No goals set";

  const commitmentsText = userCommitments.length > 0
    ? userCommitments.map((c: any) => `- [id:${c.id}] "${c.content}"${c.dueDate ? ` (due ${c.dueDate})` : ""}`).join("\n")
    : "";

  const calendarText = calendarEvents.length > 0
    ? calendarEvents.slice(0, 8).map((e: any) => `- ${e.time ? e.time + ": " : ""}${e.title}`).join("\n")
    : "";

  const gmailSection = gmailItems.length > 0
    ? `## Recent Emails (last 14 days)\n` +
      truncateToBudget(
        gmailItems.slice(0, 100).map((i: any) => `- [id:${i.id}] From: ${i.from || "unknown"} | "${i.subject}" — ${i.snippet}`).join("\n"),
        BUDGET_PRESETS.coachTurn.gmailSnippets,
      )
    : gmailConnected
      ? `## Recent Emails\nGmail is connected but no emails found.`
      : `## Recent Emails\nGmail not connected.`;

  const recentInteractions = recentInteractionsResult.status === "fulfilled" ? recentInteractionsResult.value : [];
  const crossChannelSection = formatInteractionTimeline(recentInteractions);

  const recentlySurfacedSection = recentlySurfacedItems.length > 0
    ? `## Items You Already Surfaced to the User (last 24h)\nThese were found and sent to the user earlier — you already have this data. Reference it directly when the user asks about it instead of claiming you don't have it or asking them to repeat it.\n` +
      recentlySurfacedItems.map((item: any) => {
        let timestamp = "";
        if (item.surfacedAt) {
          const d = new Date(item.surfacedAt);
          timestamp = d.toLocaleString("en-US", {
            timeZone: userTimezone,
            month: "short", day: "numeric",
            hour: "numeric", minute: "2-digit", hour12: true,
          });
        }
        const parts: string[] = [];
        if (item.subject) parts.push(`Subject: "${item.subject}"`);
        if (item.sender) parts.push(`From: ${item.sender}`);
        if (item.snippet) parts.push(`Content: ${item.snippet}`);
        if (item.jarvisReason) parts.push(`Why surfaced: ${item.jarvisReason}`);
        return `- [${item.sourceType || "item"}${timestamp ? ` @ ${timestamp}` : ""}] ${parts.join(" | ")}`;
      }).join("\n")
    : "";

  const formatHintKey = Object.keys(FORMAT_HINTS).find((k) => channelName.startsWith(k)) ?? "Telegram";
  const formatHint = FORMAT_HINTS[formatHintKey];

  const selfImprovementSection = `\n## Self-Improvement: Building New Jarvis Tools
You can extend yourself by building new tools directly. Generate the complete TypeScript code for the tool yourself and call \`build_feature\` to write it to disk, register it in the tool index, and run a smoke test — all in one step.

**When to build a new tool**: The user asks for a new Jarvis capability that doesn't exist yet (e.g. "add a tool to check stock prices", "build a Notion integration", "add a command to summarize my day").

**How to build**: Think through what the tool needs to do, write the full TypeScript code following the AgentTool pattern, then call \`build_feature\` with feature_name, description, and tool_code (the complete file content). The tool must export a const of type AgentTool.

**After building**: The tool is written to disk and smoke tested automatically. The server restarts automatically so the new tool is active in a few seconds. Report the outcome to the user — success means the tool is now active, failure means the code needs fixing (call \`build_feature\` again with corrected tool_code).

**Manual re-testing**: Use \`test_tool\` to re-run the smoke test on any built tool by name without rebuilding it.

**Build history**: All builds are logged and viewable in Settings → Build History.`;


  const androidActive = isAndroidDaemonActive(userId);
  const desktopActive = isDesktopDaemonActive(userId);
  const daemonPaired = isUserPaired(userId);
  const androidPaired = androidActive || await hasDaemonPairing(userId, "android").catch(() => false);
  const shellAllowed = desktopActive ? await isDaemonActionAllowed(userId, "shell").catch(() => false) : false;
  const daemonLines: string[] = [];
  if (desktopActive) {
    if (shellAllowed) {
      daemonLines.push("- Desktop daemon is ACTIVE with shell execution enabled. Use **daemon_shell** to run scripts, build apps, run tests, execute local automation, or do any computation on the user's machine. Prefer daemon_shell over daemon_action for shell commands — it surfaces stdout, stderr, and exit code cleanly. Use daemon_action for file reads, desktop notifications, and screenshots.");
    } else {
      daemonLines.push("- Desktop daemon is ACTIVE. You can send desktop notifications, read/write files in the workspace, and take screenshots. Shell execution is disabled — the user can enable it in Profile → Connected Channels → Desktop Daemon → Permissions.");
    }
  }
  if (androidActive) daemonLines.push("- Android device daemon is ACTIVE. You can open apps (android_open_app), take screenshots (android_screenshot), read the screen (android_read_screen), browse URLs (android_browse), list/read files on the device (android_file_list/android_file_read). Tap/type/swipe actions are available when user enables them. Proactively mention Android capabilities when relevant.");
  else if (androidPaired) daemonLines.push("- Android Device Control is paired but currently offline. Preserve phone operations and call the matching Android tool for a real preflight attempt. Report an offline preflight as a Device Control blocker; never claim no device-action tool exists.");
  const daemonSection = daemonPaired || androidPaired
    ? `## Connected Devices\n${daemonLines.join("\n")}${shellAllowed ? "\n\n**daemon_shell usage**: Call daemon_shell proactively when the user asks to run a script, build an app, run tests, read a local log, execute a cron job, or do any local computation. Don't describe what you'd do — just run the command and show the result." : ""}`
  : "## Android Device Setup Guidance (no daemon paired)\nIf the user asks how to set up Android device control, guide them through the unified Jarvis app:\n1. Install/open the Jarvis Android app and go to Profile → Connected Channels → Android Device.\n2. Tap Enable Device Control. The app uses the configured server URL and signed-in session automatically.\n3. Grant Android permissions from that screen as needed: Accessibility Service, notification access, all files access, camera, and screen recording. Microphone is only needed when a voice session is open.\n4. For hands-free launch, set Jarvis as the Android assistant from Settings. The software wake-word listener stays off unless a fallback is explicitly enabled later.";

  const systemPrompt = `You are Jarvis — a sharp, supportive AI operating partner. ${formatHint}

Today is ${dayOfWeek}, ${dateStr}. User's timezone: ${userTimezone}.
${crossChannelSection}

${soulBlock}${websiteCrawlBlock}

## User Profile
- Streak: ${userStats.streak || 0} days
- Total completed: ${userStats.totalCompleted || 0}
- XP: ${userStats.xp || 0}

## Active Goals
${goalsText}
${commitmentsText ? `\n## Open Commitments\n${commitmentsText}` : ""}
${calendarText ? `\n## Today's Calendar\n${calendarText}` : ""}

${gmailSection}
${recentlySurfacedSection ? `\n${recentlySurfacedSection}` : ""}
${userLifeContext?.priorityGoal ? `\n## Context\n- Priority: ${userLifeContext.priorityGoal}` : ""}
${daemonSection ? `\n${daemonSection}` : ""}

You can manage tasks, commitments, and analyze patterns via the manage_tasks tool. You can act on emails via the gmail_action tool. You can run safe shell commands, send desktop notifications, or read/write files in the user's workspace via the daemon_action tool when a desktop daemon is paired. When an Android device daemon is paired, use android_* actions to control the phone — open apps, browse, screenshot, read the screen, and access files. Always confirm with the user before tap/type/swipe actions. Use these proactively when the user asks to do something — don't just describe what you'd do. Respond in the same language the user writes in.

## Media generation
- **image_generate** — generate an image and deliver it inline. Use model "dalle" (default, fast) for illustrations and concept art. Use model "flux" when the user asks for photorealistic, high-quality, or artistic images (FLUX requires INFSH_API_KEY).
- **generate_video** — generate a short AI video (2-6 min generation time; warn the user). Use for animated scenes, cinematic clips, or any explicit video request. Requires INFSH_API_KEY. Always tell the user it will take a few minutes before calling the tool.
- Never generate media unless the user explicitly requests it or a visual would meaningfully enhance the response.${selfImprovementSection}

## Self-Inspection & Code Proposals
You have three self-edit tools — list_source_files, read_source_file, and propose_code_change. Use them when: (a) the user asks you to "look at your own code", "inspect yourself", "improve your tools", or "fix a bug you noticed"; OR (b) you encounter a repeated failure and believe you can fix it with a targeted code change. For roadmap or completeness assessments, first read JARVIS_ROADMAP.md, ROADMAP.md, and docs/capability-verification-matrix.md. Label conclusions as Verified, Inferred, or Unverified; never invent completion percentages, and distinguish intentional policy (including disabled autonomous builds) from missing implementation. Workflow: (1) call list_source_files to find the relevant file, (2) call read_source_file to read it fully, (3) call propose_code_change with the complete improved file content and a plain-English reason. The proposal is saved for user review — you NEVER write files directly. Keep proposals minimal and targeted: fix one specific issue per proposal. After proposing, tell the user a suggestion is waiting in the Code Proposals screen for their review.

## Autonomous background jobs
When a user's request involves multi-step research, drafting a document or plan, or composing an email — anything that would take more than a quick lookup — call the queue_background_job tool immediately instead of answering inline. This queues the work for a background sub-agent and lets you reply instantly. After calling the tool, tell the user: "I've queued that — you'll get a notification when it's done." Do not attempt to do the research or drafting yourself in the same turn. Examples of requests that MUST use queue_background_job:
- "research my competitors", "find me market data on X", "look into Y"
- "write a memo/proposal/blog post about X", "draft a document for Y"
- "make a plan for Z", "break down this project", "create an action plan"
- "write an email to X", "draft a message to Y", "compose an outreach to Z"

**Domain context in job descriptions**: When you formulate a background job prompt from a follow-up message, carry the full conversation domain into the prompt — not just the literal words of the latest message. The sub-agent has no access to conversation history. Example: if the conversation is about finding pets to adopt and the user says "find shelters in that area", the job prompt must say "find animal shelters in [city] — this is part of a search to adopt a cat" so the sub-agent returns the right kind of results. Always ask yourself: what is this conversation actually about? Include that topic explicitly in every job description.

**Capability note**: When a user asks you to research something, do NOT say "I can't browse websites" — that is misleading. You CAN search the web by queuing a research background job. Always tell the user: "I'll queue a research job that searches the web and delivers findings to your inbox."

**Strictly prohibited**: Never attempt to write research, competitive analysis, or fact-finding content inline. Even if you think you know the answer, you MUST queue a research background job for any request containing words like "research", "look into", "find out about", "what is X", "how does X work", or requests for facts about external products/people/companies. The research sub-agent uses real web search — you do not.

**EXCEPTION — YouTube transcript already in context**: If the user's message contains a YouTube link and the transcript appears above (marked "TRANSCRIPT AUTO-FETCHED"), the transcript is already available. Reply inline immediately with a full summary or answer. Do NOT call queue_background_job for YouTube video summaries when the transcript is already present in this message.

## Critical rules — no empty promises
**Act, don't announce**: If you say you will do something (create a document, save data, log an entry, send a message, post to a channel), you MUST call the relevant tool in that same response. Never say you will do something and then fail to do it. There is no "I'll do that now" without an immediate tool call.

**Discord channel creation and cross-channel posting are exceptions to 'Act, don't announce'**: For discord_create_channel and discord_post, you MUST use the following two-turn flow:
1. Call discord_request_confirm (with the appropriate action and question) — this registers a server-side token and returns the question to relay to the user.
2. Send the returned question to the user and wait for an explicit 'yes', 'confirm', 'go ahead', or equivalent.
3. Only then call discord_create_channel or discord_post in the next turn.
If you skip step 1 (calling discord_request_confirm), the action tool will be rejected even if the user said 'yes'. 'A', 'B', or a choice between options does NOT count as confirmation. If the user takes longer than 5 minutes to reply, call discord_request_confirm again before proceeding.

**If you can't act yet**: If you are genuinely missing required data to take the action, say exactly what one piece of information is missing and ask for only that. Do not say "I'll do it" and then ask five clarifying questions. One missing piece = one question, then act.

**No circular clarification**: Do not ask for data you already have. Before asking the user for an amount, date, vendor, or reference — check the "Items You Already Surfaced" section of your context. If the data is there, use it directly without asking.

**Fail explicitly**: If a tool call returns an error or fails, tell the user specifically what went wrong. Do not silently continue or pretend the action succeeded.`;

  const youtubeCtx = await buildYouTubeContextBlock(userText || "").catch(() => "");
  const enrichedUserText = userText + youtubeCtx;

  // When a transcript was auto-fetched, append a hard constraint to the system
  // context so the orchestrator's decompose/execute/synthesize steps all see it.
  const youtubeInlineConstraint = youtubeCtx
    ? "\n\n## MANDATORY: YouTube transcript inline reply\nA YouTube transcript has been pre-loaded in this request (marked TRANSCRIPT AUTO-FETCHED). You MUST summarise or answer the question inline in this single reply. NEVER call queue_background_job for this request."
    : "";
  const turnStrategyBlock = turnGuidance
    ? `\n\n## Turn Strategy\n${turnGuidance}`
    : "";
  const resolvedPhoneRuntimeRequestText = resolvePhoneRuntimeRequestText([
    ...(sessionResumed ? cachedSessionMessages : [...chatMessages].reverse()),
    { role: "user", content: userText || "" },
  ]);
  const currentMessageRoute = classifyToolAwareRoute(userText || "");
  let activePhoneRuntimeOperation = currentMessageRoute.actionType === "jarvis_device_action" ||
    isConcretePhoneRuntimeCommand(userText || "")
    ? null
    : await findReferencedPhoneRuntimeOperation({
        userId,
        text: userText || "",
      }).catch((error) => {
        console.error(`[${channelName}] phone-operation reference lookup failed:`, error);
        return null;
      });
  const phoneRuntimeRequestText = activePhoneRuntimeOperation?.goal ?? resolvedPhoneRuntimeRequestText;
  const classifiedToolAwareRoute = classifyToolAwareRoute(phoneRuntimeRequestText);
  if (!activePhoneRuntimeOperation && classifiedToolAwareRoute.actionType === "jarvis_device_action") {
    activePhoneRuntimeOperation = await ensurePhoneRuntimeOperation({
      userId,
      goal: phoneRuntimeRequestText,
      sessionId: activeSessionId,
      originChannel: channelName,
    }).catch((error) => {
      console.error(`[${channelName}] phone-operation create failed:`, error);
      return null;
    });
  }
  const phoneRuntimeOperationContext = formatPhoneRuntimeOperationContext(activePhoneRuntimeOperation);
  const phoneRuntimeUnavailable =
    classifiedToolAwareRoute.actionType === "jarvis_device_action" && !androidPaired;
  const toolAwareRoute = phoneRuntimeUnavailable
    ? {
        ...classifiedToolAwareRoute,
        capabilityIds: [],
        toolGroups: [],
        priorityToolNames: [],
        blockedToolNames: [],
        shouldPreferTool: false,
        approvalRequired: false,
      }
    : classifiedToolAwareRoute;
  const toolAwareBlock = phoneRuntimeUnavailable
    ? "\n\n## Phone Runtime Unavailable\nThe Android daemon is not active. Do not request a phone tool or approval. Explain that the user must open Jarvis and connect Android Device Control before retrying."
    : toolAwareRoute.shouldPreferTool
      ? `\n\n## Tool-Aware Routing\n${toolAwareRoute.guidance}\nDo not give a capability disclaimer until you have tried the matching tool path or confirmed the required integration is not connected.`
      : "";
  const effectiveSystemPromptBase = systemPrompt + youtubeInlineConstraint + turnStrategyBlock + toolAwareBlock +
    (phoneRuntimeOperationContext ? `\n\n${phoneRuntimeOperationContext}` : "");

  // ── Context registry: inject registered provider context ────────────────────
  // Derive a normalised platform string for providers that need it.
  const registryPlatform = channelName.toLowerCase().startsWith("discord")
    ? "discord"
    : channelName.toLowerCase();
  const registryCtx = await contextRegistry.build({
    userId,
    platform: registryPlatform,
    channelId: discordChannelId || undefined,
    userMessage: enrichedUserText,
  }).catch(() => ({ systemContext: "", prependContext: "", appendContext: "" }));
  const effectiveSystemPrompt = registryCtx.systemContext
    ? `${effectiveSystemPromptBase}\n\n${registryCtx.systemContext}`
    : effectiveSystemPromptBase;

  const userMessageContent = imageUrl
    ? [
        { type: "text" as const, text: enrichedUserText || "What do you see in this image?" },
        { type: "image_url" as const, image_url: { url: imageUrl } },
      ]
    : enrichedUserText;

  // Build the message list for the harness / fallback path.
  // On session resumption the cached messages already carry proper OpenAI
  // types (including tool_call turns); the fresh system prompt replaces the
  // stale one so real-time context (calendar, Gmail, …) stays current.
  const baseMessages: import("openai").default.Chat.Completions.ChatCompletionMessageParam[] = sessionResumed
    ? [
        { role: "system" as const, content: effectiveSystemPrompt },
        ...recentMessages as import("openai").default.Chat.Completions.ChatCompletionMessageParam[],
        { role: "user" as const, content: userMessageContent },
      ]
    : [
        { role: "system" as const, content: effectiveSystemPrompt },
        ...recentMessages.map((m: { role: string; content: string }) => ({
          role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
          content: m.content,
        })),
        { role: "user" as const, content: userMessageContent },
      ];

  const agentCtx: import("../agent/types").ToolContext = {
    userId,
    channel: channelName,
    originChannelId: originChannelId ?? discordChannelId,
    googleAccessToken: googleAccessToken || undefined,
    discordGuildId: discordGuildId || undefined,
    discordChannelId: discordChannelId || undefined,
    signal,
    state: {
      dateKey,
      todayPlan,
      gmailMessageIds: gmailItems.map((i: { id?: string }) => i.id).filter((id): id is string => !!id),
      pendingAttachments: [],
      ...(input.eyeVueCapturedImagePath ? { eyeVueCapturedImagePath: input.eyeVueCapturedImagePath } : {}),
      // Forward MCP progress notifications as streaming tokens so channels show live progress
      onProgress: onToken ? (msg: string) => onToken(`[progress] ${msg}`) : undefined,
      // Heartbeat-style status edits (edit the placeholder; does not pollute stream buffer)
      onProgressMessage,
    },
  };

  // ── Resolve scoped tool list for this channel (caller-side pre-filter) ───────
  // parseChannelKey normalises display names like "Discord #research" → "discord"
  // without any `as any` cast.  resolveChannelTools uses the channel's declared
  // toolGroups to build the pre-filtered list that is passed to runAgent.
  // The harness applies the same filter again as the authoritative safety gate,
  // so the two reinforce each other without either being solely relied upon.
  let scopedTools = await resolveChannelTools(channelName, !!googleAccessToken);
  if (input.extraTools && input.extraTools.length > 0) {
    const extraNames = new Set(input.extraTools.map(t => t.name));
    scopedTools = [...scopedTools.filter(t => !extraNames.has(t.name)), ...input.extraTools];
  }
  if (toolAwareRoute.toolGroups.length > 0) {
    const existingNames = new Set(scopedTools.map((tool) => tool.name));
    const boostedTools = filterToolsByGroups(toolAwareRoute.toolGroups as ToolGroup[], !!googleAccessToken)
      .filter((tool) => !existingNames.has(tool.name));
    if (boostedTools.length > 0) {
      scopedTools = [...scopedTools, ...boostedTools];
      console.log(`[${channelName}] tool-aware boost: +${boostedTools.length} tools for ${toolAwareRoute.intents.join(", ")}`);
    }
  }
  if (phoneRuntimeUnavailable) {
    const phoneRuntimeToolNames = new Set<string>(ANDROID_PHONE_RUNTIME_TOOL_NAMES);
    scopedTools = scopedTools.filter((tool) => !phoneRuntimeToolNames.has(tool.name));
  }
  scopedTools = wrapPhoneRuntimeOperationTools(scopedTools, activePhoneRuntimeOperation?.id);
  const canonicalKey = parseChannelKey(channelName);
  const registeredChannel = canonicalKey ? getChannel(canonicalKey) : undefined;
  console.log(
    `[${channelName}] tool scope: ${scopedTools.length} tools` +
    (registeredChannel ? ` (groups: ${registeredChannel.toolGroups.join(", ")})` : " (fallback groups)"),
  );
  const coachApprovalOnBeforeTool = createSystemApprovalOnBeforeTool({
    agentId: getCoachAppAgentId(userId),
    agentName: "Jarvis App Coach",
    userId,
    platform: channelName,
    channelId: originChannelId ?? discordChannelId,
    initiatedBy: "user",
    signal: agentCtx.signal,
  });

  // ── Activation planner — run before the model session ─────────────────────
  // Channel sessions always run (shouldRun is always true for explicit user
  // messages), but the planner injects session context (focus areas, urgent
  // signals, energy state, top predictions) into the system prompt so the
  // model is primed with what to focus on this turn.
  //
  // upcomingMeetingMinutes: compute from the already-fetched calendarEvents.
  // We look for the nearest event starting within the next 60 minutes so the
  // planner can activate calendar + email tools before the meeting starts.
  let upcomingMeetingMinutes: number | undefined;
  if (calendarEvents.length > 0) {
    const nowMs = Date.now();
    let minMinutes = Infinity;
    for (const ev of calendarEvents) {
      try {
        const startMs = new Date(ev.start).getTime();
        const diffMinutes = (startMs - nowMs) / 60000;
        if (diffMinutes >= 0 && diffMinutes < 60 && diffMinutes < minMinutes) {
          minMinutes = diffMinutes;
        }
      } catch {
        // non-fatal — skip malformed event
      }
    }
    if (minMinutes < Infinity) {
      upcomingMeetingMinutes = Math.round(minMinutes);
    }
  }

  let channelActivationPlan: import("../agent/activationPlanner").ActivationPlan | undefined;
  try {
    channelActivationPlan = await activationPlanner.plan(userId, {
      source: "channel",
      channel: channelName,
      queryText: phoneRuntimeUnavailable ? undefined : userText,
      upcomingMeetingMinutes,
    });
    console.log(`[${channelName}] activation: shouldRun=${channelActivationPlan.shouldRun} — ${channelActivationPlan.reason}`);
  } catch (err) {
    // Best-effort — never block a channel session
    console.warn(`[${channelName}] activation planner failed (non-fatal):`, err);
  }

  // ── Build-intent short-circuit ────────────────────────────────────────────
  // Detect "build a tool / add a feature / write a script" requests and route
  // directly to the build_feature background job — same pattern as research.
  // This bypasses the orchestrator entirely and returns an immediate ack so
  // the user knows the build is queued.  Duplicate detection is handled inside
  // submitAgentJob so the same request cannot spawn multiple parallel jobs.
  if (userText && !classifyStandaloneAppProjectIntent(userText) && (classifyBuildIntent(userText) || classifyBuildFollowUp(userText, chatMessages))) {
    try {
      const buildResult = await routeBuildIntent({
        userId,
        userText,
        channelName,
        chatMessages,
        originChannelId: originChannelId ?? discordChannelId,
        discordChannelId,
      });
      if (buildResult.handled && buildResult.reply) {
        const ackReply = buildResult.reply;
        const ackTs = Date.now();
        // Minimal chat-history save so the next turn has context.
        const userMsgEntry = { id: ackTs.toString(), role: "user", content: userText };
        const asstMsgEntry = { id: (ackTs + 1).toString(), role: "assistant", content: ackReply };
        const updatedChatBuild = [asstMsgEntry, userMsgEntry, ...chatMessages].slice(0, 100);
        if (!destinationScopedConversation) {
          db.insert(schema.chatHistory)
            .values({ userId, data: updatedChatBuild })
            .onConflictDoUpdate({
              target: schema.chatHistory.userId,
              set: { data: updatedChatBuild, updatedAt: new Date() },
            })
            .catch((err: unknown) => console.error("[coach] build-intent chat history persist failed:", err));
        }
        // Persist the ack to build_sessions so the suspended-build reminder can
        // fire even after the ack message has scrolled out of the 20-msg window.
        const persistedJobId = buildResult.jobId ?? buildResult.duplicateJobId ?? null;
        db.insert(schema.buildSessions)
          .values({
            userId,
            jobId: persistedJobId,
            ackTimestamp: ackTs,
            buildDescription: userText.slice(0, 500),
            reminded: false,
          })
          .catch((err: unknown) => console.error("[coach] build-session persist failed:", err));
        const buildSessionId = destinationScopedConversation
          ? await persistFastCoachExchange({
              userId, channelName, channelLower, userText, reply: ackReply,
              coachSessionAgentId, sdkSessionId: activeSessionId, persistGlobalHistory: false,
            })
          : activeSessionId;
        if (!destinationScopedConversation) logInteraction(userId, channelLower as any, "outbound", ackReply).catch(() => {});
        return { reply: ackReply, rawReply: ackReply, attachments: [], sdkSessionId: buildSessionId };
      }
    } catch (buildErr) {
      console.error(`[${channelName}] build intent job submission failed (falling through to orchestrator):`, buildErr);
      // Fall through to normal orchestrator path on submission error.
    }
  }

  // ── Build-session resume signal ───────────────────────────────────────────
  // Detect phrases like "back to the build", "let's resume", "continue where we
  // left off" that signal the user wants to re-enter build mode after Jarvis
  // stepped away to handle an unrelated request.
  //
  // Strategy: reply with a short acknowledgement that embeds BUILD_ACK_MARKER
  // so that the NEXT user message (e.g. "now add retry logic") is correctly
  // routed to the build_feature job by classifyBuildFollowUp.
  if (userText && classifyBuildResume(userText, chatMessages)) {
    const buildDesc = findBuildDescription(chatMessages);
    const RESUME_PHRASES = [
      `Back to it — I've already ${BUILD_ACK_MARKER} for that. We were working on: "${buildDesc}". What would you like to change or add?`,
      `Picking up where we left off — I've ${BUILD_ACK_MARKER} for that already. The build was: "${buildDesc}". Ready when you are.`,
      `Resuming — I've ${BUILD_ACK_MARKER} for "${buildDesc}". What's next?`,
    ];
    const resumeReply = RESUME_PHRASES[Math.floor(Math.random() * RESUME_PHRASES.length)];
    // Persist to chat history (same minimal pattern as build-intent short-circuit)
    const userMsgEntry  = { id: Date.now().toString(),       role: "user",      content: userText    };
    const asstMsgEntry  = { id: (Date.now() + 1).toString(), role: "assistant", content: resumeReply };
    const updatedChatResume = [asstMsgEntry, userMsgEntry, ...chatMessages].slice(0, 100);
    if (!destinationScopedConversation) {
      db.insert(schema.chatHistory)
        .values({ userId, data: updatedChatResume })
        .onConflictDoUpdate({
          target: schema.chatHistory.userId,
          set: { data: updatedChatResume, updatedAt: new Date() },
        })
        .catch((err: unknown) => console.error("[coach] build-resume chat history persist failed:", err));
    }
    const resumeSessionId = destinationScopedConversation
      ? await persistFastCoachExchange({
          userId, channelName, channelLower, userText, reply: resumeReply,
          coachSessionAgentId, sdkSessionId: activeSessionId, persistGlobalHistory: false,
        })
      : activeSessionId;
    if (!destinationScopedConversation) logInteraction(userId, channelLower as any, "outbound", resumeReply).catch(() => {});
    console.log(`[${channelName}] build-session resume detected — sending ack with BUILD_ACK_MARKER`);
    return { reply: resumeReply, rawReply: resumeReply, attachments: [], sdkSessionId: resumeSessionId };
  }

  // ── Autonomy-policy short-circuit ─────────────────────────────────────────
  // Before falling through to the model orchestrator, give the deterministic OS
  // policy first refusal on obvious autonomous work. This prevents the live
  // coach from answering "I can't do that" when the correct behavior is to
  // queue a background deliverable or pause for approval.
  if (userText) {
    try {
      const autonomyResult = await routeAutonomyRequest({
        userId,
        userText,
        backgroundPrompt: buildBackgroundJobPrompt(recentMessages, userText),
        channelName,
        originChannelId: originChannelId ?? discordChannelId,
      });

      if (autonomyResult.handled && autonomyResult.reply) {
        const autonomyReply = autonomyResult.reply;
        const autonomyTs = Date.now();
        const userMsgEntry = { id: autonomyTs.toString(), role: "user", content: userText };
        const asstMsgEntry = { id: (autonomyTs + 1).toString(), role: "assistant", content: autonomyReply };
        const updatedChatAutonomy = [asstMsgEntry, userMsgEntry, ...chatMessages].slice(0, 100);
        if (!destinationScopedConversation) {
          db.insert(schema.chatHistory)
            .values({ userId, data: updatedChatAutonomy })
            .onConflictDoUpdate({
              target: schema.chatHistory.userId,
              set: { data: updatedChatAutonomy, updatedAt: new Date() },
            })
            .catch((err: unknown) => console.error("[coach] autonomy-policy chat history persist failed:", err));
        }
        const autonomySessionId = destinationScopedConversation
          ? await persistFastCoachExchange({
              userId, channelName, channelLower, userText, reply: autonomyReply,
              coachSessionAgentId, sdkSessionId: activeSessionId, persistGlobalHistory: false,
            })
          : activeSessionId;
        if (!destinationScopedConversation) logInteraction(userId, channelLower as any, "outbound", autonomyReply).catch(() => {});
        console.log(
          `[${channelName}] autonomy-policy handled mode=${autonomyResult.decision.mode}` +
          (autonomyResult.jobId ? ` job=${autonomyResult.jobId}` : ""),
        );
        return { reply: autonomyReply, rawReply: autonomyReply, attachments: [], sdkSessionId: autonomySessionId };
      }
    } catch (autonomyErr) {
      console.error(`[${channelName}] autonomy-policy handling failed (falling through to orchestrator):`, autonomyErr);
    }
  }

  // ── Build-session context-switch detection ────────────────────────────────
  // When the user was mid-build but just sent an unrelated request, flag this
  // so we can prepend a brief soft transition note to the orchestrator reply.
  const switchingFromBuild =
    !!userText &&
    isUnrelatedIntent(userText) &&
    hasActiveBuildSession(chatMessages);

  // ── Orchestrator ──────────────────────────────────────────────────────────
  // Always route through the orchestrator — it is the foundational execution
  // architecture. Falls back to direct harness on any orchestrator error.
  let rawReply: string;
  const orchestratorStartedAt = Date.now();
  console.log(`[${channelName}] route=full_orchestrator start tools=${scopedTools.length}${telegramE2eLogSuffix}`);
  try {
    const orchResult = await runOrchestrator({
      userId,
      userRequest: enrichedUserText,
      systemContext: effectiveSystemPrompt,
      tools: scopedTools,
      toolContext: agentCtx,
      maxCompletionTokens: getMaxTokensForChannel(channelName),
      onProgressMessage,
      signal,
    });
    rawReply = orchResult.finalAnswer;
    console.log(
      `[${channelName}] route=full_orchestrator done durationMs=${Date.now() - orchestratorStartedAt} tasks=${orchResult.subtaskCount}, retries=${orchResult.retryCount}, traceId=${orchResult.traceId}${telegramE2eLogSuffix}`,
    );
  } catch (orchErr) {
    if (signal?.aborted || (orchErr as Error)?.name === "AbortError") throw orchErr;
    console.error(`[${channelName}] route=full_orchestrator failed durationMs=${Date.now() - orchestratorStartedAt}; falling back to direct harness:`, orchErr);
    const fallbackStartedAt = Date.now();
    const fallback = await runAgent({
      model: orchestratorModel,
      messages: baseMessages,
      tools: scopedTools,
      context: agentCtx,
      maxTurns: 6,
      maxCompletionTokens: getMaxTokensForChannel(channelName),
      onToken,
      onProgressMessage,
      activationPlan: channelActivationPlan,
      onBeforeTool: coachApprovalOnBeforeTool,
      signal,
    });
    rawReply = fallback.reply;
    console.log(`[${channelName}] route=direct_harness_fallback done durationMs=${Date.now() - fallbackStartedAt}`);
  }

  // ── Post-check quality gate ────────────────────────────────────────────────
  // Ask the orchestrator model whether the reply adequately addressed the user's
  // request.  On failure, fire a single corrective harness retry with the
  // failure reason injected.  Errors/timeouts are fail-open (never block reply).
  let postCheckPassed = true;
  let retried = false;
  if (rawReply) {
    const checkUserText = userText || "[image-only message]";
    try {
      const checkResult = await postCheck(checkUserText, rawReply, orchestratorModel, userId, signal);
      postCheckPassed = checkResult.passed;
      if (!checkResult.passed) {
        const correctionFeedback = checkResult.feedback ||
          "Answer did not fully address the request; provide a complete direct response.";
        const correctionPrompt =
          effectiveSystemPrompt +
          `\n\n## Quality correction: ${correctionFeedback}`;
        const correctionMessages: import("openai").default.Chat.Completions.ChatCompletionMessageParam[] = [
          { role: "system" as const, content: correctionPrompt },
          ...baseMessages.slice(1),
        ];
        retried = true;
        try {
          const correction = await runAgent({
            model: orchestratorModel,
            messages: correctionMessages,
            tools: scopedTools,
            context: agentCtx,
            maxTurns: 4,
            maxCompletionTokens: getMaxTokensForChannel(channelName),
            activationPlan: channelActivationPlan,
            onBeforeTool: coachApprovalOnBeforeTool,
            signal,
          });
          if (correction.reply) {
            rawReply = correction.reply;
          }
        } catch (retryErr) {
          console.warn(`[${channelName}] quality correction retry failed (non-blocking):`, retryErr);
        }
      }
    } catch (checkErr) {
      console.warn(`[${channelName}] post-check failed (non-blocking):`, checkErr);
    }
  }

  console.log(
    `[qualityLoop] guidance="${turnGuidance.slice(0, 80)}" postCheck=${postCheckPassed ? "passed" : "failed"} retried=${retried}`,
  );

  // ── Build-session transition note ─────────────────────────────────────────
  // When the user was mid-build and just sent an unrelated request (e.g. "check
  // my email"), prepend a brief soft note so they know Jarvis has stepped out
  // of build mode. Applied after the quality gate so the post-check evaluates
  // the substantive reply without the prefix influencing the quality score.
  if (switchingFromBuild && rawReply) {
    const TRANSITION_PHRASES = [
      "Switching gears — ",
      "Sure, setting the build aside for now — ",
      "On it — stepping away from the build — ",
    ];
    const phrase = TRANSITION_PHRASES[Math.floor(Math.random() * TRANSITION_PHRASES.length)];
    rawReply = phrase + rawReply;
    console.log(`[${channelName}] build-session context-switch detected — transition note prepended`);
  }

  // ── Suspended-build reminder ───────────────────────────────────────────────
  // When the user returns after a long absence (≥ 2 hours) and there is a build
  // ack in history with no reminder yet delivered, append a single soft note so
  // the user knows there is still a build waiting for them.
  //
  // Conditions:
  //   1. The orchestrator handled this turn (not a build short-circuit).
  //   2. We are not already appending a context-switch note (avoid double prefix).
  //   3. A BUILD_ACK_MARKER exists in chatMessages.
  //   4. That ack is at least SUSPENDED_BUILD_REMINDER_THRESHOLD_MS old.
  //   5. The user has not already received a reminder for this ack session AND
  //      has not sent any build-refinement messages after the ack.
  const SUSPENDED_BUILD_REMINDER_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
  if (rawReply && !switchingFromBuild) {
    try {
      // Fetch the most-recent non-reminded build session from the DB so we can
      // surface reminders even when the original ack has scrolled past the
      // 20-message rolling chat window.
      let storedSession: StoredBuildSession | null = null;
      let storedSessionId: string | null = null;
      try {
        const rows = await db
          .select()
          .from(schema.buildSessions)
          .where(eq(schema.buildSessions.userId, userId))
          .orderBy(desc(schema.buildSessions.createdAt))
          .limit(1);
        if (rows.length > 0) {
          const row = rows[0];
          storedSessionId = row.id;
          storedSession = {
            ackTimestamp: Number(row.ackTimestamp),
            reminded: row.reminded,
            buildDescription: row.buildDescription,
          };
        }
      } catch (dbErr) {
        console.warn(`[${channelName}] build_sessions lookup failed (non-blocking):`, dbErr);
      }

      const { ackAgeMs, shouldSuppress, buildDescription } = findSuspendedBuild(chatMessages, storedSession);
      if (
        ackAgeMs !== null &&
        ackAgeMs >= SUSPENDED_BUILD_REMINDER_THRESHOLD_MS &&
        !shouldSuppress
      ) {
        const REMINDER_PHRASES = [
          `\n\nBy the way — we ${SUSPENDED_BUILD_REMINDED_MARKER} for "${buildDescription}". Want to continue where you left off?`,
          `\n\nJust a heads-up: we ${SUSPENDED_BUILD_REMINDED_MARKER} for "${buildDescription}". Let me know whenever you're ready to pick it back up.`,
          `\n\nReminder: we ${SUSPENDED_BUILD_REMINDED_MARKER} for "${buildDescription}". Say the word and we'll dive back in.`,
        ];
        rawReply = rawReply + REMINDER_PHRASES[Math.floor(Math.random() * REMINDER_PHRASES.length)];
        console.log(
          `[${channelName}] suspended-build reminder appended (ackAge=${Math.round(ackAgeMs / 3_600_000)}h, build="${buildDescription.slice(0, 60)}")`,
        );
        // Mark only the specific session row as reminded so the once-only guarantee
        // holds per-session — using the row id avoids over-suppressing other queued
        // builds the user may have.
        if (storedSessionId) {
          db.update(schema.buildSessions)
            .set({ reminded: true })
            .where(eq(schema.buildSessions.id, storedSessionId))
            .catch((err: unknown) => console.error("[coach] build-session remind flag update failed:", err));
        }
      }
    } catch (reminderErr) {
      console.warn(`[${channelName}] suspended-build reminder check failed (non-blocking):`, reminderErr);
    }
  }

  const reply = rawReply || "Sorry, I couldn't generate a response right now.";
  logTelegramE2eReply(telegramE2eProbeId, reply);
  const attachments = (agentCtx.state.pendingAttachments || []) as ChannelAttachment[];

  // ── Query Filing — optionally save substantive synthesis answers to the wiki ─
  // Fire-and-forget. Only runs when reply is substantial (100+ chars).
  if (rawReply && rawReply.length >= 100 && userText && userText.length >= 10) {
    import("../memory/vaultWriter").then(({ fileQuery }) => {
      fileQuery(userId, userText, rawReply).catch((err) =>
        console.error("[coach] fileQuery failed:", err),
      );
    }).catch(() => {});
  }

  // ── Session management — update or initialise after successful run ────────────
  // Mirror the runNamedAgent pattern:
  //   • First turn (no sdkSessionId or expired fallback): init a new session
  //     from the complete message list so the next turn can resume cheaply.
  //   • Continuation turns (sessionResumed): append only the new exchange
  //     (user message + assistant reply) to keep the session up-to-date.
  const newUserMsg  = { role: "user"      as const, content: userText };
  const newAssistMsg = { role: "assistant" as const, content: reply   };

  let finalSessionId: string | undefined = activeSessionId;
  try {
    const { initSession, appendToSession } = await import("../agent/providers/sessionStore");
    if (sessionResumed && activeSessionId) {
      appendToSession(activeSessionId, coachSessionAgentId, userId, [newUserMsg, newAssistMsg]).catch(() => {});
    } else {
      // Build the full message list for the new session:
      // system prompt + prior history (from DB or empty) + new exchange.
      const priorHistory: import("openai").default.Chat.Completions.ChatCompletionMessageParam[] = chatMessages
        .slice(0, 10)
        .reverse()
        .map((m: { role: string; content: string }) => ({
          role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
          content: m.content,
        }));

      finalSessionId = await initSession(coachSessionAgentId, userId, [
        { role: "system" as const, content: effectiveSystemPrompt },
        ...priorHistory,
        newUserMsg,
        newAssistMsg,
      ]);
      console.log(`[coach] session initialised: sdkSessionId=${finalSessionId}`);
    }
  } catch (err) {
    console.error("[coach] session update failed (non-blocking):", err);
  }

  // Destination-scoped Slack history lives only in its provider session. Do not
  // copy it into the user-global history where another destination can read it.
  const userMsg = { id: Date.now().toString(), role: "user", content: userText };
  const assistantMsg = { id: (Date.now() + 1).toString(), role: "assistant", content: reply };
  const updatedChat = [assistantMsg, userMsg, ...chatMessages].slice(0, 100);

  try {
    if (!destinationScopedConversation) {
      await db.insert(schema.chatHistory)
        .values({ userId, data: updatedChat })
        .onConflictDoUpdate({
          target: schema.chatHistory.userId,
          set: { data: updatedChat, updatedAt: new Date() },
        });
    }
  } catch (err) {
    console.error("[coach] chat history persist failed:", err);
  }

  // ── Auto-TTS: speak the reply on channels where it's enabled ──────────────
  // Trigger conditions:
  //   1. Explicit request: user message contains a phrase like "say that as a
  //      voice message", "read it out", "speak that", "read that to me", etc.
  //   2. Auto-TTS: the user has enabled auto-TTS for the current channel in
  //      their preferences (ttsChannels contains the channel key).
  //
  // Fire-and-forget (non-blocking). Never throws / never blocks the reply.
  const channelKey = channelLower.startsWith("discord") ? "discord"
    : channelLower === "whatsapp" ? "whatsapp"
    : channelLower === "telegram" ? "telegram"
    : null;

  if (channelKey && (channelKey === "telegram" || channelKey === "whatsapp")) {
    const isExplicitTtsRequest = /\b(say\s+(that|it|this)|read\s+(that|it|this)\s*(out|aloud|to\s*me)?|speak\s+(that|it|this)|voice\s+message\s*(it|that|please)?|send\s+(as\s+)?(a\s+)?voice|read\s+out\s*(loud)?)\b/i.test(
      userText,
    );

    (async () => {
      try {
        const { getUserTtsPrefs, getUserTtsChannels, speakToUser } = await import("../agent/tools/tts");
        const enabledChannels = await getUserTtsChannels(userId);
        const shouldSpeak = isExplicitTtsRequest || enabledChannels.includes(channelKey);
        if (!shouldSpeak) return;

        const prefs = await getUserTtsPrefs(userId);
        const voice = prefs.voice || "nova";

        const result = await speakToUser(userId, reply, voice, {
          channel: channelName,
          serverBaseUrl: process.env.SERVER_BASE_URL,
        });

        if (!result.ok) {
          console.warn(`[${channelName}/auto-TTS] delivery failed: ${result.error}`);
        } else {
          console.log(`[${channelName}/auto-TTS] voice note delivered (voice=${voice}, chars=${reply.length})`);
        }
      } catch (err) {
        console.warn(`[${channelName}/auto-TTS] error (non-blocking):`, err);
      }
    })();
  }

  return { reply, rawReply, attachments, sdkSessionId: finalSessionId };
}
