// Tool registry — compatibility shim over the capability module system.
//
// This file preserves its original exported API and file structure so that
// all existing callers and the buildFeatureTool auto-patcher continue to work.
//
// buildFeatureTool.ts finds patch points by string search:
//   "export const ALL_TOOLS" + closing "\n];"
//   "telegramCoachTools(" + closing "\n  ];"
//   "export {" + closing "\n};"
// These literal structures are preserved below.
//
// The initial tool list, Google-gated set, and tool-group map are all derived
// from the CapabilityRegistry so each capability module owns its own data.
// Tools generated dynamically by the build_feature agent tool are appended to
// the literal arrays below (after the registry spread) by the patcher, keeping
// them as the authoritative addition point without touching capability modules.

// ── Capability registration ────────────────────────────────────────────────────
// Importing from capabilities/index guarantees registration side effects run
// before any registry method is called (single, safe import entry point).
import { capabilityRegistry } from "../../capabilities/index";

import type { AgentTool } from "../types";

// ── Individual tool imports — kept for the export { ... } compatibility block ─
// and for direct variable references inside telegramCoachTools.
// These tool files are also imported by capability modules; Node's module cache
// ensures each file is evaluated exactly once. No circular deps: individual
// tool files never import from this index.
import { webSearchTool, researchTopicTool } from "./webSearch";
import { gmailActionTool, gmailDraftTool } from "./gmailActions";
import { manageTasksTool } from "./manageTasks";
import { createDocumentTool, listDocumentsTool, readDocumentTool } from "./documents";
import { exportDocumentPdfTool } from "./exportPdf";
import { createPresentationTool } from "./createPresentation";
import { driveCreateFileTool, driveListFilesTool, driveReadFileTool } from "./googleDriveTools";
import { fetchCalendarTool } from "./calendar";
import { spawnSubagentTool } from "./spawnSubagent";
import { daemonActionTool } from "./daemon";
import {
  ANDROID_PHONE_RUNTIME_TOOL_NAMES,
  androidCaptureScreenTool,
  androidNotifyUserTool,
  androidOpenAppByNameTool,
  androidOpenPhoneUrlTool,
  androidPhoneRuntimeTools,
  androidPressPhoneKeyTool,
  androidReadNotificationsTool,
  androidOpenNotificationTool,
  androidReadScreenContextTool,
  androidReturnToJarvisChatTool,
  androidSwipeScreenTool,
  androidTapScreenTool,
  androidTypeTextTool,
  androidWaitForUiTool,
  androidYoutubeSearchTool,
} from "./androidAppRuntime";
import { daemonShellTool, daemonStatusTool, androidScreenUnderstandTool, androidSearchInAppTool, androidTypeInFieldTool, androidTapElementTool, androidSwipeElementTool, androidPinchElementTool, androidPinchCoordinatesTool, androidTrainButtonTool, androidFindTrainedButtonTool, androidTypeIntoElementTool, androidLongPressElementTool, androidDragElementTool, androidDragCoordinatesTool, androidFillFormTool, androidScrollToTopTool, androidSelectOptionTool } from "./daemonShellTool";
import { checkConnectionsTool, generateReconnectLinkTool } from "./connections";
import {
  connectedAccountsConnectLinkTool,
  connectedAccountsExecuteTool,
  connectedAccountsGetToolSchemaTool,
  connectedAccountsListTool,
  connectedAccountsSearchToolsTool,
} from "./connectedAccounts";
import { createCalendarEventTool } from "./calendarCreate";
import { sendEmailTool } from "./sendEmail";
import { fetchEmailsTool } from "./fetchEmails";
import { connectChannelTool } from "./connectChannel";
import { startProjectTool } from "./startProject";
import { manageProjectTool } from "./manageProject";
import { discordPostTool } from "./discordPost";
import { discordCreateChannelTool } from "./discordCreateChannel";
import { discordRequestConfirmTool } from "./discordRequestConfirm";
import { discordDeleteChannelTool } from "./discordDeleteChannel";
import { discordListChannelsTool } from "./discordListChannels";
import { scheduleJarvisTaskTool } from "./scheduleJarvisTask";
import {
  scheduleChannelReportTool,
  listChannelSchedulesTool,
  deleteChannelScheduleTool,
} from "./scheduleChannelReport";
import { youtubeSearchTool } from "./youtubeSearch";
import { youtubeTranscriptTool } from "./youtubeTranscript";
import { videoTranscriptTool } from "./videoTranscript";
import { xSearchTool } from "./xSearch";
import { registerApprovalTool } from "./registerApproval";
import { discordPinMessageTool } from "./discordPinMessage";
import { discordSendToChannelTool } from "./discordSendToChannel";
import { setupNamedAgentTool } from "./setupNamedAgent";
import { queueBackgroundJobTool } from "./queueBackgroundJob";
import { setupContentPipelineTool } from "./setupContentPipeline";
import { setupDiscordWorkspaceTool } from "./setupDiscordWorkspace";
import { memorySearchTool, memoryGetTool, memorySaveTool } from "./memorySearch";
import { soulEditProposeTool } from "./soulEdit";
import { webFetchTool } from "./webFetch";
import { weatherLookupTool } from "./weatherLookup";
import { sessionsListTool, sessionsHistoryTool, sessionsSendTool, sessionsCancelTool } from "./sessionTools";
import { speakTool } from "./tts";
import { imageGenerateTool } from "./imageGenerate";
import { videoGenerateTool } from "./videoGenerate";
import { cronCreateTool, cronListTool, cronDeleteTool, cronUpdateTool } from "./cronTools";
import {
  workflowCreateTool,
  workflowRunTool,
  workflowStatusTool,
  workflowPauseTool,
  workflowResumeTool,
  workflowListTool,
} from "./workflowTools";
import {
  browserNavigateTool,
  browserClickTool,
  browserTypeTool,
  browserScreenshotTool,
  browserExtractTool,
  browserCloseTool,
  browserSnapshotTool,
  browserWaitForTool,
  browserSelectTool,
  browserClearSessionTool,
  browserEvaluateTool,
  browserScrollTool,
  browserHoverTool,
  browserDragTool,
  browserCheckTool,
  browserUncheckTool,
  browserChooseFileTool,
  browserNavigateBackTool,
  browserNavigateForwardTool,
  browserReloadTool,
  browserGetCookiesTool,
  browserSetCookiesTool,
  browserDeleteCookiesTool,
  browserNetworkRequestsTool,
  browserConsoleMessagesTool,
  browserTabNewTool,
  browserTabListTool,
  browserTabSelectTool,
  browserTabCloseTool,
  browserToolPassthrough,
} from "./browserTools";
import {
  buildFeatureTool,
  testToolTool,
  initToolResolver,
} from "./buildFeatureTool";
import { selfDiagnoseTool } from "./selfDiagnoseTool";
import { runGapAnalysisTool } from "./runGapAnalysisTool";
import { listSourceFilesTool, readSourceFileTool, proposeCodeChangeTool } from "./selfEditTools";
import { applyCodeChangeTool } from "./applyCodeChangeTool";
import { runShellTool } from "./runShellTool";
import { selfHealTool } from "./selfHealTool";
import { workspaceUpdateTool } from "./workspaceUpdateTool";
import { livingContextUpdateTool } from "./livingContextUpdateTool";
import { listCustomAgentsTool } from "./listCustomAgents";
import { runTournamentTool } from "./runTournamentTool";
import { listGithubPrsTool, getGithubPrTool, mergeGithubPrTool } from "./githubPrTools";
import { projectShellTool, projectWriteFileTool } from "./projectShellTool";
import { deployAppTool } from "./deployApp";
import { delegateToCodexTool } from "./delegateToCodex";

