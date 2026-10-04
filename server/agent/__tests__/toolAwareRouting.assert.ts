import {
  classifyToolAwareConversationRoute,
  classifyToolAwareRoute,
  getToolMetadataRoutingText,
  selectRelevantToolNames,
} from "../toolAwareRouting";
import type { ToolAwareRoutePlan } from "../toolAwareRouting";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`ok - ${label}`);
    passed++;
  } else {
    console.error(`not ok - ${label}`);
    failed++;
  }
}

function assertRoute(
  text: string,
  intent: string,
  expectedGroups: Array<ToolAwareRoutePlan["toolGroups"][number]>,
  expectedTools: string[],
): void {
  const plan = classifyToolAwareRoute(text);
  assert(plan.shouldPreferTool, `${intent}: prefers tool use`);
  assert(plan.intents.includes(intent as any), `${intent}: intent detected`);
  for (const group of expectedGroups) {
    assert(plan.toolGroups.includes(group), `${intent}: includes ${group} group`);
  }
  for (const tool of expectedTools) {
    assert(plan.priorityToolNames.includes(tool), `${intent}: prioritizes ${tool}`);
  }
}

{
  const plan = classifyToolAwareConversationRoute([
    { role: "user", content: "I need a dentist appointment next Tuesday" },
    { role: "assistant", content: "Would you like me to schedule that calendar appointment?" },
    { role: "user", content: "Yes, please." },
  ]);
  assert(plan.shouldPreferTool, "contextual confirmation: preserves the proposed tool route");
  assert(plan.intents.includes("calendar"), "contextual confirmation: retains calendar intent");
}

{
  const plan = classifyToolAwareConversationRoute([
    { role: "assistant", content: "Would you like a more detailed explanation?" },
    { role: "user", content: "Yes, please." },
  ]);
  assert(!plan.shouldPreferTool, "ordinary contextual confirmation: stays conversational");
}

for (const confirmation of [
  "Absolutely.",
  "Definitely!",
  "Of course.",
  "That would be great.",
  "Let's do it.",
  "Please go ahead.",
  "I'd love that.",
  "Sounds great, thanks.",
]) {
  const plan = classifyToolAwareConversationRoute([
    { role: "assistant", content: "Would you like me to schedule that calendar appointment?" },
    { role: "user", content: confirmation },
  ]);
  assert(plan.intents.includes("calendar"), `contextual confirmation: recognizes ${confirmation}`);
}

for (const conversationalReply of [
  "Please explain how it works.",
  "Sure, explain how reminders work.",
  "Yes, but just explain it.",
]) {
  const plan = classifyToolAwareConversationRoute([
    { role: "assistant", content: "I can set a reminder, or explain how reminders work." },
    { role: "user", content: conversationalReply },
  ]);
  assert(!plan.shouldPreferTool, `contextual confirmation: rejects ambiguous reply ${conversationalReply}`);
}

{
  const plan = classifyToolAwareConversationRoute([
    {
      role: "assistant",
      content: "I will not set a reminder; would you like me to explain how reminders work?",
    },
    { role: "user", content: "Yes, please." },
  ]);
  assert(!plan.shouldPreferTool, "contextual confirmation: does not inherit a negated tool mention");
}

{
  const plan = classifyToolAwareConversationRoute([
    {
      role: "assistant",
      content: "I can schedule that calendar appointment. Would you like me to do that?",
    },
    { role: "user", content: "Yes, please." },
  ]);
  assert(plan.intents.includes("calendar"), "contextual confirmation: resolves a clear referential proposal");
}

for (const retry of ["Retry that.", "Try it once more.", "Give it another shot.", "Run it again."]) {
  const plan = classifyToolAwareConversationRoute([
    { role: "user", content: "Schedule the dentist appointment next Tuesday" },
    { role: "assistant", content: "That action failed." },
    { role: "user", content: retry },
  ]);
  assert(plan.intents.includes("calendar"), `contextual retry: recognizes ${retry}`);
}

{
  const plan = classifyToolAwareConversationRoute([
    { role: "assistant", content: "Would you like me to schedule that calendar appointment?" },
    { role: "user", content: "No, don't do that." },
  ]);
  assert(!plan.shouldPreferTool, "contextual confirmation: respects explicit negation");
}

{
  const plan = classifyToolAwareConversationRoute([
    { role: "user", content: "Schedule the dentist appointment next Tuesday" },
    { role: "assistant", content: "That action failed. I can make another attempt." },
    { role: "user", content: "Try again." },
  ]);
  assert(plan.shouldPreferTool, "contextual retry: recovers the prior tool route");
  assert(plan.intents.includes("calendar"), "contextual retry: retains calendar intent");
}

{
  const plan = classifyToolAwareConversationRoute([
    { role: "user", content: "Check my calendar" },
    { role: "assistant", content: "Your calendar is clear." },
    { role: "user", content: "Tell me a joke" },
    { role: "assistant", content: "I did not catch that. You can try again." },
    { role: "user", content: "Try again." },
  ]);
  assert(!plan.shouldPreferTool, "contextual retry: does not revive a stale tool route");
}

{
  const plan = classifyToolAwareConversationRoute([
    { role: "user", content: "Generate an image of a cat" },
    { role: "assistant", content: "The image tool failed." },
    { role: "user", content: "Try again." },
  ]);
  assert(!plan.intents.includes("diagnostics"), "contextual retry: ignores diagnostic words in failure text");
  assert(!plan.priorityToolNames.includes("jarvis_self_diagnose"), "contextual retry: does not replace the original action with diagnostics");
}

{
  const messages = [
    { role: "user", content: "Generate an image of a cat" },
    { role: "assistant", content: "The image tool failed; I can diagnose what went wrong." },
    { role: "user", content: "Try again." },
  ];
  assert(
    getToolMetadataRoutingText(messages) === "Generate an image of a cat",
    "contextual retry metadata: prefers the original user action",
  );
}

for (const refusal of [
  "I can't set a reminder for tomorrow.",
  "I couldn't set a reminder for tomorrow.",
  "I won't set a reminder for tomorrow.",
]) {
  const plan = classifyToolAwareConversationRoute([
    { role: "assistant", content: refusal },
    { role: "user", content: "Okay." },
  ]);
  assert(!plan.shouldPreferTool, `contextual confirmation: rejects contracted negation ${refusal}`);
}

{
  const plan = classifyToolAwareConversationRoute([
    { role: "assistant", content: "I can see your reminder is scheduled for 3 PM." },
    { role: "user", content: "Okay." },
  ]);
  assert(!plan.shouldPreferTool, "contextual confirmation: rejects descriptive status statements");
}

{
  const relevant = selectRelevantToolNames(
    "Move the Acme card to Done in Trello",
    [
      { name: "mcp__connector_42__action_9", description: "Move a Trello card to another list" },
      { name: "mcp__github__list_pull_requests", description: "List open GitHub pull requests" },
    ],
  );
  assert(relevant.includes("mcp__connector_42__action_9"), "dynamic MCP route: selects matching installed tool metadata");
  assert(!relevant.includes("mcp__github__list_pull_requests"), "dynamic MCP route: excludes unrelated installed tools");
}

{
  const relevant = selectRelevantToolNames(
    "Tell me a short joke",
    [{ name: "mcp__trello__move_card", description: "Move a Trello card to another list" }],
  );
  assert(relevant.length === 0, "ordinary chat: does not enter the dynamic MCP selection loop");
}

{
  const opaqueTool = {
    name: "mcp__connector_42__action_9",
    description: "Archive a Trello card",
  };
  assert(
    selectRelevantToolNames("Archive that card", [opaqueTool]).includes(opaqueTool.name),
    "dynamic MCP route: accepts two meaningful description matches for an opaque name",
  );
  assert(
    selectRelevantToolNames("Tell me about a Trello card", [opaqueTool]).length === 0,
    "dynamic MCP route: rejects noun-only description matches without the action",
  );
}

{
  const conversation = [
    { role: "assistant", content: "Would you like me to archive that Trello card?" },
    { role: "user", content: "Yes, please." },
  ];
  const routingText = getToolMetadataRoutingText(conversation);
  assert(
    selectRelevantToolNames(routingText, [{
      name: "mcp__connector_42__action_9",
      description: "Archive a Trello card",
    }]).includes("mcp__connector_42__action_9"),
    "contextual metadata route: scores the validated assistant proposal",
  );
}

{
  const routingText = getToolMetadataRoutingText([
    {
      role: "assistant",
      content: "I will not archive the card; would you like me to explain Trello?",
    },
    { role: "user", content: "Yes, please." },
  ]);
  assert(routingText === "Yes, please.", "contextual metadata route: rejects negated and explanatory proposals");
}

