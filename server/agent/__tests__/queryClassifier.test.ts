/**
 * Unit tests for classifyBuildIntent and classifyBuildFollowUp.
 *
 * Pure functions with no external deps — no mocking required.
 *
 * Run with: tsx server/agent/__tests__/queryClassifier.test.ts
 */

import {
  classifyBuildIntent,
  classifyBuildFollowUp,
  classifyBuildResume,
  findBuildDescription,
  classifyQueryIntent,
  classifyStandaloneAppProjectIntent,
  BUILD_ACK_MARKER,
} from "../queryClassifier";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`✓ ${label}`);
    passed++;
  } else {
    console.error(`✗ ${label}`);
    failed++;
  }
}

// ── Helper to build a chat history with a build-ack from the assistant ────────

function historyWithAck(
  extraMessages: Array<{ role: string; content: string }> = [],
): Array<{ role: string; content: string }> {
  return [
    // newest-first convention used by coachAgent
    { role: "assistant", content: `I've ${BUILD_ACK_MARKER} for you.` },
    ...extraMessages,
  ];
}

function historyWithoutAck(): Array<{ role: string; content: string }> {
  return [
    { role: "assistant", content: "Sure, here is your summary." },
    { role: "user", content: "Summarise my emails." },
  ];
}

assert(
  classifyStandaloneAppProjectIntent("Build me a small Android calculator app"),
  "APP-1: Android calculator creation is a standalone app project",
);
assert(
  classifyStandaloneAppProjectIntent("Create a web app for tracking workouts"),
  "APP-2: web app creation is a standalone app project",
);
assert(
  classifyStandaloneAppProjectIntent("Build me a small Pong game I can play against Jarvis"),
  "APP-3: interactive game creation is a standalone app project",
);
assert(
  !classifyStandaloneAppProjectIntent("fix your calendar routing code"),
  "APP-4: Jarvis self-edit is not a standalone app project",
);
assert(
  !classifyStandaloneAppProjectIntent("build a game plan for launch"),
  "APP-5: a game plan is not an app project",
);

// ─────────────────────────────────────────────────────────────────────────────
// classifyBuildIntent — positives
// ─────────────────────────────────────────────────────────────────────────────

assert(
  classifyBuildIntent("build a weather lookup tool"),
  "BI-1: 'build a weather lookup tool' → true",
);
assert(
  classifyBuildIntent("create a new integration with Notion"),
  "BI-2: 'create a new integration with Notion' → true",
);
assert(
  classifyBuildIntent("make a Discord bot for me"),
  "BI-3: 'make a Discord bot for me' → true",
);
assert(
  classifyBuildIntent("implement a capability to track stocks"),
  "BI-4: 'implement a capability to track stocks' → true",
);
assert(
  classifyBuildIntent("add a Slack integration for notifications"),
  "BI-5: 'add a Slack integration for notifications' → true",
);
assert(
  classifyBuildIntent("code a webhook handler"),
  "BI-6: 'code a webhook handler' → true",
);
assert(
  classifyBuildIntent("write a script that fetches prices"),
  "BI-7: 'write a script that fetches prices' → true",
);
assert(
  classifyBuildIntent("write a function that parses JSON"),
  "BI-8: 'write a function that parses JSON' → true",
);
assert(
  classifyBuildIntent("write the code for a retry mechanism"),
  "BI-9: 'write the code for a retry mechanism' → true",
);
assert(
  classifyBuildIntent("add support for OAuth"),
  "BI-10: 'add support for OAuth' → true",
);
assert(
  classifyBuildIntent("add an integration for GitHub"),
  "BI-11: 'add an integration for GitHub' → true",
);
assert(
  classifyBuildIntent("extend yourself with a new tool"),
  "BI-12: 'extend yourself with a new tool' → true",
);
assert(
  classifyBuildIntent("give Jarvis a new capability to summarise PDFs"),
  "BI-13: 'give Jarvis a new capability to summarise PDFs' → true",
);
assert(
  classifyBuildIntent("Build me a connector for Salesforce"),
  "BI-14: uppercase Build matches (case-insensitive) → true",
);

