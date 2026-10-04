/**
 * Query intent classifier — pure utility, no external deps.
 *
 * Lightweight keyword heuristic that runs in <1ms per query with no LLM call.
 * Separating this from activationPlanner.ts allows tests to import the real
 * implementation without pulling in DB or OpenAI connections.
 */

const RESEARCH_PATTERNS = [
  /\b(search|look up|lookup|google|find|browse|research|investigate)\b/i,
  /\b(article|website|url|link|page|source|reference|docs?|documentation)\b/i,
  /\b(what is|what are|who is|where is|how does|how do|explain|define|tell me about)\b/i,
  /\b(youtube|video|transcript|watch|summarize this)\b/i,
  /\b(latest news|news about|read about|fetch|scrape|crawl)\b/i,
  /https?:\/\//i,
];

/**
 * Classify a user's query as "research" (web/doc lookup) or "general"
 * (conversational or task-management).
 *
 * Used by the activation planner (Rule 8c) to decide whether to activate
 * or suppress the browser + research capability for a given channel session.
 */
export function classifyQueryIntent(text: string): "research" | "general" {
  if (!text || text.trim().length === 0) return "general";
  return RESEARCH_PATTERNS.some((re) => re.test(text)) ? "research" : "general";
}

export { classifyToolAwareRoute } from "./toolAwareRouting";
export type { ToolAwareIntent, ToolAwareRoutePlan } from "./toolAwareRouting";

/**
 * Patterns that indicate the user wants Jarvis to build a new tool or feature.
 *
 * Deliberately narrow to avoid false positives:
 *   - "build a plan" / "build a schedule" → NOT matched (no tool noun)
 *   - "write a memo" / "write a report" → NOT matched ("write" excluded from
 *     the broad pattern; only matched via specific write sub-patterns)
 *   - "build a weather lookup tool" → matched (allows up to 4 intermediate words)
 *   - "add a Notion integration" → matched
 *   - "write a script that does X" → matched
 *   - "implement a new capability to track stocks" → matched
 */
const BUILD_TOOL_NOUNS =
  "tool|integration|capability|feature|plugin|command|script|function|bot|webhook|connector|module|agent";

const BUILD_PATTERNS = [
  // (build verb) + up to 4 intermediate words + (tool/feature noun)
  // "write" is intentionally excluded to avoid "write a memo about a feature".
  new RegExp(
    `\\b(build|create|make|implement|add|code)\\s+(?:\\w+\\s+){0,4}(${BUILD_TOOL_NOUNS})\\b`,
    "i",
  ),
  // "write a script|function|tool|bot|integration|module|capability" (specific write forms)
  new RegExp(
    `\\bwrite\\s+(?:a\\s+|an\\s+|the\\s+)?(?:new\\s+)?(script|function|tool|integration|module|bot|capability)\\b`,
    "i",
  ),
  // "write (the) code (for|to|that)" — clearly about software development
  /\bwrite\s+(the\s+)?code\s+(for|to|that)\b/i,
  // "add support for" or "add an integration for/with"
  /\badd\s+(support\s+for|an?\s+integration\s+(for|with|to))\b/i,
  // "extend yourself/Jarvis" or "give yourself/Jarvis a new tool/capability"
  /\b(extend\s+(yourself|jarvis)|give\s+(yourself|jarvis)\s+(?:a\s+)?(?:new\s+)?(tool|capability|power|ability))\b/i,
];

/**
 * Patterns that identify iterative build refinements / follow-up tweaks.
 *
 * These cover messages that don't contain a tool noun but are clearly asking
 * Jarvis to adjust something it just built:
 *   - "now add retry logic"
 *   - "also add error handling"
 *   - "update it to support timeouts"
 *   - "change it to use async/await"
 *   - "fix the bug in it"
 *   - "make it also log to console"
 *   - "rename the variable X to Y"
 *   - "refactor it to be cleaner"
 */