{
  const offeredTools = [
    { name: "image_generate", description: "Generate an image from a text prompt and display it inline" },
    { name: "connect_channel", description: "Connect Telegram, WhatsApp, Slack, or Discord to Jarvis" },
    { name: "log_goal_progress", description: "Log progress toward a goal" },
  ];
  assert(
    selectRelevantToolNames("Generate an image of a cat", offeredTools).includes("image_generate"),
    "built-in metadata route: selects image generation",
  );
  assert(
    selectRelevantToolNames("Make me a picture of a cat", offeredTools).includes("image_generate"),
    "built-in metadata route: understands image-generation synonyms",
  );
  assert(
    selectRelevantToolNames("Connect my Slack account", offeredTools).includes("connect_channel"),
    "built-in metadata route: selects channel connection",
  );
  assert(
    selectRelevantToolNames("Log progress toward my running goal", offeredTools).includes("log_goal_progress"),
    "built-in metadata route: selects goal progress logging",
  );
}

{
  const addTaskTool = {
    name: "add_task",
    description: "Add a new task to the user's plan for today",
  };
  assert(
    selectRelevantToolNames("Put Buy milk on today's plan", [addTaskTool]).includes("add_task"),
    "built-in metadata route: recognizes put as an add action",
  );
  assert(
    selectRelevantToolNames("What is today's plan?", [addTaskTool]).length === 0,
    "built-in metadata route: keeps noun-only plan questions conversational",
  );
}

{
  const completeTaskTool = {
    name: "complete_task",
    description: "Mark a task as complete in today's plan",
  };
  assert(
    selectRelevantToolNames("Mark Buy milk done", [completeTaskTool]).includes("complete_task"),
    "built-in metadata route: recognizes concise task completion",
  );
}

{
  const exactDiagnostic = "So can you diagnose with the issue is that makes it so that you can't reliably see the entire context history of every message that I sent";
  const plan = classifyToolAwareRoute(exactDiagnostic);
  assert(!plan.shouldPreferTool, "conversation diagnostic: stays on conversation route");
  assert(!plan.intents.includes("email"), "conversation diagnostic: is not classified as email");
  assert(!plan.priorityToolNames.includes("connected_accounts_list"), "conversation diagnostic: does not offer connected accounts");
}
{
  const plan = classifyToolAwareRoute("Send my previous message to Bob");
  assert(plan.shouldPreferTool, "mixed conversation/external request: preserves external action route");
  assert(plan.intents.includes("email"), "mixed conversation/external request: detects communication intent");
  assert(plan.priorityToolNames.includes("connected_accounts_list"), "mixed conversation/external request: offers connected accounts");
}
{
  const plan = classifyToolAwareRoute("Read my unread messages");
  assert(plan.shouldPreferTool, "connected message read: preserves connected-account route");
  assert(plan.intents.includes("email"), "connected message read: detects email intent");
}