// ─────────────────────────────────────────────────────────────────────────────
// classifyBuildIntent — negatives (must NOT fire)
// ─────────────────────────────────────────────────────────────────────────────

assert(
  !classifyBuildIntent("build a plan for next week"),
  "BI-N1: 'build a plan for next week' → false (no tool noun)",
);
assert(
  !classifyBuildIntent("build a schedule for me"),
  "BI-N2: 'build a schedule for me' → false (no tool noun)",
);
assert(
  !classifyBuildIntent("write a memo about our product feature"),
  "BI-N3: 'write a memo about our product feature' → false (memo is not a tool noun)",
);
assert(
  !classifyBuildIntent("write a report on last month's sales"),
  "BI-N4: 'write a report on last month's sales' → false (report is not a tool noun)",
);
assert(
  !classifyBuildIntent("can you summarise my emails today"),
  "BI-N5: plain task request → false",
);
assert(
  !classifyBuildIntent("what is on my calendar tomorrow"),
  "BI-N6: calendar query → false",
);
assert(
  !classifyBuildIntent(""),
  "BI-N7: empty string → false",
);
assert(
  !classifyBuildIntent("   "),
  "BI-N8: whitespace-only string → false",
);
assert(
  !classifyBuildIntent("remind me to call John at 3pm"),
  "BI-N9: reminder request → false",
);
assert(
  !classifyBuildIntent("search for the latest AI news"),
  "BI-N10: research request → false",
);

// ─────────────────────────────────────────────────────────────────────────────
// classifyBuildFollowUp — detects refinements after build ack
// ─────────────────────────────────────────────────────────────────────────────

assert(
  classifyBuildFollowUp("now add retry logic", historyWithAck()),
  "BF-1: 'now add retry logic' after ack → true",
);
assert(
  classifyBuildFollowUp("also add error handling", historyWithAck()),
  "BF-2: 'also add error handling' after ack → true",
);
assert(
  classifyBuildFollowUp("update it to support timeouts", historyWithAck()),
  "BF-3: 'update it to support timeouts' after ack → true",
);
assert(
  classifyBuildFollowUp("change it to use async/await", historyWithAck()),
  "BF-4: 'change it to use async/await' after ack → true",
);
assert(
  classifyBuildFollowUp("fix the bug in it", historyWithAck()),
  "BF-5: 'fix the bug in it' after ack → true",
);
assert(
  classifyBuildFollowUp("make it also log to console", historyWithAck()),
  "BF-6: 'make it also log to console' after ack → true",
);
assert(
  classifyBuildFollowUp("refactor it to be cleaner", historyWithAck()),
  "BF-7: 'refactor it to be cleaner' after ack → true",
);
assert(
  classifyBuildFollowUp("rename myVar to betterName", historyWithAck()),
  "BF-8: 'rename myVar to betterName' after ack → true",
);
// Full build-intent rephrase also counts as a follow-up when ack is present
assert(
  classifyBuildFollowUp("build a caching module for it", historyWithAck()),
  "BF-9: full build rephrasing after ack → true",
);
assert(
  classifyBuildFollowUp("add caching", historyWithAck()),
  "BF-10: 'add caching' after ack → true (refinement keyword)",
);
assert(
  classifyBuildFollowUp("make it handle pagination", historyWithAck()),
  "BF-11: 'make it handle pagination' after ack → true",
);
assert(
  classifyBuildFollowUp("fix it to throw on invalid input", historyWithAck()),
  "BF-12: 'fix it to throw on invalid input' after ack → true",
);

// ─────────────────────────────────────────────────────────────────────────────
// classifyBuildFollowUp — ignored when no prior ack exists
// ─────────────────────────────────────────────────────────────────────────────