const BUILD_REFINEMENT_PATTERNS = [
  // "now add X" / "also add X" / "then add X"
  /\b(now|also|then)\s+add\b/i,
  // "also make it (do|support|handle|work|log|return|accept|use) X"
  /\balso\s+make\s+it\b/i,
  // "update it to …" / "change it to …" / "modify it to …"
  /\b(update|change|modify|adjust)\s+it\s+to\b/i,
  // "fix (the|a|any)? X in it" / "fix the bug in it" / "fix it to …"
  /\bfix\s+(the\s+|a\s+|any\s+)?\w+(\s+\w+)?\s+in\s+it\b/i,
  /\bfix\s+it\s+to\b/i,
  // "make it (also )? (support|handle|accept|return|log|use|work|run) …"
  /\bmake\s+it\s+(also\s+)?(support|handle|accept|return|log|use|work|run|check|retry|validate|include|exclude|store|save|send|fetch|call|catch|throw|wrap|expose|add)\b/i,
  // "add retry logic" / "add error handling" / "add logging" / "add caching"
  // without a build verb — covers common dev tweaks that need no tool noun
  /\badd\s+(retry|error\s+handling|logging|caching|validation|rate.?limit|timeout|auth|authentication|pagination|sorting|filtering|debounce|throttl)\b/i,
  // "refactor it …" / "clean it up" / "simplify it"
  /\b(refactor|clean\s+up|simplify|optimis|optimiz)\s+(it|the)\b/i,
  // "rename X to Y (in it)" 
  /\brename\s+\S+\s+to\s+\S+/i,
];

/**
 * Returns true when the user is asking Jarvis to build a new tool or feature.
 *
 * Used by coachAgent to short-circuit the orchestrator and route directly to
 * the build_feature background job, exactly as research intent is routed to
 * the research job via queue_background_job.
 */
export function classifyBuildIntent(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  return BUILD_PATTERNS.some((re) => re.test(text));
}

export function classifyStandaloneAppProjectIntent(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  return (
    /\b(?:build|create|make|start|develop)\b[\s\S]{0,100}\b(?:android|mobile|iphone|ios|web)\s+app\b/i.test(text) ||
    /\b(?:build|create|make|start|develop)\b[\s\S]{0,100}\b(?:standalone\s+)?(?:calculator|weather|notes?|todo|to-do)\s+app\b/i.test(text) ||
    /\b(?:build|create|make|start|develop)\b[\s\S]{0,100}\bgame\b(?!\s+plan)/i.test(text)
  );
}

/**
 * Returns true when the user's message is clearly unrelated to building a tool
 * (e.g. email, calendar, tasks, reminders).
 *
 * Exported so coachAgent can detect when the user is switching away from an
 * active build session without calling the full classifyBuildFollowUp logic.
 */
export function isUnrelatedIntent(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  return UNRELATED_INTENT_PATTERNS.some((re) => re.test(text));
}

/**
 * Patterns that indicate the user wants to resume a previously-suspended build
 * session after Jarvis stepped away to handle an unrelated request.
 *
 * Examples matched:
 *   - "back to the build"
 *   - "let's continue the build"
 *   - "ok let's resume"
 *   - "continue where we left off"
 *   - "get back to the tool"
 *   - "resume the feature"
 */
const BUILD_RESUME_PATTERNS = [
  // "back to (the)? (build|tool|feature|script|bot|integration|module|…)"
  /\bback\s+to\s+(the\s+)?(build|tool|feature|script|bot|integration|module|plugin|agent|capability|command|function|webhook|connector)\b/i,
  // "resume (the)? build / tool / …"
  /\bresume\s+(the\s+)?(build|tool|feature|script|bot|integration|module|plugin|agent|capability|command|function|webhook|connector)\b/i,
  // "continue (the|where we left off|with the build|…)"
  /\bcontinue\s+(the\s+)?(build|tool|feature|script|bot|integration|module|plugin|agent|capability|command|function|webhook|connector)\b/i,
  /\bcontinue\s+where\s+we\s+left\s+off\b/i,
  /\bpick\s+up\s+where\s+we\s+left\s+off\b/i,
  // "let's (get back|go back|return|resume|continue)" with optional "to the build/tool"
  /\blet'?s?\s+(get\s+back|go\s+back|return|resume|continue)\s+(to\s+(the\s+)?)?(build|tool|feature|script|building)\b/i,
  // "back to building / back to coding"
  /\bback\s+to\s+(building|coding|it)\b/i,
  // "ok(ay)?, let's (resume|continue|get back)" — require explicit "let's" to avoid
  // matching generic "ok continue" in unrelated contexts
  /\b(ok|okay)[,.]?\s+let'?s?\s+(resume|continue|get\s+back)\b/i,
  // "where were we with the build/tool" or "where did we leave off (with X)"
  // Requires build/tool noun to avoid matching the phrase in unrelated conversations
  /\bwhere\s+(were\s+we|did\s+we\s+leave\s+off)\s+(with\s+(the\s+)?)?(build|tool|feature|script|bot|integration|module|it)\b/i,
];