assertRoute(
  "what's the weather in Philadelphia tomorrow?",
  "weather",
  ["research"],
  ["weather_lookup"],
);
assertRoute(
  "what's on my calendar today?",
  "calendar",
  ["calendar"],
  ["connected_accounts_list", "connected_accounts_search_tools", "connected_accounts_get_tool_schema", "connected_accounts_execute"],
);
{
  const plan = classifyToolAwareRoute("calendar events for tomorrow");
  assert(plan.intents.includes("calendar"), "private calendar events: intent detected");
  assert(!plan.intents.includes("research"), "private calendar events: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "private calendar events: does not prioritize search_web");
}
{
  const plan = classifyToolAwareRoute("what are my events for Friday?");
  assert(plan.intents.includes("calendar"), "my events: intent detected");
  assert(!plan.intents.includes("research"), "my events: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "my events: does not prioritize search_web");
}
{
  const plan = classifyToolAwareRoute("what events are on my calendar today?");
  assert(plan.intents.includes("calendar"), "events on my calendar: intent detected");
  assert(!plan.intents.includes("research"), "events on my calendar: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "events on my calendar: no search_web");
}
{
  const plan = classifyToolAwareRoute("events on our calendar today");
  assert(plan.intents.includes("calendar"), "events on our calendar: intent detected");
  assert(!plan.intents.includes("research"), "events on our calendar: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "events on our calendar: no search_web");
}
{
  const plan = classifyToolAwareRoute("find my calendar events today");
  assert(plan.intents.includes("calendar"), "find my calendar events: intent detected");
  assert(!plan.intents.includes("research"), "find my calendar events: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "find my calendar events: no search_web");
}
{
  const plan = classifyToolAwareRoute("look up my calendar events today");
  assert(plan.intents.includes("calendar"), "look up my calendar events: intent detected");
  assert(!plan.intents.includes("research"), "look up my calendar events: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "look up my calendar events: no search_web");
}
for (const [query, label] of [
  ["look up my calendar today", "look up bare calendar"],
  ["search my calendar today", "search bare calendar"],
  ["look up my Google Calendar events today", "look up provider calendar"],
  ["look up my work calendar today", "look up named calendar"],
  ["look up my Google Workspace Calendar events today", "look up multiword provider calendar"],
] as const) {
  const plan = classifyToolAwareRoute(query);
  assert(plan.intents.includes("calendar"), `${label}: intent detected`);
  assert(!plan.intents.includes("research"), `${label}: does not route as research`);
  assert(!plan.priorityToolNames.includes("search_web"), `${label}: no search_web`);
}
{
  const plan = classifyToolAwareRoute("look up my school calendar latest update");
  assert(plan.intents.includes("calendar"), "public named calendar update: calendar intent retained");
  assert(plan.intents.includes("research"), "public named calendar update: research intent retained");
  assert(plan.priorityToolNames.includes("search_web"), "public named calendar update: search_web retained");
}
{
  const plan = classifyToolAwareRoute("look up my work calendar latest event");
  assert(plan.intents.includes("calendar"), "private named calendar event: calendar intent detected");
  assert(!plan.intents.includes("research"), "private named calendar event: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "private named calendar event: no search_web");
}
{
  const plan = classifyToolAwareRoute("search the web for how to export my calendar events");
  assert(plan.intents.includes("research"), "explicit web search mentioning calendar events: research intent preserved");
  assert(plan.priorityToolNames.includes("search_web"), "explicit web search mentioning calendar events: search_web preserved");
}
{
  const plan = classifyToolAwareRoute("find my events today");
  assert(plan.intents.includes("calendar"), "find my events: intent detected");
  assert(!plan.intents.includes("research"), "find my events: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "find my events: no search_web");
}
for (const [query, label] of [
  ["find my appointments today", "find my appointments"],
  ["look up my meetings tomorrow", "look up my meetings"],
  ["search our appointments this week", "search our appointments"],
] as const) {
  const plan = classifyToolAwareRoute(query);
  assert(plan.intents.includes("calendar"), `${label}: calendar intent detected`);
  assert(!plan.intents.includes("research"), `${label}: does not route as research`);
  assert(!plan.priorityToolNames.includes("search_web"), `${label}: no search_web`);
}
{
  const plan = classifyToolAwareRoute("what are my calendar events in Philadelphia, PA today");
  assert(plan.intents.includes("calendar"), "calendar location comma: calendar intent detected");
  assert(!plan.intents.includes("research"), "calendar location comma: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "calendar location comma: no search_web");
}
{
  const plan = classifyToolAwareRoute("search my events today");
  assert(plan.intents.includes("calendar"), "search my events: intent detected");
  assert(!plan.intents.includes("research"), "search my events: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "search my events: no search_web");
}
{
  const plan = classifyToolAwareRoute("what's on my schedule today?");
  assert(plan.intents.includes("calendar"), "my schedule: intent detected");
  assert(!plan.intents.includes("research"), "my schedule: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "my schedule: no search_web");
}
{
  const plan = classifyToolAwareRoute("our schedule today");
  assert(plan.intents.includes("calendar"), "our schedule: intent detected");
  assert(!plan.intents.includes("research"), "our schedule: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "our schedule: no search_web");
}
{
  const plan = classifyToolAwareRoute("concerts today in my calendar");
  assert(plan.intents.includes("calendar"), "private event-category calendar: intent detected");
  assert(!plan.intents.includes("research"), "private event-category calendar: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "private event-category calendar: no search_web");
}
{
  const plan = classifyToolAwareRoute("what are my calendar events today and what's today's news?");
  assert(plan.intents.includes("calendar"), "mixed calendar and news: calendar intent detected");
  assert(plan.intents.includes("research"), "mixed calendar and news: research intent preserved");
  assert(plan.priorityToolNames.includes("search_web"), "mixed calendar and news: search_web preserved");
}
for (const [query, label] of [
  ["what are my calendar events today and tell me the latest on Ukraine", "tell-me latest clause"],
  ["what are my calendar events today and give me Ukraine news", "give-me news clause"],
  ["what are my calendar events today and can you show me current TSLA price", "can-you-show current clause"],
  ["what are my calendar events today and find me movie showtimes today", "find-me showtimes clause"],
] as const) {
  const plan = classifyToolAwareRoute(query);
  assert(plan.intents.includes("calendar"), `${label}: calendar intent detected`);
  assert(plan.intents.includes("research"), `${label}: research intent preserved`);
  assert(plan.priorityToolNames.includes("search_web"), `${label}: search_web preserved`);
}
{
  const plan = classifyToolAwareRoute("what are my calendar events today, what's today's news?");
  assert(plan.intents.includes("calendar"), "comma mixed calendar and news: calendar intent detected");
  assert(plan.intents.includes("research"), "comma mixed calendar and news: research intent preserved");
  assert(plan.priorityToolNames.includes("search_web"), "comma mixed calendar and news: search_web preserved");
}
{
  const plan = classifyToolAwareRoute("what are my calendar events in Philadelphia, PA today, what's today's news?");
  assert(plan.intents.includes("calendar"), "location-comma mixed request: calendar intent detected");
  assert(plan.intents.includes("research"), "location-comma mixed request: research intent preserved");
  assert(plan.priorityToolNames.includes("search_web"), "location-comma mixed request: search_web preserved");
}
{
  const plan = classifyToolAwareRoute("what are my calendar events today along with today's news?");
  assert(plan.intents.includes("calendar"), "along-with mixed calendar and news: calendar intent detected");
  assert(plan.intents.includes("research"), "along-with mixed calendar and news: research intent preserved");
  assert(plan.priorityToolNames.includes("search_web"), "along-with mixed calendar and news: search_web preserved");
}
{
  const plan = classifyToolAwareRoute("what are my calendar events today with today's news?");
  assert(plan.intents.includes("calendar"), "with-news mixed calendar and news: calendar intent detected");
  assert(plan.intents.includes("research"), "with-news mixed calendar and news: research intent preserved");
  assert(plan.priorityToolNames.includes("search_web"), "with-news mixed calendar and news: search_web preserved");
}
{
  const plan = classifyToolAwareRoute("what are my calendar events today with the latest on Ukraine");
  assert(plan.intents.includes("calendar"), "with-latest mixed calendar and news: calendar intent detected");
  assert(plan.intents.includes("research"), "with-latest mixed calendar and news: research intent preserved");
  assert(plan.priorityToolNames.includes("search_web"), "with-latest mixed calendar and news: search_web preserved");
}
for (const [query, label] of [
  ["what are my calendar events today with what's happening in Ukraine today", "with-contraction research clause"],
  ["what are my calendar events today with what is happening in Ukraine today", "with-expanded research clause"],
  ["what are my calendar events today with what happened in Ukraine today", "with-past research clause"],
  ["what are my calendar events today with Disney today", "with-generic public today clause"],
  ["what are my calendar events today with spacex today", "with-lowercase public today clause"],
] as const) {
  const plan = classifyToolAwareRoute(query);
  assert(plan.intents.includes("calendar"), `${label}: calendar intent detected`);
  assert(plan.intents.includes("research"), `${label}: research intent preserved`);
  assert(plan.priorityToolNames.includes("search_web"), `${label}: search_web preserved`);
}
{
  const plan = classifyToolAwareRoute("what are my calendar events today with Ukraine news");
  assert(plan.intents.includes("calendar"), "topic-news mixed request: calendar intent detected");
  assert(plan.intents.includes("research"), "topic-news mixed request: research intent preserved");
  assert(plan.priorityToolNames.includes("search_web"), "topic-news mixed request: search_web preserved");
}
{
  const plan = classifyToolAwareRoute("what are my calendar events today with traffic on I-95 today");
  assert(plan.intents.includes("calendar"), "traffic mixed request: calendar intent detected");
  assert(plan.intents.includes("research"), "traffic mixed request: research intent preserved");
  assert(plan.priorityToolNames.includes("search_web"), "traffic mixed request: search_web preserved");
}
{
  const plan = classifyToolAwareRoute("what are my calendar events today with air quality in Philadelphia today");
  assert(plan.intents.includes("calendar"), "air-quality mixed request: calendar intent detected");
  assert(plan.intents.includes("research"), "air-quality mixed request: research intent preserved");
  assert(plan.priorityToolNames.includes("search_web"), "air-quality mixed request: search_web preserved");
}
{
  const plan = classifyToolAwareRoute("what are my calendar events today with TSLA price today");
  assert(plan.intents.includes("calendar"), "price mixed request: calendar intent detected");
  assert(plan.intents.includes("research"), "price mixed request: research intent preserved");
  assert(plan.priorityToolNames.includes("search_web"), "price mixed request: search_web preserved");
}
{
  const plan = classifyToolAwareRoute("what are my calendar events today with concerts in Philadelphia today");
  assert(plan.intents.includes("calendar"), "public-events mixed request: calendar intent detected");
  assert(plan.intents.includes("research"), "public-events mixed request: research intent preserved");
  assert(plan.priorityToolNames.includes("search_web"), "public-events mixed request: search_web preserved");
}
{
  const plan = classifyToolAwareRoute("what are my calendar events today with movie showtimes today");
  assert(plan.intents.includes("calendar"), "showtimes mixed request: calendar intent detected");
  assert(plan.intents.includes("research"), "showtimes mixed request: research intent preserved");
  assert(plan.priorityToolNames.includes("search_web"), "showtimes mixed request: search_web preserved");
}
{
  const plan = classifyToolAwareRoute("what are my calendar events today with OpenAI today");
  assert(plan.intents.includes("calendar"), "public-shorthand mixed request: calendar intent detected");
  assert(plan.intents.includes("research"), "public-shorthand mixed request: research intent preserved");
  assert(plan.priorityToolNames.includes("search_web"), "public-shorthand mixed request: search_web preserved");
}
{
  const plan = classifyToolAwareRoute("what are my calendar events today with TSLA today");
  assert(plan.intents.includes("calendar"), "ticker-shorthand mixed request: calendar intent detected");
  assert(plan.intents.includes("research"), "ticker-shorthand mixed request: research intent preserved");
  assert(plan.priorityToolNames.includes("search_web"), "ticker-shorthand mixed request: search_web preserved");
}
{
  const plan = classifyToolAwareRoute("what are my calendar events today? what's today's news?");
  assert(plan.intents.includes("calendar"), "sentence mixed calendar and news: calendar intent detected");
  assert(plan.intents.includes("research"), "sentence mixed calendar and news: research intent preserved");
  assert(plan.priorityToolNames.includes("search_web"), "sentence mixed calendar and news: search_web preserved");
}
{
  const plan = classifyToolAwareRoute("what are my calendar events with Justin today?");
  assert(plan.intents.includes("calendar"), "private calendar with attendee: calendar intent detected");
  assert(!plan.intents.includes("research"), "private calendar with attendee: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "private calendar with attendee: no search_web");
}
assertRoute(
  "check my Gmail and unread email",
  "email",
  ["email"],
  ["connected_accounts_list", "connected_accounts_search_tools", "connected_accounts_get_tool_schema", "connected_accounts_execute"],
);
assertRoute(
  "Can you remind me in an hour to call the company?",
  "reminder",
  ["coaching", "scheduling"],
  ["schedule_jarvis_task"],
);
{
  const plan = classifyToolAwareRoute('Can you add "Make $140 on DoorDash" as a recurring task every day?');
  assert(plan.shouldPreferTool, "human task ontology: prefers tool use for user task recording");
  assert(plan.actionType === "user_task", "human task ontology: actionType=user_task");
  assert(plan.actor === "user", "human task ontology: actor=user");
  assert(plan.approvalRequired === false, "human task ontology: no approval required");
  assert(plan.priorityToolNames.includes("schedule_jarvis_task"), "human task ontology: uses schedule_jarvis_task");
  assert(plan.actionReason.includes("user") || plan.actionReason.includes("human"), "human task ontology: reason explains ownership");
}
{
  const plan = classifyToolAwareRoute("Drive to Walmart and buy printer paper");
  assert(plan.shouldPreferTool, "blocked physical: uses focused no-tool route");
  assert(plan.actionType === "blocked_physical_action", "blocked physical: actionType");
  assert(plan.blockedToolNames.includes("daemon_action"), "blocked physical: daemon blocked");
  assert(plan.priorityToolNames.length === 0, "blocked physical: no priority tools");
}
{
  const plan = classifyToolAwareRoute("draft an email in Gmail to wickedclown.jb@gmail.com");
  const legacyTools = ["fetch_emails", "gmail_action", "create_gmail_draft", "send_email"];
  assert(plan.intents.includes("email"), "email gateway: intent detected");
  for (const tool of legacyTools) {
    assert(!plan.priorityToolNames.includes(tool), `email gateway: does not prioritize ${tool}`);
  }
}
{
  const plan = classifyToolAwareRoute("schedule a meeting on my calendar tomorrow");
  const legacyTools = ["fetch_calendar", "create_calendar_event"];
  assert(plan.intents.includes("calendar"), "calendar gateway: intent detected");
  for (const tool of legacyTools) {
    assert(!plan.priorityToolNames.includes(tool), `calendar gateway: does not prioritize ${tool}`);
  }
}
assertRoute(
  "what do you remember about my work hours?",
  "memory",
  ["memory"],
  ["memory_search", "memory_get", "memory_save"],
);
assertRoute(
  "What's my name?",
  "memory",
  ["memory"],
  ["memory_search", "memory_get"],
);
assertRoute(
  "Who am I?",
  "memory",
  ["memory"],
  ["memory_search", "memory_get"],
);
{
  const plan = classifyToolAwareRoute("Who am I meeting tomorrow?");
  assert(plan.intents.includes("calendar"), "calendar: who-am-I continuation stays calendar");
  assert(!plan.intents.includes("memory"), "memory: who-am-I continuation does not route as identity memory");
}
assertRoute(
  "Remember that Justin Battles is my personal name.",
  "memory",
  ["memory"],
  ["memory_save"],
);
for (const [query, label] of [
  ["Yes, great. Those should all be memories saved", "referential plural save"],
  ["Those memories should all be saved", "post-noun modal plural save"],
  ["That memory should be stored", "post-noun modal singular save"],
  ["These memories need to be recorded", "post-noun necessity save"],
  ["This memory must be kept", "post-noun required save"],
  ["Save those as memories", "save referential memories"],
  ["Add all of that to memory", "add conversation context to memory"],
  ["Commit this to memory", "commit referential context to memory"],
  ["Commit this fact to memory", "commit explicit fact to memory"],
  ["Please commit that detail to your memory", "polite commit detail to Jarvis memory"],
  ["Commit what I said to memory", "commit prior statement to memory"],
  ["Those should all be committed to memory", "passive committed context to memory"],
  ["Remember I live in Philadelphia", "imperative remember fact"],
  ["Please remember I prefer dark mode", "polite remember fact"],
  ["I want you to remember I work nights", "embedded want-to remember fact"],
  ["I need you to remember Sarah is my sister", "embedded need-to remember relationship"],
  ["I would like Jarvis to remember my favorite color is green", "embedded would-like remember preference"],
  ["I'd like you to remember that I speak Spanish", "contracted embedded remember fact"],
  ["Make sure you remember our trip is in May", "make-sure remember shared fact"],
  ["Recall that Sarah is my sister", "imperative recall relationship"],
  ["Please recall that I work nights", "polite imperative recall fact"],
  ["Recall that I speak Spanish", "general first-person recall fact"],
  ["Recall that Sarah is my aunt", "general relationship recall fact"],
  ["Recall that my favorite color is green", "possessive preference recall fact"],
  ["Recall I work nights", "imperative recall fact without complementizer"],
  ["Please recall Sarah is my sister", "polite recall relationship without complementizer"],
  ["Jarvis, recall I speak Spanish", "vocative recall fact"],
  ["Hey, Jarvis, please recall Sarah is my aunt", "greeting vocative polite recall relationship"],
  ["Could you please recall Sarah is my sister?", "directed polite recall relationship"],
  ["I want you to recall I work nights", "embedded recall fact"],
  ["I need Jarvis to recall Sarah is my sister", "embedded Jarvis recall relationship"],
  ["Make sure you recall my favorite color is green", "make-sure recall preference"],
  ["Could you remember that I work nights?", "directed remember request"],
  ["Remember I hate cilantro", "general first-person remember fact"],
  ["Please remember I speak Spanish", "general polite first-person fact"],
  ["Remember we prefer dark mode", "plural first-person remember fact"],
  ["Those should all be saved as memories", "passive plural referential save"],
  ["That should be stored in memory", "passive singular referential save"],
  ["Remember Sarah is my sister", "named relationship remember fact"],
  ["Jarvis, remember Sarah is my sister", "vocative remember fact"],
  ["Hey, Jarvis, remember Sarah is my sister", "greeting and vocative remember fact"],
  ["Hi, remember Sarah is my sister", "punctuated greeting remember fact"],
  ["Please, remember Sarah is my sister", "punctuated polite remember fact"],
  ["Save the fact that Sarah is my sister to memory", "stated fact saved to memory"],
  ["Store Sarah is my sister in memory", "personal fact stored in memory"],
  ["Save this conversation to memory", "current conversation saved to memory"],
  ["Store our chat in memory", "shared chat stored in memory"],
  ["Save that I'm allergic to peanuts to memory", "contracted personal fact saved to memory"],
  ["Save that I speak Spanish to memory", "unlisted personal speech predicate save"],
  ["Store that I study French in memory", "unlisted personal study predicate save"],
  ["Save my birthday to memory", "possessive birthday save"],
  ["Store my wife's birthday in memory", "relationship-possessive birthday save"],
  ["Commit my daughter's phone number to memory", "relationship-possessive phone save"],
  ["Save my parents' address to memory", "plural relationship-possessive address save"],
  ["Store my parents' phone number in memory", "plural relationship-possessive phone save"],
  ["Save my parents’ birthdays to memory", "curly plural relationship-possessive birthday save"],
  ["Commit our grandparents' address to memory", "shared plural relationship-possessive address save"],
  ["Save my kids' birthdays to memory", "kids plural-possessive birthday save"],
  ["Store my kids’ phone number in memory", "curly kids plural-possessive phone save"],
  ["Commit my kid's birthday to memory", "kid singular-possessive birthday save"],
  ["Save our grandkids' address to memory", "grandkids plural-possessive address save"],
  ["Store my grandchildren’s birthdays in memory", "curly grandchildren possessive birthday save"],
  ["Save my brothers' birthdays to memory", "brothers plural-possessive birthday save"],
  ["Store my sisters’ phone numbers in memory", "curly sisters plural-possessive phone save"],
  ["Commit our partners' schedules to memory", "partners plural-possessive schedule save"],
  ["Save my wives' birthdays to memory", "irregular wives plural-possessive birthday save"],
  ["Store my bosses' phone numbers in memory", "bosses plural-possessive phone save"],
  ["Save my grandmothers' birthdays to memory", "grandmothers plural-possessive birthday save"],
  ["Store my children's birthdays in memory", "irregular relationship-possessive birthday save"],
  ["Save our address in memory", "shared possessive address save"],
  ["Save this in your memory", "referential save into Jarvis memory"],
  ["Store that in your memory", "referential store into Jarvis memory"],
  ["That should be stored in your memory", "passive referential store into Jarvis memory"],
  ["Put this in your memory", "referential put into Jarvis memory"],
  ["Record that in your memory", "referential record into Jarvis memory"],
  ["Can you add this new memory now?", "modifier-aware new-memory save"],
  ["Can you record this specific memory now?", "modifier-aware recorded memory"],
] as const) {
  const plan = classifyToolAwareRoute(query);
  assert(plan.shouldPreferTool, `${label}: prefers tool use`);
  assert(plan.intents.includes("memory"), `${label}: memory intent detected`);
  assert(plan.toolGroups.includes("memory"), `${label}: includes memory group`);
  assert(plan.priorityToolNames.includes("memory_save"), `${label}: exposes memory_save`);
}
for (const [query, label] of [
  ["Tell me what you remember about Sarah", "requested remembered-person summary"],
  ["Show me what you remember about my business", "requested remembered-business summary"],
  ["What do you remember about our trip?", "direct remembered-trip lookup"],
  ["What do you recall about Sarah?", "direct recalled-person lookup"],
  ["Do you recall anything about Sarah?", "indefinite recalled-person lookup"],
  ["Can you recall Sarah?", "named recall lookup"],
  ["Can you recall Sarah's birthday?", "possessive qualified recall lookup"],
  ["Can you recall Sarah from accounting?", "relationship qualified recall lookup"],
  ["What personal preferences do you have saved for me?", "saved personal-preference lookup"],
  ["Show me the preferences I saved", "user-saved preference lookup"],
  ["What are my saved preferences?", "possessive saved-preference lookup"],
  ["Search your memory for Sarah", "search Jarvis memory"],
  ["Read your memories about my business", "read Jarvis memories"],
  ["Do you have any memories of Sarah?", "existential person-memory lookup"],
  ["Do you have any saved memories about our trip?", "existential saved-memory lookup"],
  ["Have you got a memory of my first job?", "have-got singular-memory lookup"],
] as const) {
  const plan = classifyToolAwareRoute(query);
  assert(plan.intents.includes("memory"), `${label}: memory intent detected`);
  assert(plan.priorityToolNames.includes("memory_search"), `${label}: exposes memory_search`);
}
for (const [query, label] of [
  ["How are memories formed?", "general memory science"],
  ["Tell me a childhood memory story", "non-personal story request"],
  ["Are memories stored in the brain?", "general passive storage question"],
  ["Explain computer memory", "technical memory topic"],
  ["Fix this memory leak", "software memory leak"],
  ["Keep computer memory usage low", "computer memory instruction"],
  ["Make a memory matching game", "creative memory concept"],
  ["Keep this memory usage low", "determiner in technical memory phrase"],
  ["Make this memory matching game accessible", "determiner in creative memory phrase"],
  ["Keep this computer memory usage low", "modified technical memory phrase"],
  ["Make this virtual memory simulator accessible", "modified virtual-memory phrase"],
  ["Save the buffer to memory", "technical buffer write"],
  ["Write the decoded image into memory", "technical image write"],
  ["Save the buffer as a memory", "technical buffer-as-memory write"],
  ["Save my buffer to memory", "owned technical buffer write"],
  ["Save the buffer I decoded to memory", "technical relative-clause buffer write"],
  ["Write our process image into memory", "owned technical process-image write"],
  ["Change this memory limit to 8 GB", "technical memory limit correction"],
  ["Edit the memory address", "technical memory address correction"],
  ["Fix that memory leak", "technical memory leak correction"],
  ["Update the memory allocation", "technical memory allocation correction"],
  ["Correct the memory mapping", "technical memory mapping correction"],
  ["Change the memory setting", "technical memory setting correction"],
  ["Add this new memory card to the device", "technical memory-card addition"],
  ["Edit this specific memory address", "modified technical memory-address correction"],
  ["Record that in process memory", "technical process-memory record"],
  ["Put this in virtual memory", "technical virtual-memory write"],
  ["Put this in your memory buffer", "referential technical memory-buffer write"],
  ["Record that in the memory cache", "referential technical memory-cache record"],
  ["Commit this buffer to memory", "technical buffer commit to memory"],
  ["Recall this memory allocation model", "technical recall-this request"],
  ["Recall that TypeScript uses structural typing", "explanatory TypeScript recall"],
  ["Recall that HTTP is stateless", "explanatory HTTP recall"],
  ["Please recall that JavaScript uses an event loop", "polite explanatory recall"],
  ["Recall TypeScript uses structural typing", "explanatory recall without complementizer"],
  ["Please recall HTTP is stateless", "polite explanatory recall without complementizer"],
  ["Hey, Jarvis, recall this memory allocation model", "vocative technical recall"],
  ["Could you recall TypeScript uses structural typing?", "directed explanatory recall"],
  ["I want you to recall TypeScript uses structural typing", "embedded explanatory recall"],
  ["I want you to recall to update my dependencies", "embedded recall-to dependency task"],
  ["Make sure Jarvis recall to clear our cache", "make-sure recall-to cache task"],
  ["Please recall to clear our cache", "anchored recall-to cache task"],
  ["Could you please recall to update my dependencies?", "directed recall-to dependency task"],
  ["Please recall not to clear our cache", "anchored recall-not-to cache task"],
  ["Could you recall never to share my password?", "directed recall-never-to task"],
  ["I want you to remember TypeScript uses structural typing", "embedded explanatory remember"],
  ["I need you to remember this memory allocation algorithm", "embedded technical remember"],
  ["Make sure you remember HTTP is stateless", "make-sure explanatory remember"],
  ["I want you to remember to update my dependencies", "embedded remember-to dependency task"],
  ["Could you remember to update my dependencies?", "directed remember-to dependency task"],
  ["Would you remember not to share my password?", "directed remember-not-to task"],
  ["Please remember to clear our cache", "anchored remember-to cache task"],
  ["Jarvis, remember never to share my password", "vocative remember-never-to task"],
  ["Make sure you remember to clear our cache", "embedded remember-to cache task"],
  ["I'd like you to remember to call my dentist", "embedded remember-to personal task"],
  ["I want you to remember not to update my dependencies", "embedded remember-not-to dependency task"],
  ["Make sure you remember not to clear our cache", "embedded remember-not-to cache task"],
  ["I'd like you to remember never to share my password", "embedded remember-never-to task"],
  ["Save my buffer to memory", "technical possessive buffer save"],
  ["Store my cache in memory", "technical possessive cache save"],
  ["Save my parents' buffer to memory", "plural-owned technical buffer save"],
  ["Store our coworkers' cache in memory", "plural-owned technical cache save"],
  ["Save my kids' buffer to memory", "kids-owned technical buffer save"],
  ["Save my brothers' buffer to memory", "brothers-owned technical buffer save"],
  ["Do you have any memory allocation data?", "technical existential memory-allocation query"],
  ["Have you got any memory buffer metrics?", "technical have-got memory-buffer query"],
  ["Use this memory store for sessions", "technical memory-store noun"],
  ["Inspect this memory record", "technical memory-record noun"],
] as const) {
  const plan = classifyToolAwareRoute(query);
  assert(!plan.intents.includes("memory"), `${label}: does not detect personal memory intent`);
  assert(!plan.toolGroups.includes("memory"), `${label}: does not expose the memory group`);
  assert(!plan.priorityToolNames.includes("memory_save"), `${label}: does not expose memory_save`);
}
for (const [query, label] of [
  ["Correct the memory about Bud Runner", "correct memory"],
  ["Update what you remember about my business", "update remembered context"],
  ["That memory should be changed", "referential memory edit"],
  ["That memory is wrong", "declarative wrong-memory correction"],
  ["That memory isn't right", "contracted negative correction"],
  ["Your memory about Sarah isn't correct", "qualified contracted negative correction"],
  ["That memory's wrong", "contracted copula correction"],
  ["This memory’s outdated", "curly-apostrophe contracted correction"],
  ["The memory about Sarah is wrong", "qualified definite-memory correction"],
  ["Your memory about Sarah is outdated", "qualified owned-memory correction"],
  ["This memory of my job is inaccurate", "qualified memory-of correction"],
  ["That memory for our business is not quite right", "qualified shared-memory soft correction"],
  ["This memory is inaccurate", "declarative inaccurate-memory correction"],
  ["What you remember about my job is wrong", "declarative remembered-context correction"],
  ["What you know about my job is wrong", "declarative personal-knowledge correction"],
  ["Correct what you know about my job", "imperative personal-knowledge correction"],
  ["Update what you know about our business", "imperative shared-knowledge correction"],
  ["Hey, no, please change the memory.", "conversational definite-memory correction"],
  ["Edit that memory, you have it wrong.", "referential edit with trailing explanation"],
  ["Hey, change that memory, it\'s not quite right.", "conversational edit with soft correction"],
  ["Please fix this memory.", "polite referential correction"],
  ["Update my memory about Sarah.", "owned-memory correction"],
  ["You have that memory wrong.", "second-person wrong-memory correction"],
  ["You got the memory completely wrong.", "second-person definite-memory correction"],
  ["That memory you saved is inaccurate.", "saved-memory declarative correction"],
  ["The memory is not quite right.", "soft declarative correction"],
  ["Can you change an old memory about me?", "old personal-memory correction"],
  ["Can you edit this specific, exact memory that I\'m referring to?", "modifier-aware referential correction"],
  ["Please correct the inaccurate memory about Sarah.", "descriptive personal-memory correction"],
  ["One of your memories is wrong", "partitive owned-memory correction"],
  ["One of your saved memories about Sarah is inaccurate", "qualified partitive saved-memory correction"],
] as const) {
  const plan = classifyToolAwareRoute(query);
  assert(plan.shouldPreferTool, `${label}: prefers tool use`);
  assert(plan.intents.includes("memory"), `${label}: memory intent detected`);
  assert(plan.priorityToolNames.includes("memory_search"), `${label}: exposes memory_search`);
  assert(plan.priorityToolNames.includes("memory_save"), `${label}: exposes memory_save`);
}
{
  const plan = classifyToolAwareRoute("That memory is wrong");
  assert(plan.guidance.includes("otherwise ask the user for the corrected content and do not call memory_save"), "correction without replacement: asks for corrected content after search");
}
{
  const plan = classifyToolAwareRoute("What you know about TypeScript is wrong");
  assert(!plan.intents.includes("memory"), "general knowledge correction: does not detect personal memory intent");
  assert(!plan.toolGroups.includes("memory"), "general knowledge correction: does not expose memory tools");
}
{
  const plan = classifyToolAwareRoute("What you know about my job is accurate. TypeScript is wrong");
  assert(!plan.intents.includes("memory"), "separate-sentence correction: does not detect personal memory intent");
  assert(!plan.toolGroups.includes("memory"), "separate-sentence correction: does not expose memory tools");
}
{
  const plan = classifyToolAwareRoute("Fix this TypeScript error. What you know about my job is accurate.");
  assert(!plan.intents.includes("memory"), "separate imperative command: does not detect personal memory intent");
  assert(!plan.toolGroups.includes("memory"), "separate imperative command: does not expose memory tools");
}
assertRoute(
  "open github.com in the browser",
  "browser",
  ["browser"],
  ["browser_navigate"],
);
assertRoute(
  "Can you search up Cannabis News 2026?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "search up calendar events in Philadelphia today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "What's today's cannabis news?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what's the current TSLA price?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what's the current version of Node.js?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what's the current exchange rate for USD/EUR?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what is the current traffic on I-95?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what is the current air quality in Philadelphia?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
for (const query of [
  "what is the current time in London?",
  "current timezone in Tokyo",
  "what time is it in Paris now?",
  "current time London",
  "current time london",
  "local time Tokyo",
  "local time tokyo",
  "Current time New York",
  "local timezone Tokyo",
] as const) {
  assertRoute(
    query,
    "research",
    ["research", "browser"],
    ["search_web", "research_topic", "browser_navigate"],
  );
}
{
  const plan = classifyToolAwareRoute("what is my current time?");
  assert(!plan.intents.includes("research"), "personal current time: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "personal current time: does not prioritize web search");
}
for (const [query, label] of [
  ["current time", "bare current time"],
  ["current time now", "current device time"],
  ["local time here", "local device location time"],
  ["current time please", "polite current time request"],
  ["current time for me", "personal current time request"],
  ["current time on my phone", "phone current time request"],
] as const) {
  const plan = classifyToolAwareRoute(query);
  assert(!plan.intents.includes("research"), `${label}: does not route as research`);
  assert(!plan.priorityToolNames.includes("search_web"), `${label}: does not prioritize web search`);
}
for (const query of [
  "what are the current McDonald's hours?",
  "current Dave & Buster's hours",
  "current Dave & Buster’s hours",
] as const) {
  assertRoute(
    query,
    "research",
    ["research", "browser"],
    ["search_web", "research_topic", "browser_navigate"],
  );
}
assertRoute(
  "air quality in Philadelphia today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "traffic on I-95 today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "events in Philadelphia today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "events in Philadelphia, PA today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "concerts in Philadelphia today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "concerts in Philadelphia, PA today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "comedy shows near Philadelphia tonight",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "concerts today in Philadelphia",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "concerts today in Philadelphia, PA",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "comedy shows tonight near Philadelphia",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
for (const query of [
  "are there concerts today?",
  "any movies tonight?",
  "is there a concert tomorrow?",
  "are there any workshops this weekend?",
] as const) {
  assertRoute(
    query,
    "research",
    ["research", "browser"],
    ["search_web", "research_topic", "browser_navigate"],
  );
}
{
  const plan = classifyToolAwareRoute("are there meetings today?");
  assert(!plan.intents.includes("research"), "prefixed personal meetings: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "prefixed personal meetings: does not prioritize web search");
}
assertRoute(
  "movies today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "new movies today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "concerts tonight",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "workshops this weekend",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "calendar events for Philadelphia today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "latest court ruling",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "current Supreme Court ruling",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what happened today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what's going on today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what\u2019s going on today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what's new today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what's new with OpenAI today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "how is TSLA doing today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "How is Boeing doing today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "how is boeing doing today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what happened in Ukraine today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what did OpenAI announce today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "What did Disney announce today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what did disney announce today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what did the president say today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what's happening with TSLA today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "how is the stock market today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what stocks are up today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what is the current BTC/USD price?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "current USD/EUR exchange rate",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "current S&P 500 price",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what's the current S&P 500?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "current nasdaq",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "current TSLA",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
for (const query of ["Ukraine articles", "cannabis articles"] as const) {
  assertRoute(
    query,
    "research",
    ["research", "browser"],
    ["search_web", "research_topic", "browser_navigate"],
  );
}
{
  const plan = classifyToolAwareRoute("my articles");
  assert(!plan.intents.includes("research"), "owned articles: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "owned articles: does not prioritize web search");
}
for (const query of ["trump today", "spacex today"] as const) {
  assertRoute(
    query,
    "research",
    ["research", "browser"],
    ["search_web", "research_topic", "browser_navigate"],
  );
}
for (const query of [
  "recent studies on GLP-1",
  "latest papers about sleep",
  "recent GLP-1 studies",
  "latest AI preprints",
] as const) {
  assertRoute(
    query,
    "research",
    ["research", "browser"],
    ["search_web", "research_topic", "browser_navigate"],
  );
}
for (const query of ["current usd/eur", "current gbp-jpy", "usd/eur today", "gbp-jpy today"] as const) {
  assertRoute(
    query,
    "research",
    ["research", "browser"],
    ["search_web", "research_topic", "browser_navigate"],
  );
}
for (const query of ["scores today", "prices today", "polls today", "standings today"] as const) {
  assertRoute(
    query,
    "research",
    ["research", "browser"],
    ["search_web", "research_topic", "browser_navigate"],
  );
}
for (const query of [
  "covid cases today",
  "power outage today",
  "current covid cases",
  "latest power outages",
] as const) {
  assertRoute(
    query,
    "research",
    ["research", "browser"],
    ["search_web", "research_topic", "browser_navigate"],
  );
}
{
  const plan = classifyToolAwareRoute("schedule today?");
  assert(!plan.intents.includes("research"), "bare personal schedule: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "bare personal schedule: does not prioritize web search");
}
{
  const plan = classifyToolAwareRoute("my cases today?");
  assert(!plan.intents.includes("research"), "owned cases shorthand: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "owned cases shorthand: does not prioritize web search");
}
assertRoute(
  "watch the latest video from this channel",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "latest Lakers score",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what's today's TSLA price?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what's today's exchange rate for USD/EUR?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "today's Lakers score",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "today\u2019s Lakers score",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "today's NBA schedule",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what are today's games?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
for (const query of [
  "Lakers vs Celtics today",
  "Yankees at Dodgers today",
  "lakers versus celtics tonight",
] as const) {
  assertRoute(
    query,
    "research",
    ["research", "browser"],
    ["search_web", "research_topic", "browser_navigate"],
  );
}
{
  const plan = classifyToolAwareRoute("my team vs their team today?");
  assert(!plan.intents.includes("research"), "private matchup shorthand: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "private matchup shorthand: does not prioritize web search");
}
assertRoute(
  "who is playing today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "are the Eagles playing today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "do the Eagles play today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "did the Lakers win today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "who won today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "who won today's Lakers game?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "Who is the current president of Mexico?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what's the latest in Ukraine?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "Ukraine latest",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "OpenAI latest",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "latest developments in Ukraine",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "current situation in Ukraine",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what's the latest with Ukraine?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what's the latest with OpenAI?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "latest OpenAI",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "latest OpenAI model",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "latest docs for React",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "current API documentation for Stripe",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "latest React docs",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "latest Ukraine",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "Ukraine today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "OpenAI today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "Trump today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "Disney today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "Nintendo Switch today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "nintendo switch today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "latest openai",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "latest ukraine",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "ukraine today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "openai today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "watch the latest from this channel",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what's the latest from OpenAI?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "current CEO of Nvidia",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "cannabis news",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "TSLA price today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "TSLA today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "tsla today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "BTC/USD today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "btc/usd today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "s&p 500 today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "nasdaq today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "mortgage rates today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "flight delays today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "are flights delayed today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "movie showtimes today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what are the movie showtimes today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "movie times today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "screening times today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "movie showtimes near Philadelphia tonight",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "is Walmart open today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "is the Starbucks open today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "is the post office open today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "Walmart open today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "SEPTA delayed today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "septa delayed today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "chipotle open today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "is McDonald's open today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "is Dave & Buster\u2019s open today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "Walmart hours today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "McDonald's hours today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "are banks open today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
for (const query of [
  "school open today?",
  "school delayed today?",
  "schools closed today?",
  "Philadelphia schools delayed today?",
] as const) {
  assertRoute(
    query,
    "research",
    ["research", "browser"],
    ["search_web", "research_topic", "browser_navigate"],
  );
}
assertRoute(
  "Lakers score today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "news",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "headlines",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "today\u2019s top stories",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "top stories today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "latest stories",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "today's Ukraine stories",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "Ukraine stories today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "stories about Ukraine today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "today's Wordle answer",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "today\u2019s horoscope",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "today's NYT Connections answer",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "Ukraine headlines today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "what's the price of TSLA today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "score of Lakers today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "CEO of Nvidia today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "who is the president of Mexico today?",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
assertRoute(
  "court decision today",
  "research",
  ["research", "browser"],
  ["search_web", "research_topic", "browser_navigate"],
);
{
  const plan = classifyToolAwareRoute("Hey Jarvis how are you doing today");
  assert(!plan.shouldPreferTool, "casual today greeting: does not prefer tool use");
  assert(!plan.intents.includes("research"), "casual today greeting: does not route as research");
  assert(plan.priorityToolNames.length === 0, "casual today greeting: no priority tools");
}
{
  const plan = classifyToolAwareRoute("Hello today");
  assert(!plan.shouldPreferTool, "casual hello today: does not prefer tool use");
  assert(!plan.intents.includes("research"), "casual hello today: does not route as research");
  assert(plan.priorityToolNames.length === 0, "casual hello today: no priority tools");
}
for (const [query, label] of [
  ["Busy today?", "auto-capitalized busy status"],
  ["Tired today?", "auto-capitalized tired status"],
  ["School today?", "personal school shorthand"],
] as const) {
  const plan = classifyToolAwareRoute(query);
  assert(!plan.shouldPreferTool, `${label}: does not prefer tool use`);
  assert(!plan.intents.includes("research"), `${label}: does not route as research`);
  assert(!plan.priorityToolNames.includes("search_web"), `${label}: does not prioritize web search`);
}
{
  const plan = classifyToolAwareRoute("Hey Jarvis today");
  assert(!plan.shouldPreferTool, "casual hey Jarvis today: does not prefer tool use");
  assert(!plan.intents.includes("research"), "casual hey Jarvis today: does not route as research");
  assert(plan.priorityToolNames.length === 0, "casual hey Jarvis today: no priority tools");
}
{
  const plan = classifyToolAwareRoute("how are you doing today?");
  assert(!plan.shouldPreferTool, "casual how are you: does not prefer tool use");
  assert(!plan.intents.includes("research"), "casual how are you: does not route as research");
  assert(plan.priorityToolNames.length === 0, "casual how are you: no priority tools");
}
{
  const plan = classifyToolAwareRoute("how is Sarah doing now?");
  assert(!plan.shouldPreferTool, "personal status question: does not prefer tool use");
  assert(!plan.intents.includes("research"), "personal status question: does not route as research");
  assert(plan.priorityToolNames.length === 0, "personal status question: no priority tools");
}
{
  const plan = classifyToolAwareRoute("how is Sarah doing today?");
  assert(!plan.shouldPreferTool, "personal today status question: does not prefer tool use");
  assert(!plan.intents.includes("research"), "personal today status question: does not route as research");
  assert(plan.priorityToolNames.length === 0, "personal today status question: no priority tools");
}
{
  const plan = classifyToolAwareRoute("how is mom doing now?");
  assert(!plan.shouldPreferTool, "family status question: does not prefer tool use");
  assert(!plan.intents.includes("research"), "family status question: does not route as research");
  assert(plan.priorityToolNames.length === 0, "family status question: no priority tools");
}
{
  const plan = classifyToolAwareRoute("are you playing today?");
  assert(!plan.shouldPreferTool, "casual playing question: does not prefer tool use");
  assert(!plan.intents.includes("research"), "casual playing question: does not route as research");
  assert(plan.priorityToolNames.length === 0, "casual playing question: no priority tools");
}
for (const [query, label] of [
  ["does she play tomorrow?", "third-person singular play follow-up"],
  ["do they play tomorrow?", "third-person plural play follow-up"],
  ["is he playing tonight?", "third-person playing follow-up"],
  ["did they win yesterday?", "third-person result follow-up"],
] as const) {
  const plan = classifyToolAwareRoute(query);
  assert(!plan.intents.includes("research"), `${label}: does not route as research`);
  assert(!plan.priorityToolNames.includes("search_web"), `${label}: does not prioritize web search`);
}
{
  const plan = classifyToolAwareRoute("does my son play tomorrow?");
  assert(!plan.intents.includes("research"), "family play schedule: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "family play schedule: does not prioritize web search");
}
{
  const plan = classifyToolAwareRoute("is my kid playing tonight?");
  assert(!plan.intents.includes("research"), "owned child playing status: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "owned child playing status: does not prioritize web search");
}
{
  const plan = classifyToolAwareRoute("are our children playing today?");
  assert(!plan.intents.includes("research"), "shared family playing status: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "shared family playing status: does not prioritize web search");
}
{
  const plan = classifyToolAwareRoute("did my daughter win today?");
  assert(!plan.intents.includes("research"), "family result question: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "family result question: does not prioritize web search");
}
{
  const plan = classifyToolAwareRoute("is it open today?");
  assert(!plan.shouldPreferTool, "contextual open question: does not prefer tool use");
  assert(!plan.intents.includes("research"), "contextual open question: does not route as research");
  assert(plan.priorityToolNames.length === 0, "contextual open question: no priority tools");
}
{
  const plan = classifyToolAwareRoute("are you open today?");
  assert(!plan.shouldPreferTool, "casual are-you-open question: does not prefer tool use");
  assert(!plan.intents.includes("research"), "casual are-you-open question: does not route as research");
  assert(plan.priorityToolNames.length === 0, "casual are-you-open question: no priority tools");
}
{
  const plan = classifyToolAwareRoute("will you be open tomorrow?");
  assert(!plan.shouldPreferTool, "casual will-you-be-open question: does not prefer tool use");
  assert(!plan.intents.includes("research"), "casual will-you-be-open question: does not route as research");
  assert(plan.priorityToolNames.length === 0, "casual will-you-be-open question: no priority tools");
}
{
  const plan = classifyToolAwareRoute("leave the garage door open now");
  assert(!plan.intents.includes("research"), "local open action: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "local open action: does not prioritize web search");
}
{
  const plan = classifyToolAwareRoute("I currently need help");
  assert(!plan.intents.includes("research"), "first-person currently statement: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "first-person currently statement: does not prioritize web search");
}
{
  const plan = classifyToolAwareRoute("I now have time");
  assert(!plan.intents.includes("research"), "first-person now statement: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "first-person now statement: does not prioritize web search");
}
{
  const plan = classifyToolAwareRoute("is my garage door open now?");
  assert(!plan.intents.includes("research"), "owned open-status question: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "owned open-status question: does not prioritize web search");
}
{
  const plan = classifyToolAwareRoute("is our office open today?");
  assert(!plan.intents.includes("research"), "shared open-status question: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "shared open-status question: does not prioritize web search");
}
{
  const plan = classifyToolAwareRoute("is your garage door open now?");
  assert(!plan.intents.includes("research"), "second-person owned status: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "second-person owned status: does not prioritize web search");
}
{
  const plan = classifyToolAwareRoute("is their office open today?");
  assert(!plan.intents.includes("research"), "third-person owned status: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "third-person owned status: does not prioritize web search");
}
{
  const plan = classifyToolAwareRoute("is the garage door open now?");
  assert(!plan.intents.includes("research"), "definite local open-status question: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "definite local open-status question: does not prioritize web search");
}
{
  const plan = classifyToolAwareRoute("is the window open now?");
  assert(!plan.intents.includes("research"), "local window status: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "local window status: does not prioritize web search");
}
for (const [query, label] of [
  ["garage door open today?", "local status shorthand"],
  ["front door open now?", "modified local door status shorthand"],
  ["Front door open now?", "auto-capitalized local door status shorthand"],
  ["bedroom window open now?", "modified local window status shorthand"],
  ["is front door open now?", "modified local door status question"],
  ["is Bedroom Window open now?", "capitalized local window status question"],
  ["red car running now?", "modified local vehicle status shorthand"],
  ["dinner delayed today?", "personal status shorthand"],
] as const) {
  const plan = classifyToolAwareRoute(query);
  assert(!plan.intents.includes("research"), `${label}: does not route as research`);
  assert(!plan.priorityToolNames.includes("search_web"), `${label}: does not prioritize web search`);
}
{
  const plan = classifyToolAwareRoute("Dinner tonight?");
  assert(!plan.intents.includes("research"), "auto-capitalized dinner shorthand: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "auto-capitalized dinner shorthand: does not prioritize web search");
}
{
  const plan = classifyToolAwareRoute("Plans tonight?");
  assert(!plan.intents.includes("research"), "auto-capitalized plans shorthand: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "auto-capitalized plans shorthand: does not prioritize web search");
}
{
  const plan = classifyToolAwareRoute("Work now?");
  assert(!plan.intents.includes("research"), "auto-capitalized work shorthand: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "auto-capitalized work shorthand: does not prioritize web search");
}
for (const [query, label] of [
  ["Dinner today?", "auto-capitalized dinner today shorthand"],
  ["Work today?", "auto-capitalized work today shorthand"],
  ["Plans today?", "auto-capitalized plans today shorthand"],
] as const) {
  const plan = classifyToolAwareRoute(query);
  assert(!plan.intents.includes("research"), `${label}: does not route as research`);
  assert(!plan.priorityToolNames.includes("search_web"), `${label}: does not prioritize web search`);
}
{
  const plan = classifyToolAwareRoute("today's plan");
  assert(!plan.intents.includes("research"), "today's personal plan: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "today's personal plan: does not prioritize web search");
}
{
  const plan = classifyToolAwareRoute("today's work");
  assert(!plan.intents.includes("research"), "today's work context: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "today's work context: does not prioritize web search");
}
{
  const plan = classifyToolAwareRoute("today's dinner");
  assert(!plan.intents.includes("research"), "today's meal context: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "today's meal context: does not prioritize web search");
}
{
  const plan = classifyToolAwareRoute("did you win today?");
  assert(!plan.shouldPreferTool, "casual win question: does not prefer tool use");
  assert(!plan.intents.includes("research"), "casual win question: does not route as research");
  assert(plan.priorityToolNames.length === 0, "casual win question: no priority tools");
}
{
  const plan = classifyToolAwareRoute("what did you do today?");
  assert(!plan.shouldPreferTool, "casual what-did-you-do question: does not prefer tool use");
  assert(!plan.intents.includes("research"), "casual what-did-you-do question: does not route as research");
  assert(plan.priorityToolNames.length === 0, "casual what-did-you-do question: no priority tools");
}
{
  const plan = classifyToolAwareRoute("what did Sarah say yesterday?");
  assert(!plan.shouldPreferTool, "personal quote follow-up: does not prefer tool use");
  assert(!plan.intents.includes("research"), "personal quote follow-up: does not route as research");
  assert(plan.priorityToolNames.length === 0, "personal quote follow-up: no priority tools");
}
{
  const plan = classifyToolAwareRoute("are you delayed today?");
  assert(!plan.shouldPreferTool, "casual delayed question: does not prefer tool use");
  assert(!plan.intents.includes("research"), "casual delayed question: does not route as research");
  assert(plan.priorityToolNames.length === 0, "casual delayed question: no priority tools");
}
{
  const plan = classifyToolAwareRoute("help me write my weekly report");
  assert(!plan.shouldPreferTool, "weekly report writing: does not prefer tool use");
  assert(!plan.intents.includes("research"), "weekly report writing: does not route as research");
  assert(plan.priorityToolNames.length === 0, "weekly report writing: no priority tools");
}
{
  const plan = classifyToolAwareRoute("help me revise my current report");
  assert(!plan.shouldPreferTool, "current report writing: does not prefer tool use");
  assert(!plan.intents.includes("research"), "current report writing: does not route as research");
  assert(plan.priorityToolNames.length === 0, "current report writing: no priority tools");
}
{
  const plan = classifyToolAwareRoute("latest report");
  assert(!plan.shouldPreferTool, "latest report document phrase: does not prefer tool use");
  assert(!plan.intents.includes("research"), "latest report document phrase: does not route as research");
  assert(plan.priorityToolNames.length === 0, "latest report document phrase: no priority tools");
}
{
  const plan = classifyToolAwareRoute("latest one");
  assert(!plan.shouldPreferTool, "latest contextual pronoun phrase: does not prefer tool use");
  assert(!plan.intents.includes("research"), "latest contextual pronoun phrase: does not route as research");
  assert(plan.priorityToolNames.length === 0, "latest contextual pronoun phrase: no priority tools");
}
{
  const plan = classifyToolAwareRoute("latest reply");
  assert(!plan.intents.includes("research"), "latest reply phrase: does not route as research");
  assert(!plan.priorityToolNames.includes("search_web"), "latest reply phrase: no search_web");
}
{
  const plan = classifyToolAwareRoute("help me revise my current report for me");
  assert(!plan.shouldPreferTool, "current report writing with preposition: does not prefer tool use");
  assert(!plan.intents.includes("research"), "current report writing with preposition: does not route as research");
  assert(plan.priorityToolNames.length === 0, "current report writing with preposition: no priority tools");
}
{
  const plan = classifyToolAwareRoute("summarize our recent conversation");
  assert(!plan.shouldPreferTool, "recent conversation summary: does not prefer tool use");
  assert(!plan.intents.includes("research"), "recent conversation summary: does not route as research");
  assert(plan.priorityToolNames.length === 0, "recent conversation summary: no priority tools");
}
{
  const plan = classifyToolAwareRoute("summarize our recent conversation in detail");
  assert(!plan.shouldPreferTool, "recent conversation summary with preposition: does not prefer tool use");
  assert(!plan.intents.includes("research"), "recent conversation summary with preposition: does not route as research");
  assert(plan.priorityToolNames.length === 0, "recent conversation summary with preposition: no priority tools");
}
{
  const plan = classifyToolAwareRoute("help me write a headline for my report");
  assert(!plan.shouldPreferTool, "headline writing: does not prefer tool use");
  assert(!plan.intents.includes("research"), "headline writing: does not route as research");
  assert(plan.priorityToolNames.length === 0, "headline writing: no priority tools");
}
{
  const plan = classifyToolAwareRoute("write five headlines for my landing page");
  assert(!plan.shouldPreferTool, "landing page headlines: does not prefer tool use");
  assert(!plan.intents.includes("research"), "landing page headlines: does not route as research");
  assert(plan.priorityToolNames.length === 0, "landing page headlines: no priority tools");
}
assertRoute(
  "show me my GitHub pull requests",
  "github",
  ["github"],
  ["list_github_prs"],
);
assertRoute(
  "check Railway deployment logs",
  "railway",
  ["app_build", "mcp"],
  ["deploy_app", "project_shell"],
);
assertRoute(
  "start a project called Test Project",
  "project",
  ["coaching"],
  ["start_project"],
);
{
  const plan = classifyToolAwareRoute("Build me a small Android calculator app");
  assert(plan.intents.includes("project"), "Android app creation: routes as a project");
  assert(plan.priorityToolNames.includes("start_project"), "Android app creation: prioritizes start_project");
  assert(!plan.priorityToolNames.includes("build_feature"), "Android app creation: does not self-edit Jarvis");
  assert(plan.blockedToolNames.includes("build_feature"), "Android app creation: blocks the Jarvis self-edit tool");
}
for (const request of [
  "build a budgeting app",
  "create a fitness tracker app",
  "build me a native Android app",
]) {
  const plan = classifyToolAwareRoute(request);
  assert(plan.priorityToolNames.includes("start_project"), `Standalone app creation: '${request}' prioritizes start_project`);
}
for (const request of [
  "create a mobile app icon",
  "create a logo for my mobile app",
  "create a feature for my web app",
  "create a new screen in my Android app",
  "make changes to my web app",
  "create mobile app icons",
]) {
  const plan = classifyToolAwareRoute(request);
  assert(!plan.priorityToolNames.includes("start_project"), `App-adjacent request: '${request}' does not prioritize start_project`);
}
for (const request of [
  "How goes the calculator app?",
  "Work on that calculator app until completion",
  "It's in the project",
  "Can you access the project now?",
  "Launch my Pong game inside Jarvis",
]) {
  const plan = classifyToolAwareRoute(request);
  assert(plan.priorityToolNames.includes("manage_project"), `Existing project: '${request}' prioritizes manage_project`);
  assert(plan.blockedToolNames.includes("start_project"), `Existing project: '${request}' does not create a duplicate project`);
}
{
  const plan = classifyToolAwareRoute("Build me a small Pong game I can play against Jarvis");
  assert(plan.priorityToolNames.includes("start_project"), "Interactive Pong game: creates an installable project");
  assert(plan.blockedToolNames.includes("build_feature"), "Interactive Pong game: does not modify Jarvis source");
}
assertRoute(
  "fix your calendar routing code",
  "code",
  ["system", "self_edit"],
  ["delegate_to_codex", "build_feature"],
);
{
  const plan = classifyToolAwareRoute("fix this bug and push it to GitHub");
  assert(plan.shouldPreferTool, "code push: prefers tool use");
  assert(plan.guidance.includes("allow external side effects"), "code push: guidance mentions side-effect approval");
  assert(plan.guidance.includes("commit/push/publish"), "code push: guidance carries commit/push requirement");
  assert(plan.actionType === "jarvis_code_apply", "code push: ontology marks code apply");
  assert(plan.approvalRequired === true, "code push: ontology requires approval");
}
assertRoute(
  "what's wrong?",
  "diagnostics",
  ["system"],
  ["jarvis_self_diagnose"],
);
assertRoute(
  "why did the browser task fail?",
  "diagnostics",
  ["system"],
  ["jarvis_self_diagnose"],
);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