// ── Tool Groups ────────────────────────────────────────────────────────────────
// Each group represents a functional capability cluster. Channels declare which
// groups they need and the harness call-site filters ALL_TOOLS accordingly.

export type ToolGroup =
  | "coaching"    // manage_tasks, queue_background_job, daemon_action
  | "calendar"    // fetch_calendar, create_calendar_event  (Google-gated)
  | "email"       // gmail_action, create_gmail_draft (Google-gated), send_email, fetch_emails
  | "memory"      // memory_search, memory_get, memory_save
  | "documents"   // create/list/read_document, drive_* (Google-gated)
  | "research"    // web_search, research_topic, web_fetch, youtube_search, x_search
  | "discord"     // discord_post, discord_manage, schedule_channel_report, setup_content_pipeline
  | "scheduling"  // schedule_jarvis_task, cron_*, workflow_*
  | "browser"     // browser_navigate, browser_click, …
  | "system"      // spawn_subagent, sessions_*, register_approval, build_feature, test_tool
  | "self_edit"   // list_source_files, read_source_file, propose_code_change
  | "media"       // speak, image_generate, generate_video, get_youtube_transcript, transcribe_video_url
  | "connections" // check_connections, generate_reconnect_link, connect_channel
  | "mcp"         // auto-discovered tools from connected MCP servers
  | "compute"     // run_python — sandboxed code execution
  | "github"      // list_github_prs, get_github_pr, merge_github_pr
  | "app_build"   // project_shell/project_write_file — sandboxed standalone app project tools