/**
 * Returns true when the user is signalling that they want to resume a build
 * session that was previously suspended by a topic-change (e.g. checking email).
 *
 * Requires:
 *   1. The current message matches a BUILD_RESUME_PATTERNS phrase.
 *   2. A BUILD_ACK_MARKER exists somewhere in the recent history window —
 *      meaning a build was started even if a topic-change has since occurred.
 *
 * Unlike classifyBuildFollowUp, this does NOT require the session to still be
 * active (i.e. it intentionally ignores whether a topic-change happened).
 */
export function classifyBuildResume(
  text: string,
  chatHistory: Array<{ role: string; content: string }>,
): boolean {
  if (!text || text.trim().length === 0) return false;
  if (!BUILD_RESUME_PATTERNS.some((re) => re.test(text))) return false;
  // Require that a build ack exists somewhere in the recent window
  const window = chatHistory.slice(0, BUILD_SESSION_WINDOW);
  return window.some(
    (m) => m.role === "assistant" && m.content.includes(BUILD_ACK_MARKER),
  );
}

/**
 * Scans the chat history (newest-first) and returns a short description of
 * what was originally requested to be built.
 *
 * Looks for the user message that immediately preceded the most-recent
 * BUILD_ACK_MARKER in the assistant's reply.  Falls back to a generic
 * "your previous build request" when no specific message can be found.
 */
export function findBuildDescription(
  chatHistory: Array<{ role: string; content: string }>,
): string {
  const window = chatHistory.slice(0, BUILD_SESSION_WINDOW);
  const ackIndex = window.findIndex(
    (m) => m.role === "assistant" && m.content.includes(BUILD_ACK_MARKER),
  );
  if (ackIndex === -1) return "your previous build request";

  // The user message that came just before (i.e. higher index in newest-first) the ack
  for (let i = ackIndex + 1; i < window.length; i++) {
    if (window[i].role === "user") {
      const content = window[i].content.trim();
      // Truncate long messages so the resume ack stays concise
      return content.length > 120 ? content.slice(0, 117) + "…" : content;
    }
  }
  return "your previous build request";
}

/**
 * Returns true when there is an active build session in the recent chat history.
 *
 * An active session exists when:
 *   1. A build-ack message appears within the last BUILD_SESSION_WINDOW entries.
 *   2. No substantive user message between that ack and the present signals a
 *      topic change (same logic as classifyBuildFollowUp, minus the final
 *      refinement-pattern check).
 *
 * chatHistory is stored newest-first (as per coachAgent convention).
 */
export function hasActiveBuildSession(
  chatHistory: Array<{ role: string; content: string }>,
): boolean {
  const window = chatHistory.slice(0, BUILD_SESSION_WINDOW);
  const ackIndex = window.findIndex(
    (m) => m.role === "assistant" && m.content.includes(BUILD_ACK_MARKER),
  );
  if (ackIndex === -1) return false;

  const userTurnsAfterAck = window.slice(0, ackIndex).filter((m) => m.role === "user");
  const hasTopicChange = userTurnsAfterAck.some((m) => {
    const t = m.content.trim();
    if (t.length < 10 || TRIVIAL_ACK_PATTERN.test(t)) return false;
    if (BUILD_SESSION_END_PATTERNS.some((re) => re.test(t))) return true;
    if (UNRELATED_INTENT_PATTERNS.some((re) => re.test(t))) return true;
    if (BUILD_PATTERNS.some((re) => re.test(t))) return false;
    if (BUILD_REFINEMENT_PATTERNS.some((re) => re.test(t))) return false;
    return true;
  });

  return !hasTopicChange;
}

/**
 * Stable substring that Jarvis always includes in the ack reply when a build
 * job is successfully queued.  Exported so coachAgent.ts can embed it in the
 * reply it sends — keeping the marker and the reply in sync automatically and
 * avoiding a hidden copy-paste coupling.
 */
export const BUILD_ACK_MARKER = "queued that build job";

/**
 * Stable substring embedded in the one-time "suspended build" reminder note.
 * Its presence in the recent history signals that the reminder has already
 * been delivered and should not be repeated for this session.
 */
export const SUSPENDED_BUILD_REMINDED_MARKER = "still have a build queued";

/**
 * How many messages back (newest-first) to scan when deciding whether an
 * active build session is in progress.  A window of 20 covers roughly 10
 * user/assistant turns, which is more than enough for a typical multi-step
 * build conversation without risking false-positives from very old sessions.
 */
const BUILD_SESSION_WINDOW = 20;