assert(
  !classifyBuildFollowUp("now add retry logic", historyWithoutAck()),
  "BF-N1: refinement pattern but no ack in history → false",
);
assert(
  !classifyBuildFollowUp("also add error handling", historyWithoutAck()),
  "BF-N2: common refinement phrase, no ack → false",
);
assert(
  !classifyBuildFollowUp("update it to support timeouts", historyWithoutAck()),
  "BF-N3: update-it pattern, no ack → false",
);
assert(
  !classifyBuildFollowUp("make it handle pagination", historyWithoutAck()),
  "BF-N4: make-it pattern, no ack → false",
);
assert(
  !classifyBuildFollowUp("build a script to parse CSV", historyWithoutAck()),
  "BF-N5: full build intent but no ack → false (should go through classifyBuildIntent instead)",
);

// ─────────────────────────────────────────────────────────────────────────────
// classifyBuildFollowUp — edge cases: empty / minimal history
// ─────────────────────────────────────────────────────────────────────────────

assert(
  !classifyBuildFollowUp("now add retry logic", []),
  "BF-E1: refinement with empty history → false",
);
assert(
  !classifyBuildFollowUp("", historyWithAck()),
  "BF-E2: empty message with ack → false",
);
assert(
  !classifyBuildFollowUp("   ", historyWithAck()),
  "BF-E3: whitespace-only message with ack → false",
);
assert(
  !classifyBuildFollowUp("now add retry logic", [
    { role: "user", content: "hello" },
  ]),
  "BF-E4: history contains only user messages (no assistant) → false",
);
// Intermediate non-ack assistant reply does NOT reset the session — only user
// topic changes do.  A later refinement should still route to build_feature.
assert(
  classifyBuildFollowUp("now add retry logic", [
    { role: "assistant", content: "Your calendar is clear tomorrow." },
    { role: "assistant", content: `I've ${BUILD_ACK_MARKER} for you.` },
  ]),
  "BF-E5: ack with intermediate non-ack assistant reply, no user topic change → true",
);

// ─────────────────────────────────────────────────────────────────────────────
// classifyBuildFollowUp — build session persists across multiple turns
// ─────────────────────────────────────────────────────────────────────────────

// Three consecutive refinements — each should still be in build mode
assert(
  classifyBuildFollowUp("also add rate limiting", [
    // newest-first: two prior refinements already processed
    { role: "assistant", content: `Great — I've ${BUILD_ACK_MARKER} for that update.` },
    { role: "user", content: "now add retry logic" },
    { role: "assistant", content: `Sure — I've ${BUILD_ACK_MARKER} for the retry logic.` },
    { role: "user", content: "build a weather lookup tool" },
  ]),
  "BF-MS1: third consecutive refinement stays in build session → true",
);

assert(
  classifyBuildFollowUp("make it also support Celsius", [
    { role: "assistant", content: `Done — I've ${BUILD_ACK_MARKER} for the Fahrenheit support.` },
    { role: "user", content: "add Fahrenheit conversion" },
    { role: "assistant", content: `Got it — I've ${BUILD_ACK_MARKER} for the initial tool.` },
    { role: "user", content: "build a temperature converter tool" },
  ]),
  "BF-MS2: second refinement of a multi-turn build session → true",
);

// ─────────────────────────────────────────────────────────────────────────────
// classifyBuildFollowUp — session resets when user changes topic
// ─────────────────────────────────────────────────────────────────────────────

// After a general user question, refinement no longer routes to build
assert(
  !classifyBuildFollowUp("now add retry logic", [
    { role: "assistant", content: "Your calendar is clear tomorrow." },
    { role: "user", content: "what meetings do I have today?" },
    { role: "assistant", content: `I've ${BUILD_ACK_MARKER} for you.` },
    { role: "user", content: "build a weather tool" },
  ]),
  "BF-RS1: general user question after ack resets session → false",
);

// Explicit session-end in a prior user turn resets the session
assert(
  !classifyBuildFollowUp("now add retry logic", [
    { role: "assistant", content: "Understood, I'll stop." },
    { role: "user", content: "never mind that" },
    { role: "assistant", content: `I've ${BUILD_ACK_MARKER} for you.` },
    { role: "user", content: "build a weather tool" },
  ]),
  "BF-RS2: explicit cancel phrase in prior user turn resets session → false",
);