// ── Registry-derived data (single source of truth for capability tools) ────────
// GOOGLE_GATED and TOOL_GROUP_MAP come entirely from the capability registry.
// ALL_TOOLS is seeded from the registry; dynamic tools (from build_feature)
// are appended to the literal array below by buildFeatureTool file-patching.

const GOOGLE_GATED: Set<string> = capabilityRegistry.getGoogleGatedNames();
const TOOL_GROUP_MAP: Record<string, string[]> = capabilityRegistry.buildToolGroupMap();

// ── filterToolsByGroups ────────────────────────────────────────────────────────
/**
 * Return the subset of ALL_TOOLS whose groups intersect `requestedGroups`.
 * Google-gated tools are only included when `hasGoogle` is true.
 */
export function filterToolsByGroups(
  requestedGroups: ToolGroup[],
  hasGoogle = false,
): AgentTool[] {
  const groupSet = new Set<string>(requestedGroups);
  return ALL_TOOLS.filter((tool) => {
    if (GOOGLE_GATED.has(tool.name) && !hasGoogle) return false;
    const toolGroups = TOOL_GROUP_MAP[tool.name];
    if (!toolGroups) return false; // unmapped tools are excluded from scoped bundles
    return toolGroups.some((g) => groupSet.has(g));
  });
}

// ── ALL_TOOLS ──────────────────────────────────────────────────────────────────
// Seeded from the registry; buildFeatureTool appends new dynamic tools before
// the closing `];` via file-patching. Registry tools come from the spread;
// dynamically generated tools are appended after it in the literal array.
export const ALL_TOOLS: AgentTool[] = [
  ...capabilityRegistry.getAllTools(),
  listCustomAgentsTool,
  runTournamentTool,
  projectShellTool,
  projectWriteFileTool,
  deployAppTool,
];

// ── Tool index + resolver ──────────────────────────────────────────────────────
const TOOL_INDEX = new Map(ALL_TOOLS.map((t) => [t.name, t]));

// Register custom-agent tools in the group map so filterToolsByGroups includes them.
TOOL_GROUP_MAP[listCustomAgentsTool.name] = ["coaching"];
TOOL_GROUP_MAP[runTournamentTool.name] = ["system"];
TOOL_GROUP_MAP[projectShellTool.name] = ["app_build"];
TOOL_GROUP_MAP[projectWriteFileTool.name] = ["app_build"];
TOOL_GROUP_MAP[deployAppTool.name] = ["app_build", "coaching"];

// Wire the resolver so testToolTool can look up tools without a circular import.
initToolResolver((name) => TOOL_INDEX.get(name));

export function getTool(name: string): AgentTool | undefined {
  return TOOL_INDEX.get(name);
}

/**
 * Register MCP tools discovered post-startup into ALL_TOOLS, TOOL_INDEX, and
 * TOOL_GROUP_MAP so that filterToolsByGroups picks them up for channel-scoped
 * tool lists.  Called once from server/index.ts after mcpServerRegistry.start().
 */
export function registerMcpTools(tools: AgentTool[]): void {
  for (const tool of tools) {
    if (!TOOL_INDEX.has(tool.name)) {
      ALL_TOOLS.push(tool);
      TOOL_INDEX.set(tool.name, tool);
      TOOL_GROUP_MAP[tool.name] = ["mcp"];
    }
  }
}

// ── telegramCoachTools ────────────────────────────────────────────────────────
// Tool bundle for the Telegram coach loop (excludes spawn_subagent).
// The `base` array is seeded from the registry, then google-gated tools are
// conditionally appended. buildFeatureTool adds dynamic tools before `\n  ];`.
export function telegramCoachTools(opts: { hasGoogle: boolean }): AgentTool[] {
  const base: AgentTool[] = [
    ...capabilityRegistry.getAllTools().filter(
      (t) => t.name !== "spawn_subagent" && !GOOGLE_GATED.has(t.name)
    ),
    listCustomAgentsTool,
    runTournamentTool,
    deployAppTool,
  ];
  if (opts.hasGoogle) {
    base.push(gmailActionTool, gmailDraftTool, fetchCalendarTool, driveCreateFileTool, driveListFilesTool, driveReadFileTool);
  }
  return base;
}