/**
 * Patterns that indicate the user is explicitly ending the build session and
 * moving to a completely different topic.  Any match causes classifyBuildFollowUp
 * to return false even if a recent build ack exists in history.
 */
const BUILD_SESSION_END_PATTERNS = [
  // Explicit cancellation
  /\b(forget|never mind|nevermind|stop|cancel|abort|ignore)\s+(that|the\s+build|it)\b/i,
  // Switching topics
  /\b(let'?s|i\s+want\s+to)\s+(do\s+something\s+else|talk\s+about\s+something\s+else|switch\s+topics?|move\s+on|change\s+the\s+subject)\b/i,
  // Wrapping up
  /\b(that'?s?\s+(all|enough|good|done|great|it)|we'?r?e?\s+done\s+with\s+that)\b/i,
];

/**
 * Patterns for requests that are clearly unrelated to building a tool — email,
 * calendar, task management, and similar everyday assistant actions.
 *
 * When a user is in an active build session and sends one of these, Jarvis
 * should exit build mode and handle the request normally through the
 * orchestrator rather than treating it as a build refinement.
 *
 * Deliberately broad so that natural phrasing ("can you check my email",
 * "do I have any meetings", "remind me to…") is caught without requiring
 * an explicit "never mind" signal from the user.
 */
const UNRELATED_INTENT_PATTERNS = [
  // ── Email / inbox ──────────────────────────────────────────────────────────
  /\b(check|read|open|show|see|get|fetch|look\s+at)\s+(me\s+)?(my\s+)?(email|emails?|inbox|mail|messages?|gmail|outlook)\b/i,
  /\b(any\s+)?(new\s+)?(email|emails?|messages?)\s+(in\s+my\s+inbox|from|about)\b/i,
  /\b(send|write|compose|draft|reply\s+to|respond\s+to)\s+(an?\s+)?(email|message)\b/i,
  /\b(unread|recent)\s+(email|emails?|messages?|mail)\b/i,

  // ── Calendar / scheduling ──────────────────────────────────────────────────
  /\b(schedule|book|set\s+up|arrange|plan)\s+(a\s+)?(meeting|call|appointment|event|session|interview|sync|standup|1:?1|one.on.one)\b/i,
  /\b(what|do\s+i\s+have)\s+(meetings?|events?|appointments?|calls?|on\s+my\s+calendar)\b/i,
  /\bwhat'?s?\s+(on\s+my\s+)?calendar\b/i,
  /\b(add|put|block)\s+(it\s+)?on\s+(my\s+)?calendar\b/i,
  /\bcancel\s+(a\s+|the\s+|my\s+)?(meeting|event|appointment|call)\b/i,
  /\b(reschedule|move)\s+(a\s+|the\s+|my\s+)?(meeting|event|appointment|call)\b/i,
  /\b(am\s+i|are\s+we)\s+free\s+(at|on|tomorrow|today)\b/i,
  /\b(any\s+)?(meetings?|events?|calls?)\s+(today|tomorrow|this\s+week|tonight|this\s+afternoon|this\s+morning)\b/i,
  /\bwhat\s+(meetings?|events?|do\s+i\s+have)\s+(today|tomorrow|this\s+week|on\s+\w+)\b/i,

  // ── Tasks / reminders ──────────────────────────────────────────────────────
  /\b(add|create|set)\s+(a\s+)?(task|to.?do|reminder|alarm)\b/i,
  /\b(remind\s+me|set\s+a\s+reminder)\s+(to|about|at|in)\b/i,
  /\b(what|show)\s+(are\s+)?(my\s+)?(tasks?|to.?dos?|reminders?)\b/i,
  /\bmark\s+(it|this|that)\s+as\s+(done|complete|finished)\b/i,

  // ── General assistant pivots (non-build) ───────────────────────────────────
  /\bsummarise\s+(my|the|today'?s?)\s+(day|emails?|messages?|inbox|calendar)\b/i,
  /\bwhat'?s?\s+(happening|going\s+on)\s+(today|tonight|this\s+week)\b/i,
  /\b(play|pause|skip|stop)\s+(music|song|track|playlist|podcast|video)\b/i,
  /\bset\s+(a\s+)?(timer|alarm|countdown)\b/i,
  /\bwhat('?s|\s+is)\s+the\s+(weather|temperature|forecast)\b/i,
  /\b(find|look\s+up|search\s+for)\s+(a\s+|an\s+)?(restaurant|flight|hotel|recipe)\b/i,
];

/**
 * Short phrases that are trivial acknowledgements and should NOT reset the
 * build session — they carry no topic signal.
 */
const TRIVIAL_ACK_PATTERN = /^(ok|okay|thanks|thank you|got it|sounds good|great|cool|nice|perfect|awesome|alright|sure|yep|yeah|yes|no|nope)\b/i;

/**
 * Returns true when the current message is a follow-up refinement to an
 * ongoing build conversation.
 *
 * Keeps Jarvis in "build session" mode for the full conversation, not just
 * the immediately-following message.  The session stays active as long as:
 *   1. At least one assistant message within the last BUILD_SESSION_WINDOW
 *      entries contains the build-ack marker (i.e. a build was queued at some
 *      point in the recent conversation).
 *   2. No substantive user message between that ack and the current turn
 *      (newest-first positions 0..ackIndex-1) is a "general" turn — meaning
 *      it carries no build/refinement signal.  A general turn signals a topic
 *      change and ends the build session for all subsequent messages.
 *   3. The current message is not an explicit session-end phrase.
 *   4. The current message matches at least one BUILD_REFINEMENT_PATTERN or
 *      one of the regular BUILD_PATTERNS.
 *
 * chatHistory is stored newest-first (as per coachAgent convention).
 */
export function classifyBuildFollowUp(
  text: string,
  chatHistory: Array<{ role: string; content: string }>,
): boolean {
  if (!text || text.trim().length === 0) return false;

  // Explicit session-end check — bail out before scanning history
  if (BUILD_SESSION_END_PATTERNS.some((re) => re.test(text))) {
    return false;
  }

  // Unrelated-intent check — email, calendar, reminders, and similar everyday
  // requests that have nothing to do with building a tool.  Exit build mode
  // immediately so the orchestrator can handle the request normally.
  if (UNRELATED_INTENT_PATTERNS.some((re) => re.test(text))) {
    return false;
  }

  // Locate the most-recent build ack within the sliding window.
  // Using findIndex preserves the exact position so we can inspect the turns
  // that occurred *after* the ack (smaller indices = more recent in history).
  const window = chatHistory.slice(0, BUILD_SESSION_WINDOW);
  const ackIndex = window.findIndex(
    (m) => m.role === "assistant" && m.content.includes(BUILD_ACK_MARKER),
  );
  if (ackIndex === -1) {
    return false; // No build ack in recent history — not in a build session
  }

  // Check for a user-driven topic change between the ack and now.
  // In newest-first order, indices 0..ackIndex-1 are more recent than the ack.
  // Only USER messages are considered — intermediate assistant replies (which may
  // vary in wording and may not contain the marker) are intentionally ignored so
  // that the build session persists across the full conversation until the user
  // explicitly changes topic.
  //
  // A topic change is signalled by a substantive user message (≥10 chars, not a
  // trivial ack) that carries no build or refinement signal — including explicit
  // session-end phrases ("never mind that", "cancel it", etc.).
  const userTurnsAfterAck = window
    .slice(0, ackIndex)
    .filter((m) => m.role === "user");
  const hasTopicChange = userTurnsAfterAck.some((m) => {
    const t = m.content.trim();
    // Trivial one-liners carry no topic signal — don't reset the session
    if (t.length < 10 || TRIVIAL_ACK_PATTERN.test(t)) return false;
    // Explicit session-end phrase in a prior turn → definitive topic change
    if (BUILD_SESSION_END_PATTERNS.some((re) => re.test(t))) return true;
    // Unrelated intent in a prior turn (email, calendar, tasks…) → topic change
    if (UNRELATED_INTENT_PATTERNS.some((re) => re.test(t))) return true;
    // Any build or refinement signal keeps the session alive
    if (BUILD_PATTERNS.some((re) => re.test(t))) return false;
    if (BUILD_REFINEMENT_PATTERNS.some((re) => re.test(t))) return false;
    // Substantive message with no build signal → general topic change
    return true;
  });

  if (hasTopicChange) {
    return false; // User changed topic after the last ack — session is over
  }

  // Build session is active — check if current message is a refinement or
  // a fresh build request (user may fully rephrase the original requirement)
  return (
    BUILD_REFINEMENT_PATTERNS.some((re) => re.test(text)) ||
    BUILD_PATTERNS.some((re) => re.test(text))
  );
}

/**
 * A persisted build-session record fetched from the DB so that
 * `findSuspendedBuild` can fall back to it when the original ack message
 * has scrolled past the rolling chat-history window.
 */
export interface StoredBuildSession {
  ackTimestamp: number;
  reminded: boolean;
  buildDescription: string;
}

/**
 * Inspects the chat history (newest-first) and returns information about a
 * "suspended build" — a build ack that has not yet been followed up with a
 * reminder to the user.
 *
 * Used by coachAgent.ts to append a one-time "heads-up" note when the user
 * returns after being away for longer than SUSPENDED_BUILD_REMINDER_THRESHOLD.
 *
 * When no ack is found in the rolling window, `storedSession` (fetched from
 * the `build_sessions` DB table by the caller) is consulted so that reminders
 * continue to fire even in long conversations.
 *
 * Returns:
 *  - ackAgeMs        — milliseconds since the build ack was stored (based on
 *                      the message id timestamp, or storedSession.ackTimestamp
 *                      when falling back to the DB record), or null when no
 *                      ack is found in either source.
 *  - shouldSuppress  — true when the reminder should NOT be shown because:
 *                        (a) SUSPENDED_BUILD_REMINDED_MARKER already appears in
 *                            the messages sent AFTER the current ack (scoped to
 *                            this session, not the full history), or
 *                        (b) the user already sent a build refinement message
 *                            after the ack (the build is not "suspended"), or
 *                        (c) storedSession.reminded is true (DB-level flag).
 *  - buildDescription — the original build goal (via findBuildDescription).
 */
export function findSuspendedBuild(
  chatHistory: Array<{ id?: string; role: string; content: string }>,
  storedSession?: StoredBuildSession | null,
): { ackAgeMs: number | null; shouldSuppress: boolean; buildDescription: string } {
  const sessionWindow = chatHistory.slice(0, BUILD_SESSION_WINDOW);
  const ackIndex = sessionWindow.findIndex(
    (m) => m.role === "assistant" && m.content.includes(BUILD_ACK_MARKER),
  );

  // No build ack in recent history — fall back to persisted store.
  if (ackIndex === -1) {
    if (!storedSession) {
      return { ackAgeMs: null, shouldSuppress: false, buildDescription: "your previous build request" };
    }
    const ackAgeMs = Date.now() - storedSession.ackTimestamp;
    return {
      ackAgeMs,
      shouldSuppress: storedSession.reminded,
      buildDescription: storedSession.buildDescription,
    };
  }

  // In a newest-first array, messages at indices 0..ackIndex-1 are NEWER than
  // the ack (they arrived after it).  Scope all per-session checks to this slice
  // so that an old reminder or old refinement in a previous session doesn't
  // bleed into the current one.
  const messagesAfterAck = sessionWindow.slice(0, ackIndex);

  // (a) Has the reminder already been delivered in this session?
  //     Also check the DB-level flag in case the ack is in the window but the
  //     reminder message itself has scrolled out.
  const alreadyRemindedInHistory = messagesAfterAck.some(
    (m) => m.role === "assistant" && m.content.includes(SUSPENDED_BUILD_REMINDED_MARKER),
  );
  const alreadyReminded = alreadyRemindedInHistory || (storedSession?.reminded ?? false);

  // (b) Has the user already engaged with the build via a refinement message?
  //     If so, the build is active (not suspended) and we must not remind.
  const hasRefinementSinceAck = messagesAfterAck.some((m) => {
    if (m.role !== "user") return false;
    const t = m.content.trim();
    if (t.length < 5) return false;
    return (
      BUILD_REFINEMENT_PATTERNS.some((re) => re.test(t)) ||
      BUILD_PATTERNS.some((re) => re.test(t))
    );
  });

  const shouldSuppress = alreadyReminded || hasRefinementSinceAck;

  // Compute the age of the ack from its id (which is Date.now().toString() when
  // stored by coachAgent.ts / buildIntentRouter.ts).  Fall back to the stored
  // ack timestamp when the message id cannot be parsed (defensive).
  const ackEntry = sessionWindow[ackIndex];
  let ackAgeMs: number | null = null;
  if (ackEntry.id) {
    const ts = parseInt(ackEntry.id, 10);
    // Validate it looks like a reasonable ms-epoch timestamp (post year 2001)
    if (!isNaN(ts) && ts > 1_000_000_000_000) {
      ackAgeMs = Date.now() - ts;
    }
  }
  if (ackAgeMs === null && storedSession) {
    ackAgeMs = Date.now() - storedSession.ackTimestamp;
  }

  const buildDescription = findBuildDescription(chatHistory);
  return { ackAgeMs, shouldSuppress, buildDescription };
}