// Trivial ack does NOT reset the session
assert(
  classifyBuildFollowUp("also add caching", [
    { role: "assistant", content: `I've ${BUILD_ACK_MARKER} for you.` },
    { role: "user", content: "ok" },
    { role: "assistant", content: `I've ${BUILD_ACK_MARKER} for you.` },
    { role: "user", content: "build a weather tool" },
  ]),
  "BF-RS3: trivial 'ok' ack does not reset session → true",
);

// ─────────────────────────────────────────────────────────────────────────────
// classifyBuildFollowUp — mixed phrasing (praise + refinement in same turn)
// ─────────────────────────────────────────────────────────────────────────────

// "that's great, now add retry logic" — the wrap-up pattern fires on "that's great"
// before the refinement portion is evaluated, so the function returns false.
// This is a known heuristic trade-off: the user should send the refinement
// separately if they want it routed to build_feature.
assert(
  !classifyBuildFollowUp("that's great, now add retry logic", historyWithAck()),
  "BF-MX1: mixed wrap-up + refinement — session-end pattern takes priority → false (known heuristic edge case)",
);

// Pure refinement without praise still routes correctly (no regression)
assert(
  classifyBuildFollowUp("now add retry logic", historyWithAck()),
  "BF-MX2: pure refinement without wrap-up phrase → true",
);

// ─────────────────────────────────────────────────────────────────────────────
// classifyBuildFollowUp — unrelated-intent exit (email / calendar / tasks)
// ─────────────────────────────────────────────────────────────────────────────

// Email requests must exit build mode even when an active ack is present
assert(
  !classifyBuildFollowUp("check my email", historyWithAck()),
  "UI-1: 'check my email' in build session → false (exits to orchestrator)",
);
assert(
  !classifyBuildFollowUp("show me my inbox", historyWithAck()),
  "UI-2: 'show me my inbox' in build session → false",
);
assert(
  !classifyBuildFollowUp("send an email to Alice about the meeting", historyWithAck()),
  "UI-3: 'send an email' in build session → false",
);
assert(
  !classifyBuildFollowUp("do I have any unread emails?", historyWithAck()),
  "UI-4: 'unread emails' in build session → false",
);

// Calendar requests must exit build mode
assert(
  !classifyBuildFollowUp("what meetings do I have today", historyWithAck()),
  "UI-5: 'what meetings do I have today' in build session → false",
);
assert(
  !classifyBuildFollowUp("schedule a meeting for tomorrow at 2pm", historyWithAck()),
  "UI-6: 'schedule a meeting' in build session → false",
);
assert(
  !classifyBuildFollowUp("what's on my calendar this week", historyWithAck()),
  "UI-7: 'what's on my calendar' in build session → false",
);
assert(
  !classifyBuildFollowUp("any calls this afternoon?", historyWithAck()),
  "UI-8: 'any calls this afternoon' in build session → false",
);
assert(
  !classifyBuildFollowUp("cancel my meeting with Bob", historyWithAck()),
  "UI-9: 'cancel my meeting' in build session → false",
);

// Task / reminder requests must exit build mode
assert(
  !classifyBuildFollowUp("add a task to review the PR", historyWithAck()),
  "UI-10: 'add a task' in build session → false",
);
assert(
  !classifyBuildFollowUp("remind me to call the dentist at 5pm", historyWithAck()),
  "UI-11: 'remind me to call' in build session → false",
);
assert(
  !classifyBuildFollowUp("what are my tasks for today?", historyWithAck()),
  "UI-12: 'what are my tasks' in build session → false",
);