// ── Individual re-exports (compatibility layer) ────────────────────────────────
// Other modules import specific tools from this file; preserve every export.
export {
  webSearchTool,
  researchTopicTool,
  gmailActionTool,
  gmailDraftTool,
  fetchCalendarTool,
  createCalendarEventTool,
  manageTasksTool,
  createDocumentTool,
  listDocumentsTool,
  readDocumentTool,
  driveCreateFileTool,
  driveListFilesTool,
  driveReadFileTool,
  spawnSubagentTool,
  daemonActionTool,
  ANDROID_PHONE_RUNTIME_TOOL_NAMES,
  androidOpenAppByNameTool,
  androidYoutubeSearchTool,
  androidOpenPhoneUrlTool,
  androidCaptureScreenTool,
  androidReadScreenContextTool,
  androidTapScreenTool,
  androidTypeTextTool,
  androidSwipeScreenTool,
  androidPressPhoneKeyTool,
  androidWaitForUiTool,
  androidReadNotificationsTool,
  androidOpenNotificationTool,
  androidNotifyUserTool,
  androidReturnToJarvisChatTool,
  androidPhoneRuntimeTools,
  daemonShellTool,
  daemonStatusTool,
  androidScreenUnderstandTool,
  androidSearchInAppTool,
  androidTypeInFieldTool,
  androidTapElementTool,
  androidSwipeElementTool,
  androidPinchElementTool,
  androidPinchCoordinatesTool,
  androidLongPressElementTool,
  androidDragElementTool,
  androidDragCoordinatesTool,
  androidScrollToTopTool,
  androidSelectOptionTool,
  androidTrainButtonTool,
  androidFindTrainedButtonTool,
  androidTypeIntoElementTool,
  androidFillFormTool,
  checkConnectionsTool,
  generateReconnectLinkTool,
  connectedAccountsListTool,
  connectedAccountsConnectLinkTool,
  connectedAccountsSearchToolsTool,
  connectedAccountsGetToolSchemaTool,
  connectedAccountsExecuteTool,
  sendEmailTool,
  fetchEmailsTool,
  connectChannelTool,
  discordRequestConfirmTool,
  discordPostTool,
  discordCreateChannelTool,
  discordDeleteChannelTool,
  discordListChannelsTool,
  scheduleJarvisTaskTool,
  scheduleChannelReportTool,
  listChannelSchedulesTool,
  deleteChannelScheduleTool,
  registerApprovalTool,
  discordPinMessageTool,
  discordSendToChannelTool,
  setupNamedAgentTool,
  youtubeSearchTool,
  youtubeTranscriptTool,
  videoTranscriptTool,
  xSearchTool,
  queueBackgroundJobTool,
  startProjectTool,
  manageProjectTool,
  setupContentPipelineTool,
  setupDiscordWorkspaceTool,
  memorySearchTool,
  memoryGetTool,
  memorySaveTool,
  soulEditProposeTool,
  webFetchTool,
  weatherLookupTool,
  sessionsListTool,
  sessionsHistoryTool,
  sessionsSendTool,
  sessionsCancelTool,
  speakTool,
  cronCreateTool,
  cronListTool,
  cronDeleteTool,
  cronUpdateTool,
  workflowCreateTool,
  workflowRunTool,
  workflowStatusTool,
  workflowPauseTool,
  workflowResumeTool,
  workflowListTool,
  browserNavigateTool,
  browserClickTool,
  browserTypeTool,
  browserScreenshotTool,
  browserExtractTool,
  browserCloseTool,
  browserSnapshotTool,
  browserWaitForTool,
  browserSelectTool,
  browserClearSessionTool,
  browserEvaluateTool,
  browserScrollTool,
  browserHoverTool,
  browserDragTool,
  browserCheckTool,
  browserUncheckTool,
  browserChooseFileTool,
  browserNavigateBackTool,
  browserNavigateForwardTool,
  browserReloadTool,
  browserGetCookiesTool,
  browserSetCookiesTool,
  browserDeleteCookiesTool,
  browserNetworkRequestsTool,
  browserConsoleMessagesTool,
  browserTabNewTool,
  browserTabListTool,
  browserTabSelectTool,
  browserTabCloseTool,
  browserToolPassthrough,
  buildFeatureTool,
  testToolTool,
  imageGenerateTool,
  videoGenerateTool,
  selfDiagnoseTool,
  runGapAnalysisTool,
  exportDocumentPdfTool,
  createPresentationTool,
  listSourceFilesTool,
  readSourceFileTool,
  proposeCodeChangeTool,
  applyCodeChangeTool,
  runShellTool,
  selfHealTool,
  workspaceUpdateTool,
  livingContextUpdateTool,
  listCustomAgentsTool,
  runTournamentTool,
  listGithubPrsTool,
  getGithubPrTool,
  mergeGithubPrTool,
  projectShellTool,
  projectWriteFileTool,
  deployAppTool,
  delegateToCodexTool,
};