// Unrelated request in a PRIOR user turn resets the session for the next turn
assert(
  !classifyBuildFollowUp("now add retry logic", [
    { role: "assistant", content: "Your next meeting is at 3pm." },
    { role: "user", content: "schedule a meeting for tomorrow" },
    { role: "assistant", content: `I've ${BUILD_ACK_MARKER} for you.` },
    { role: "user", content: "build a weather tool" },
  ]),
  "UI-RS1: 'schedule a meeting' in prior user turn resets session → false",
);
assert(
  !classifyBuildFollowUp("also add caching", [
    { role: "assistant", content: "Here are your emails." },
    { role: "user", content: "check my email" },
    { role: "assistant", content: `I've ${BUILD_ACK_MARKER} for you.` },
    { role: "user", content: "build a weather tool" },
  ]),
  "UI-RS2: 'check my email' in prior user turn resets session → false",
);

// Genuine build refinements must NOT be blocked by UNRELATED_INTENT_PATTERNS
// (regression guard — phrasing about email/calendar in a build context must not trip)
assert(
  classifyBuildFollowUp("now add validation", historyWithAck()),
  "UI-NM1: 'now add validation' still routes to build (control) → true",
);
assert(
  classifyBuildFollowUp("also add error handling", historyWithAck()),
  "UI-NM2: 'also add error handling' still routes to build (control) → true",
);
assert(
  classifyBuildFollowUp("add retry logic", historyWithAck()),
  "UI-NM3: 'add retry logic' still routes to build (control) → true",
);

// ─────────────────────────────────────────────────────────────────────────────
// classifyBuildResume — core resume-phrase detection
// ─────────────────────────────────────────────────────────────────────────────

function historyWithSuspendedBuild(): Array<{ role: string; content: string }> {
  // Simulates: build started → topic change → unrelated reply (newest-first)
  return [
    { role: "assistant", content: "Here are your emails: ..." },
    { role: "user", content: "check my email" },
    { role: "assistant", content: `Got it — I've ${BUILD_ACK_MARKER}. I'll notify you when the new tool is ready.` },
    { role: "user", content: "build me a weather lookup tool" },
  ];
}

// Positive cases — resume phrase + prior ack → true
assert(
  classifyBuildResume("back to the build", historyWithSuspendedBuild()),
  "BR-1: 'back to the build' with prior ack → true",
);
assert(
  classifyBuildResume("let's continue the build", historyWithSuspendedBuild()),
  "BR-2: 'let's continue the build' with prior ack → true",
);
assert(
  classifyBuildResume("ok let's resume", historyWithSuspendedBuild()),
  "BR-3: 'ok let's resume' with prior ack → true",
);
assert(
  classifyBuildResume("continue where we left off", historyWithSuspendedBuild()),
  "BR-4: 'continue where we left off' with prior ack → true",
);
assert(
  classifyBuildResume("pick up where we left off", historyWithSuspendedBuild()),
  "BR-5: 'pick up where we left off' with prior ack → true",
);
assert(
  classifyBuildResume("let's get back to the build", historyWithSuspendedBuild()),
  "BR-6: 'let's get back to the build' with prior ack → true",
);
assert(
  classifyBuildResume("resume the feature", historyWithSuspendedBuild()),
  "BR-7: 'resume the feature' with prior ack → true",
);
assert(
  classifyBuildResume("where were we with the build", historyWithSuspendedBuild()),
  "BR-8: 'where were we with the build' with prior ack → true",
);
assert(
  classifyBuildResume("back to the tool", historyWithSuspendedBuild()),
  "BR-9: 'back to the tool' with prior ack → true",
);
assert(
  classifyBuildResume("back to building", historyWithSuspendedBuild()),
  "BR-10: 'back to building' with prior ack → true",
);

// Negative cases — no ack in history → false (no session to resume)
assert(
  !classifyBuildResume("back to the build", historyWithoutAck()),
  "BR-N1: 'back to the build' with no prior ack → false",
);
assert(
  !classifyBuildResume("continue where we left off", []),
  "BR-N2: resume phrase with empty history → false",
);

// Negative cases — non-resume phrases with an ack → false
assert(
  !classifyBuildResume("where were we", historyWithSuspendedBuild()),
  "BR-N3a: bare 'where were we' without build noun → false (too ambiguous without context)",
);
assert(
  !classifyBuildResume("ok continue", historyWithSuspendedBuild()),
  "BR-N3b: 'ok continue' without 'let's' → false (too ambiguous without context)",
);
assert(
  !classifyBuildResume("check my email", historyWithSuspendedBuild()),
  "BR-N3: unrelated phrase with ack → false",
);
assert(
  !classifyBuildResume("now add retry logic", historyWithSuspendedBuild()),
  "BR-N4: refinement phrase is not a resume signal → false",
);
assert(
  !classifyBuildResume("", historyWithSuspendedBuild()),
  "BR-N5: empty message → false",
);

// ─────────────────────────────────────────────────────────────────────────────
// findBuildDescription — extracts what was being built
// ─────────────────────────────────────────────────────────────────────────────

assert(
  findBuildDescription(historyWithSuspendedBuild()) === "build me a weather lookup tool",
  "FBD-1: extracts the user message that preceded the ack",
);

assert(
  findBuildDescription([]) === "your previous build request",
  "FBD-2: empty history → generic fallback",
);

assert(
  findBuildDescription(historyWithoutAck()) === "your previous build request",
  "FBD-3: no ack in history → generic fallback",
);

// Long message should be truncated to 120 chars
const longDesc = "build me a ".padEnd(200, "x");
assert(
  findBuildDescription([
    { role: "assistant", content: `Got it — I've ${BUILD_ACK_MARKER}.` },
    { role: "user", content: longDesc },
  ]).length <= 120,
  "FBD-4: very long build description is truncated to ≤120 chars",
);

// ─────────────────────────────────────────────────────────────────────────────
// Integration: resume ack re-activates classifyBuildFollowUp on next turn
// ─────────────────────────────────────────────────────────────────────────────

// After a resume ack (which embeds BUILD_ACK_MARKER), the next refinement
// message should be routed by classifyBuildFollowUp as if in an active session.
const resumeAck = `Back to it — I've already queued that build job for that. We were working on: "build me a weather lookup tool". What would you like to change or add?`;
assert(
  classifyBuildFollowUp("now add retry logic", [
    { role: "assistant", content: resumeAck },
    { role: "user", content: "back to the build" },
    { role: "assistant", content: "Here are your emails." },
    { role: "user", content: "check my email" },
    { role: "assistant", content: `Got it — I've ${BUILD_ACK_MARKER}. I'll notify you when the new tool is ready.` },
    { role: "user", content: "build me a weather lookup tool" },
  ]),
  "INT-1: refinement after resume ack is routed as a build follow-up → true",
);

// ─────────────────────────────────────────────────────────────────────────────
// classifyQueryIntent — research phrases (must return "research")
// ─────────────────────────────────────────────────────────────────────────────

assert(
  classifyQueryIntent("search for the latest AI papers") === "research",
  "QI-R1: 'search for the latest AI papers' → research",
);
assert(
  classifyQueryIntent("look up the TypeScript docs") === "research",
  "QI-R2: 'look up the TypeScript docs' → research",
);
assert(
  classifyQueryIntent("lookup best practices for React") === "research",
  "QI-R3: 'lookup best practices for React' → research",
);
assert(
  classifyQueryIntent("google how to reverse a linked list") === "research",
  "QI-R4: 'google how to reverse a linked list' → research",
);
assert(
  classifyQueryIntent("find me an article about climate change") === "research",
  "QI-R5: 'find me an article about climate change' → research",
);
assert(
  classifyQueryIntent("browse to github.com and show me the readme") === "research",
  "QI-R6: 'browse to github.com' → research",
);
assert(
  classifyQueryIntent("research the history of the Roman Empire") === "research",
  "QI-R7: 'research the history of the Roman Empire' → research",
);
assert(
  classifyQueryIntent("investigate why the server is slow") === "research",
  "QI-R8: 'investigate why the server is slow' → research",
);
assert(
  classifyQueryIntent("there is a link here https://example.com") === "research",
  "QI-R9: message containing a URL → research",
);
assert(
  classifyQueryIntent("open https://news.ycombinator.com for me") === "research",
  "QI-R10: bare https:// URL in message → research",
);
assert(
  classifyQueryIntent("fetch the documentation from that page") === "research",
  "QI-R11: 'fetch the documentation' → research",
);
assert(
  classifyQueryIntent("scrape the product listing from that website") === "research",
  "QI-R12: 'scrape the product listing' → research",
);
assert(
  classifyQueryIntent("crawl this site and extract all headings") === "research",
  "QI-R13: 'crawl this site' → research",
);
assert(
  classifyQueryIntent("what is quantum computing?") === "research",
  "QI-R14: 'what is quantum computing?' → research",
);
assert(
  classifyQueryIntent("what are the best practices for TypeScript?") === "research",
  "QI-R15: 'what are the best practices for TypeScript?' → research",
);
assert(
  classifyQueryIntent("who is the CEO of Apple?") === "research",
  "QI-R16: 'who is the CEO of Apple?' → research",
);
assert(
  classifyQueryIntent("where is the Eiffel Tower located?") === "research",
  "QI-R17: 'where is the Eiffel Tower located?' → research",
);
assert(
  classifyQueryIntent("how does photosynthesis work?") === "research",
  "QI-R18: 'how does photosynthesis work?' → research",
);
assert(
  classifyQueryIntent("how do I set up a PostgreSQL database?") === "research",
  "QI-R19: 'how do I set up a PostgreSQL database?' → research",
);
assert(
  classifyQueryIntent("explain the difference between TCP and UDP") === "research",
  "QI-R20: 'explain the difference between TCP and UDP' → research",
);
assert(
  classifyQueryIntent("define the term 'idempotent'") === "research",
  "QI-R21: 'define the term idempotent' → research",
);
assert(
  classifyQueryIntent("tell me about the history of the internet") === "research",
  "QI-R22: 'tell me about the history of the internet' → research",
);
assert(
  classifyQueryIntent("youtube video about meditation techniques") === "research",
  "QI-R23: 'youtube video about meditation' → research",
);
assert(
  classifyQueryIntent("watch the latest video from this channel") === "research",
  "QI-R24: 'watch the latest video' → research",
);
assert(
  classifyQueryIntent("get the transcript of this video") === "research",
  "QI-R25: 'get the transcript of this video' → research",
);
assert(
  classifyQueryIntent("summarize this article for me") === "research",
  "QI-R26: 'summarize this article' → research",
);
assert(
  classifyQueryIntent("latest news about SpaceX") === "research",
  "QI-R27: 'latest news about SpaceX' → research",
);
assert(
  classifyQueryIntent("news about the upcoming election") === "research",
  "QI-R28: 'news about the upcoming election' → research",
);
assert(
  classifyQueryIntent("read about the new iPhone release") === "research",
  "QI-R29: 'read about the new iPhone release' → research",
);
assert(
  classifyQueryIntent("show me the source for that claim") === "research",
  "QI-R30: 'show me the source' → research",
);
assert(
  classifyQueryIntent("find the documentation for this library") === "research",
  "QI-R31: 'find the documentation for this library' → research",
);
assert(
  classifyQueryIntent("where can I find the docs for Expo Router?") === "research",
  "QI-R32: 'find the docs for Expo Router' → research",
);

// ─────────────────────────────────────────────────────────────────────────────
// classifyQueryIntent — general phrases (must return "general")
// ─────────────────────────────────────────────────────────────────────────────

assert(
  classifyQueryIntent("remind me to call John at 3pm") === "general",
  "QI-G1: 'remind me to call John at 3pm' → general",
);
assert(
  classifyQueryIntent("set a reminder for tomorrow morning") === "general",
  "QI-G2: 'set a reminder for tomorrow morning' → general",
);
assert(
  classifyQueryIntent("add a task to review the proposal") === "general",
  "QI-G3: 'add a task to review the proposal' → general",
);
assert(
  classifyQueryIntent("show me my tasks for today") === "general",
  "QI-G4: 'show me my tasks for today' → general",
);
assert(
  classifyQueryIntent("mark the gym task as done") === "general",
  "QI-G5: 'mark the gym task as done' → general",
);
assert(
  classifyQueryIntent("what meetings do I have today?") === "general",
  "QI-G6: 'what meetings do I have today?' → general",
);
assert(
  classifyQueryIntent("schedule a call with Alice for Friday") === "general",
  "QI-G7: 'schedule a call with Alice for Friday' → general",
);
assert(
  classifyQueryIntent("what's on my calendar this week?") === "general",
  "QI-G8: 'what's on my calendar this week?' → general",
);
assert(
  classifyQueryIntent("check my email") === "general",
  "QI-G9: 'check my email' → general",
);
assert(
  classifyQueryIntent("send a message to my team") === "general",
  "QI-G10: 'send a message to my team' → general",
);
assert(
  classifyQueryIntent("I'm feeling stressed today") === "general",
  "QI-G11: 'I'm feeling stressed today' → general (conversational)",
);
assert(
  classifyQueryIntent("how am I doing with my goals?") === "general",
  "QI-G12: 'how am I doing with my goals?' → general (coaching check-in)",
);
assert(
  classifyQueryIntent("hey, good morning!") === "general",
  "QI-G13: greeting → general",
);
assert(
  classifyQueryIntent("thanks, that's all for now") === "general",
  "QI-G14: sign-off phrase → general",
);
assert(
  classifyQueryIntent("can you help me prioritise my day?") === "general",
  "QI-G15: 'prioritise my day' → general (planning, not research)",
);
assert(
  classifyQueryIntent("log a reflection about my morning routine") === "general",
  "QI-G16: 'log a reflection' → general",
);
assert(
  classifyQueryIntent("what should I focus on this afternoon?") === "general",
  "QI-G17: 'what should I focus on this afternoon?' → general",
);
assert(
  classifyQueryIntent("block 2 hours on my calendar for deep work") === "general",
  "QI-G18: 'block 2 hours on my calendar' → general",
);

// ─────────────────────────────────────────────────────────────────────────────
// classifyQueryIntent — edge cases
// ─────────────────────────────────────────────────────────────────────────────

assert(
  classifyQueryIntent("") === "general",
  "QI-E1: empty string → general",
);
assert(
  classifyQueryIntent("   ") === "general",
  "QI-E2: whitespace-only string → general",
);
assert(
  classifyQueryIntent("\t\n") === "general",
  "QI-E3: tab and newline only → general",
);

// Mixed intent: message combines a research signal with a task/calendar request.
// The research pattern should win (any match → "research").
assert(
  classifyQueryIntent("remind me to read this article https://example.com") === "research",
  "QI-MX1: URL in a reminder message → research (URL pattern wins)",
);
assert(
  classifyQueryIntent("remind me to search for flights later") === "research",
  "QI-MX2: 'search' keyword in a reminder → research (search pattern wins)",
);
assert(
  classifyQueryIntent("add a task to look up the pricing page") === "research",
  "QI-MX3: 'look up' embedded in a task request → research",
);
assert(
  classifyQueryIntent("what is the meeting about?") === "research",
  "QI-MX4: 'what is' pattern fires even in meeting context → research",
);

// Case-insensitivity checks
assert(
  classifyQueryIntent("SEARCH for the latest news") === "research",
  "QI-CI1: uppercase SEARCH → research (case-insensitive)",
);
assert(
  classifyQueryIntent("YouTube video about productivity") === "research",
  "QI-CI2: mixed-case YouTube → research",
);
assert(
  classifyQueryIntent("What Is machine learning?") === "research",
  "QI-CI3: 'What Is' mixed case → research",
);

// ── Print summary ─────────────────────────────────────────────────────────────
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log("All queryClassifier assertions passed ✓");
} else {
  process.exit(1);
}
