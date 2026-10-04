import type { ToolGroup } from "./tools/index";
import {
  classifyActionOntology,
  isConversationInspectionQuestion,
  type ActionActor,
  type ActionType,
} from "./actionOntology";
import { resolveToolsForAction } from "./toolResolver";

export type ToolAwareIntent =
  | "weather"
  | "calendar"
  | "email"
  | "reminder"
  | "memory"
  | "research"
  | "browser"
  | "github"
  | "railway"
  | "project"
  | "code"
  | "diagnostics";

export interface ToolAwareRoutePlan {
  intents: ToolAwareIntent[];
  capabilityIds: string[];
  toolGroups: ToolGroup[];
  priorityToolNames: string[];
  blockedToolNames: string[];
  guidance: string;
  shouldPreferTool: boolean;
  actionType: ActionType;
  actor: ActionActor;
  approvalRequired: boolean;
  actionReason: string;
}

interface ToolAwareRule {
  intent: ToolAwareIntent;
  patterns: RegExp[];
  capabilityIds: string[];
  toolGroups: ToolGroup[];
  priorityToolNames: string[];
  guidance: string;
}

const PUBLIC_RESEARCH_SUBJECT_PATTERN = String.raw`(?:the\s+)?(?:[$][A-Za-z]{1,8}|s&p\s*500|nasdaq(?:\s+composite)?|dow(?:\s+jones)?(?:\s+industrial\s+average)?|russell\s*2000|tsla|aapl|nvda|msft|amzn|meta|googl?|nflx|spy|qqq|spx|btc(?:\/usd)?|eth(?:\/usd)?|sol|xrp|doge|ada|openai|anthropic|nvidia|tesla|microsoft|apple|amazon|google|netflix|nintendo(?:\s+switch)?|boeing|spacex|disney|trump|ukraine|russia|israel|iran|china|congress|senate|supreme\s+court|white\s+house|fed|federal\s+reserve|lakers|warriors|yankees|dodgers|chiefs|eagles|presidents?|ceos?|cfos?|ctos?|coos?|chief\s+executives?|chief\s+executive\s+officers?|founders?|owners?|leaders?|mayors?|governors?|senators?|representatives?|directors?|chairs?|chairmen|chairwomen|chairpersons?|heads?|ministers?|secretar(?:y|ies)|generals?)`;
const GENERIC_PUBLIC_PROPER_SUBJECT_PATTERN = String.raw`(?!(?:[Ii]|[Mm]e|[Yy]ou|[Ww]e|[Uu]s|[Tt]hey|[Tt]hem|[Hh]e|[Ss]he|[Ii]t|[Mm]y|[Oo]ur|[Yy]our|[Tt]heir|[Mm]om|[Mm]um|[Dd]ad|[Mm]other|[Ff]ather|[Bb]rother|[Ss]ister|[Ss]on|[Dd]aughter|[Hh]usband|[Ww]ife|[Pp]artner|[Ff]riend)\b)(?:[Tt]he\s+)?(?:[$A-Z][A-Za-z0-9&.'\u2019/-]*(?:\s+[A-Z][A-Za-z0-9&.'\u2019/-]*){0,5})`;
const PUBLIC_OPEN_STATUS_PLACE_PATTERN = String.raw`(?:starbucks|walmart|mcdonald['\u2019]?s|post\s+offices?|banks?|stores?|shops?|restaurants?|libraries|pharmacies|malls?|courthouses?|dmv|government\s+offices?)`;
const PERSONAL_TODAY_SUBJECT_PATTERN = String.raw`(?:[Pp]lans?|[Ss]chedule|[Cc]alendar|[Aa]genda|[Tt]asks?|[Tt]o-?dos?|[Rr]eminders?|[Aa]ppointments?|[Mm]eetings?|[Ww]ork|[Ss]chool|[Hh]ome|[Ll]ife|[Rr]outines?|[Gg]oals?|[Cc]ommitments?|[Pp]rojects?|[Dd]inner|[Ll]unch|[Bb]reakfast|[Mm]eals?|[Nn]otes?|[Mm]essages?|[Ee]mails?|[Ii]nbox|[Rr]epl(?:y|ies)|[Rr]esponses?|[Rr]eports?|[Dd]rafts?|[Dd]ocuments?|[Cc]onversations?|[Ww]eather|[Dd]ate|[Tt]ime|[Ss]tats?)`;
const PRIVATE_SPORTS_SUBJECT_PATTERN = String.raw`(?:i|me|you|we|us|he|him|she|her|it|they|them|this|that|these|those|my|mine|our|ours|your|yours|his|hers|its|their|theirs|someone|somebody|anyone|anybody|everyone|everybody|nobody|none|(?:the\s+)?(?:mom|mum|dad|mother|father|brother|sister|son|daughter|kids?|child|children|husband|wife|partner|friends?|team|group|club))`;
const PRIVATE_STATUS_SHORTHAND_SUBJECT_PATTERN = String.raw`(?:is|are|am|was|were|will|would|can|could|should|do|does|did|leave|keep|make|check|tell|be|${PRIVATE_SPORTS_SUBJECT_PATTERN}|${PERSONAL_TODAY_SUBJECT_PATTERN}|(?:the\s+)?(?:garage|door|window|office|home|house|room|lights?|appliances?|car|vehicle))`;
const PRIVATE_LOCAL_STATUS_SUBJECT_PATTERN = String.raw`(?:[Tt]he\s+)?(?:[$\w.\/&,'\u2019.-]+\s+){0,5}(?:[Gg]arage|[Dd]oors?|[Ww]indows?|[Oo]ffice|[Hh]ome|[Hh]ouse|[Rr]ooms?|[Ll]ights?|[Aa]ppliances?|[Cc]ars?|[Vv]ehicles?)`;
const PRIVATE_TIME_LOCATION_SUBJECT_PATTERN = String.raw`(?:i|me|you|we|us|they|them|he|him|she|her|it|this|that|my|our|your|their|here|there|now|right\s+now|today|tonight|please|home|work|office|device|phone|watch|computer|system|app)`;
const PUBLIC_SHOWTIME_PATTERN = String.raw`(?:movie\s+showtimes?|showtimes?|movie\s+times?|screening\s+times?)`;
const PUBLIC_EVENT_CATEGORY_PATTERN = String.raw`(?:concerts?|shows?|performances?|festivals?|exhibitions?|exhibits?|plays?|musicals?|comedy\s+shows?|open\s+mics?|meetups?|fairs?|markets?|parades?|screenings?|movies?|sports\s+events?|tournaments?|classes?|workshops?|${PUBLIC_SHOWTIME_PATTERN})`;
const PUBLIC_INCIDENT_NOUN_PATTERN = String.raw`(?:cases?|outages?|incidents?|alerts?|warnings?|closures?|restrictions?|advisories?)`;
const BARE_LIVE_DATA_NOUN_PATTERN = String.raw`(?:scores?|prices?|polls?|standings?|rankings?|odds|rates?|results?|games?|matches?|fixtures?|traffic|air\s+quality|delays?|cancellations?|cancelations?|availability|population|counts?|totals?|${PUBLIC_SHOWTIME_PATTERN}|${PUBLIC_INCIDENT_NOUN_PATTERN})`;
const FIAT_CURRENCY_CODE_PATTERN = String.raw`(?:usd|eur|gbp|jpy|cad|aud|chf|cny|hkd|nzd|sek|nok|dkk|inr|brl|mxn|zar|sgd|krw|pln|try)`;
const FIAT_CURRENCY_PAIR_PATTERN = String.raw`${FIAT_CURRENCY_CODE_PATTERN}\s*[\/.-]\s*${FIAT_CURRENCY_CODE_PATTERN}`;
const PUBLIC_MATCHUP_SUBJECT_PATTERN = String.raw`(?:[$\w.\/&,'\u2019.-]+\s+){0,4}[$\w.\/&,'\u2019.-]+`;
const PERSONAL_MEMORY_CONTENT_PATTERN = String.raw`(?:\bthat\s+(?:i|we)\b|\b(?:the\s+)?fact\s+that\b|\bwhat\s+(?:i|we)\s+(?:said|told\s+you)\b|\b(?:this|that|our)\s+(?:conversation|chat|exchange|discussion)\b|\b(?:i|we)\s+(?:am|are|was|were|live|lived|work|worked|prefer|preferred|like|liked|love|loved|hate|hated|want|wanted|need|needed|have|had|own|owned|use|used|choose|chose)\b|\b(?:i['\u2019](?:m|ve)|we['\u2019](?:re|ve))\b|\b(?:is|are|was|were)\s+(?:my|our)\s+(?:name|nickname|friend|partner|spouse|husband|wife|mother|father|mom|dad|parent|brother|sister|son|daughter|child|boss|coworker|colleague|business|company|job|work|school|home|address|birthday|preference|favorite)\b|\b(?:my|our)(?:\s+(?:(?:wife|husband|partner|spouse|mother|father|mom|dad|parent|brother|sister|son|daughter|child|children|kid|grandchild|grandchildren|grandkid|friend|boss|coworker|colleague|aunt|uncle|cousin|niece|nephew|grandmother|grandfather|grandma|grandpa)['\u2019]s|(?:wives|husbands|partners|spouses|mothers|fathers|moms|dads|parents|brothers|sisters|siblings|sons|daughters|kids|friends|bosses|coworkers|colleagues|aunts|uncles|cousins|nieces|nephews|grandmothers|grandfathers|grandmas|grandpas|grandparents|grandkids)['\u2019]))?\s+(?:names?|nicknames?|birthdays?|address(?:es)?|emails?|phone(?:\s+numbers?)?|allerg(?:y|ies)|medications?|preferences?|favorites?|jobs?|work|schools?|schedules?|routines?|goals?|projects?)\b)`;
const RECALL_PERSONAL_CUE_PATTERN = String.raw`(?:${PERSONAL_MEMORY_CONTENT_PATTERN}|\b(?:i|we|me|us|my|our|mine|ours)\b)`;
const DIRECTED_RECALL_NAMED_QUALIFIER_PATTERN = String.raw`(?:['\u2019]s\s+(?:birthday|address|email|phone(?:\s+number)?|job|schedule|preference|favorite)|\s+(?:birthday|address|email|phone(?:\s+number)?|job|schedule|preference|favorite)|\s+(?:from|at|in)\s+[A-Za-z0-9&.'\u2019/-]+(?:\s+[A-Za-z0-9&.'\u2019/-]+){0,4})?`;
const TECHNICAL_MEMORY_CONTINUATION_PATTERN = String.raw`(?:address(?:es)?|allocation|allocator|buffer|cache|capacity|card|cell|chip|configuration|consumption|footprint|heap|layout|leaks?|limit|location|management|map|mapping|module|page|pool|pressure|profile|region|register|setting|simulator|size|slot|storage|usage)`;
const MEMORY_REFERENCE_MODIFIER_PATTERN = String.raw`(?:specific|exact|particular|individual|old|new|existing|saved|stored|incorrect|wrong|inaccurate|outdated|previous|prior|original|current)`;
const MEMORY_REFERENCE_MODIFIERS_PATTERN = String.raw`(?:${MEMORY_REFERENCE_MODIFIER_PATTERN}(?:\s*,\s*|\s+)){0,4}`;
const REFERENTIAL_MEMORY_TARGET_PATTERN = String.raw`(?:the|that|this|these|those|my|your)\s+${MEMORY_REFERENCE_MODIFIERS_PATTERN}memor(?:y|ies)\b(?!\s+${TECHNICAL_MEMORY_CONTINUATION_PATTERN}\b)`;
const PERSONAL_MEMORY_CORRECTION_TARGET_PATTERN = String.raw`(?:${REFERENTIAL_MEMORY_TARGET_PATTERN}|one\s+of\s+(?:the|these|those|my|your|our)\s+${MEMORY_REFERENCE_MODIFIERS_PATTERN}memories\b(?!\s+${TECHNICAL_MEMORY_CONTINUATION_PATTERN}\b)|(?:a|an)\s+${MEMORY_REFERENCE_MODIFIERS_PATTERN}memor(?:y|ies)\b(?!\s+${TECHNICAL_MEMORY_CONTINUATION_PATTERN}\b)\s+(?:about|of|for)\s+(?:me|my|our)\b)`;
const MEMORY_CORRECTION_PREDICATE_PATTERN = String.raw`(?:wrong|incorrect|inaccurate|outdated|false|mistaken|not\s+(?:quite\s+)?(?:right|correct|accurate|true))`;
const MEMORY_CORRECTION_QUALIFIER_PATTERN = String.raw`(?:\s+(?:about|of|for)\s+[^.!?\n]{1,60}?)?`;

const TOOL_AWARE_RULES: ToolAwareRule[] = [
  {
    intent: "weather",
    patterns: [
      /\b(weather|forecast|temperature|temp|rain|snow|storm|wind|humidity|umbrella)\b/i,
      /\b(is it going to|will it)\s+(rain|snow|storm)\b/i,
    ],
    capabilityIds: ["research"],
    toolGroups: ["research"],
    priorityToolNames: ["weather_lookup"],
    guidance: "For weather or forecast requests, call weather_lookup before answering. Ask for city/state only if the location is missing.",
  },
  {
    intent: "calendar",
    patterns: [
      /\b(calendar|meetings?|events?|appointments?|schedule)\b/i,
      /\b(am i|are we)\s+free\b/i,
      /\b(block|book|schedule|reschedule|cancel)\s+.*\b(meeting|event|appointment|call|calendar)\b/i,
    ],
    capabilityIds: ["calendar"],
    toolGroups: ["calendar"],
    priorityToolNames: ["connected_accounts_list", "connected_accounts_search_tools", "connected_accounts_get_tool_schema", "connected_accounts_execute"],
    guidance: "For calendar questions or changes, use Composio connected account tools only: list connected accounts, search tools, read the selected tool schema, then execute with approval when needed. Do not use legacy Google/Microsoft calendar tools in this route.",
  },
  {
    intent: "email",
    patterns: [
      /\b(gmail|email|emails|inbox|mail|unread)\b/i,
      /\b(reply|respond|draft|compose|send|check|read|review|summari[sz]e)\s+.*\b(email|message|gmail)\b/i,
    ],
    capabilityIds: ["email"],
    toolGroups: ["email"],
    priorityToolNames: ["connected_accounts_list", "connected_accounts_search_tools", "connected_accounts_get_tool_schema", "connected_accounts_execute"],
    guidance: "For Gmail, Outlook, inbox, or email action requests, use Composio connected account tools only: list connected accounts, search tools, read the selected tool schema, then execute with approval when needed. Do not use legacy Gmail, Outlook, fetch_emails, create_gmail_draft, or send_email tools in this route.",
  },
  {
    intent: "reminder",
    patterns: [
      /\b(remind\s+me|set\s+(a\s+)?reminder|reminder)\b/i,
      /\b(do|tell|ping|notify)\s+me\b.{0,80}\b(in|at|on|tomorrow|today|tonight|morning|afternoon|evening|hour|minute|week)\b/i,
      /\b(call|text|email|message|follow\s+up)\b.{0,80}\b(in|at|on|tomorrow|today|tonight|morning|afternoon|evening|hour|minute|week)\b/i,
    ],
    capabilityIds: ["coaching"],
    toolGroups: ["coaching", "scheduling"],
    priorityToolNames: ["schedule_jarvis_task"],
    guidance: "For reminders, personal to-dos, habits, or future follow-ups the user must do themselves, call schedule_jarvis_task as a non-executable user_task when the user gives a clear time or recurrence. Do not schedule physical or user-owned work as a Jarvis autonomous action. For future work Jarvis can actually perform with tools, use explicit cron/job tooling instead.",
  },
  {
    intent: "memory",
    patterns: [
      /\b(what do you know about me|what have i told you|living context)\b/i,
      /\b(?:what|which)\s+(?:personal\s+)?memories?\s+(?:do|can|have|are)\s+you\b/i,
      new RegExp(String.raw`\b(?:(?:do|did)\s+you\s+have|have\s+you\s+got)\s+(?:(?:any|a|some)\s+)?(?:(?:saved|stored|personal)\s+)?memor(?:y|ies)\b(?!\s+${TECHNICAL_MEMORY_CONTINUATION_PATTERN}\b)(?:\s+(?:about|of|for)\b)?`, "i"),
      /\b(?:tell|show)\s+me\s+what\s+you\s+(?:remember|recall)\b/i,
      /\bwhat\s+do\s+you\s+(?:remember|recall)\s+(?:about|of)\b/i,
      /\b(?:do|can|could|will|would)\s+you\s+(?:please\s+)?remember\b(?!\s+(?:(?:not|never)\s+)?to\b)/i,
      new RegExp(String.raw`\b(?:do|can|could|will|would)\s+you\s+(?:please\s+)?recall\b(?!\s+(?:(?:not|never)\s+)?to\b)(?=[^.!?\n]{1,120}${RECALL_PERSONAL_CUE_PATTERN})`, "i"),
      /\b(?:do|can|could|will|would)\s+you\s+(?:please\s+)?recall\b(?!\s+(?:(?:not|never)\s+)?to\b)(?=[^.!?\n]{1,120}\b(?:anything|something)\b)/i,
      new RegExp(String.raw`\b(?:[Dd]o|[Cc]an|[Cc]ould|[Ww]ill|[Ww]ould)\s+[Yy]ou\s+(?:[Pp]lease\s+)?[Rr]ecall\s+${GENERIC_PUBLIC_PROPER_SUBJECT_PATTERN}${DIRECTED_RECALL_NAMED_QUALIFIER_PATTERN}\s*\??\s*$`),
      /\b(?:remember|recall)\s+(?:my|what i|what i've|what i have)\b/i,
      /\b(?:my|our)\s+(?:(?:saved|stored)\s+)?(?:memory|memories|preferences?)\b/i,
      /\bwhat\s+(?:personal\s+)?preferences?\s+do\s+you\s+have\s+(?:saved|stored)\s+for\s+me\b/i,
      /\b(?:show|list|search|find|read|get)\s+me\s+(?:the\s+)?preferences?\s+(?:i|we)\s+(?:saved|stored)\b/i,
      /\b(?:memory|memories)\s+(?:about|for|of)\s+me\b/i,
      /\b(?:show|list|search|find|read|get)\b.{0,40}\b(?:my|your|saved|personal)\s+memor(?:y|ies)\b/i,
      /^\s*(?:could|would|can|will)\s+you\s+(?:please\s+)?remember\b(?!\s+(?:(?:not|never)\s+)?to\b)/i,
      /^\s*(?:(?:hey|hi)[\s,;:!.-]+)?(?:jarvis[\s,:-]+)?(?:please[\s,]+)?remember\b(?!\s+(?:(?:not|never)\s+)?to\b)/i,
      new RegExp(String.raw`\b(?:i\s+(?:want|need)\s+(?:you|jarvis)\s+to|i\s+would\s+like\s+(?:you|jarvis)\s+to|i['\u2019]d\s+like\s+(?:you|jarvis)\s+to|make\s+sure\s+(?:you|jarvis))\s+(?:remember|recall)\b(?!\s+(?:(?:not|never)\s+)?to\b)(?=[^.!?\n]{1,120}${RECALL_PERSONAL_CUE_PATTERN})`, "i"),
      new RegExp(String.raw`\b(?:save|store|add|keep|make|turn|put|record|commit)\b[^.!?\n]{0,40}\b(?:those|these|that|this|them|all(?:\s+of\s+(?:that|those|these))?|the\s+above|what\s+i\s+(?:said|told\s+you))\b\s+(?:as|to|into|in)\s+(?:(?:a|the|your)\s+)?memor(?:y|ies)\b(?!\s+${TECHNICAL_MEMORY_CONTINUATION_PATTERN}\b)`, "i"),
      new RegExp(String.raw`\bcommit\b\s+(?:(?:this|that|the|my|our)\s+)?(?:facts?|details?|preferences?|information|info|notes?|conversations?|chats?)\b[^.!?\n]{0,20}\b(?:to|into)\s+(?:(?:my|the|your)\s+)?memor(?:y|ies)\b(?!\s+${TECHNICAL_MEMORY_CONTINUATION_PATTERN}\b)`, "i"),
      new RegExp(String.raw`\b(save|store|add|write|keep|put|record|commit)\b(?=[^.!?\n]{1,120}${PERSONAL_MEMORY_CONTENT_PATTERN}[^.!?\n]{0,120}\b(?:to|into)\s+(?:(?:my|the|your)\s+)?memory\b)[^.!?\n]{1,120}\b(?:to|into)\s+(?:(?:my|the|your)\s+)?memory\b`, "i"),
      new RegExp(String.raw`\b(save|store|add|write|keep|put|record|commit)\b(?=[^.!?\n]{1,120}${PERSONAL_MEMORY_CONTENT_PATTERN}[^.!?\n]{0,120}\bin\s+(?:(?:my|the|your)\s+)?memory\b)[^.!?\n]{1,120}\bin\s+(?:(?:my|the|your)\s+)?memory\b`, "i"),
      new RegExp(String.raw`\b(save|store|add|write|keep|put|record|commit)\b(?=[^.!?\n]{1,120}${PERSONAL_MEMORY_CONTENT_PATTERN}[^.!?\n]{0,120}\bas\s+(?:a\s+)?(?:memory|memories)\b)[^.!?\n]{1,120}\bas\s+(?:a\s+)?(memory|memories)\b`, "i"),
      /\b(save|store|add|keep|put|record|commit)\b.{0,40}\b(?:my|personal)\s+(?:facts?|details?|preferences?|information|info)\b.{0,40}\b(memory|memories)\b/i,
      /\b(?:those|these|that|this|them|all(?:\s+of\s+(?:that|those|these))?|the\s+above|what\s+i\s+(?:said|told\s+you))\b\s+(?:(?:should\s+)?(?:all\s+)?(?:be\s+)?memor(?:y|ies)\s+(?:saved|stored|added|written|kept|recorded)|memor(?:y|ies)\s+(?:all\s+)?(?:should|must|needs?\s+to|ha(?:s|ve)\s+to)\s+(?:all\s+)?be\s+(?:saved|stored|added|written|kept|recorded))\b/i,
      new RegExp(String.raw`\b(?:those|these|that|this|them|all(?:\s+of\s+(?:that|those|these))?|the\s+above|what\s+i\s+(?:said|told\s+you))\b\s+(?:should\s+)?(?:all\s+)?(?:be\s+)?(?:saved|stored|added|written|kept|put|recorded|committed)\b[^.!?\n]{0,20}\b(?:as|to|into|in)\s+(?:(?:a|the|your)\s+)?memor(?:y|ies)\b(?!\s+${TECHNICAL_MEMORY_CONTINUATION_PATTERN}\b)`, "i"),
      new RegExp(String.raw`\b(?:save|store|add|keep|put|record)\b[^.!?\n]{0,40}\b${REFERENTIAL_MEMORY_TARGET_PATTERN}`, "i"),
      /\b(edit|update|correct|change|replace|fix)\b[^.!?\n]{0,80}\b(?:what you remember|what you know about (?:me|my|our))\b/i,
      new RegExp(String.raw`\b(?:edit|update|correct|change|replace|fix)\b[^.!?\n]{0,40}\b${PERSONAL_MEMORY_CORRECTION_TARGET_PATTERN}`, "i"),
      /\b(edit|update|correct|change|replace|fix)\b.{0,40}\bthe\s+(memory|memories)\s+(?:about|of|for)\b/i,
      new RegExp(String.raw`\b${PERSONAL_MEMORY_CORRECTION_TARGET_PATTERN}\s+(?:should|needs?\s+to|must|has\s+to|is|was|be)\s+(?:be\s+)?(?:edit|edited|update|updated|correct|corrected|change|changed|replace|replaced|fix|fixed)\b`, "i"),
      new RegExp(String.raw`\b${PERSONAL_MEMORY_CORRECTION_TARGET_PATTERN}${MEMORY_CORRECTION_QUALIFIER_PATTERN}\s+(?:is|are|was|were|seems?|looks?)\s+(?:(?:completely|totally|really|clearly|definitely|obviously|still|just)\s+)?${MEMORY_CORRECTION_PREDICATE_PATTERN}\b`, "i"),
      new RegExp(String.raw`\b${PERSONAL_MEMORY_CORRECTION_TARGET_PATTERN}${MEMORY_CORRECTION_QUALIFIER_PATTERN}['\u2019]s\s+(?:(?:completely|totally|really|clearly|definitely|obviously|still|just)\s+)?${MEMORY_CORRECTION_PREDICATE_PATTERN}\b`, "i"),
      new RegExp(String.raw`\b${PERSONAL_MEMORY_CORRECTION_TARGET_PATTERN}${MEMORY_CORRECTION_QUALIFIER_PATTERN}\s+(?:isn|aren|wasn|weren|ain)['\u2019]?t\s+(?:quite\s+)?(?:right|correct|accurate|true)\b`, "i"),
      new RegExp(String.raw`\byou\s+(?:have|had|got|have\s+got|had\s+got)\s+${PERSONAL_MEMORY_CORRECTION_TARGET_PATTERN}\s+(?:(?:completely|totally|really|clearly|definitely|obviously)\s+)?${MEMORY_CORRECTION_PREDICATE_PATTERN}\b`, "i"),
      new RegExp(String.raw`\b${PERSONAL_MEMORY_CORRECTION_TARGET_PATTERN}\s+(?:that\s+)?you\s+(?:have|had|saved|stored)\s+(?:is|are|was|were|seems?|looks?)\s+(?:(?:completely|totally|really|clearly|definitely|obviously)\s+)?${MEMORY_CORRECTION_PREDICATE_PATTERN}\b`, "i"),
      /\bwhat\s+you\s+remember(?:\s+about\b[^.!?\n]{1,80})?\s+(?:is|was|seems?|looks?)\s+(?:completely\s+|totally\s+)?(?:wrong|incorrect|inaccurate|outdated|false|mistaken|not\s+(?:right|correct|accurate|true))\b/i,
      /\bwhat\s+you\s+know\s+about\s+(?:me|my|our)\b[^.!?\n]{0,80}\s+(?:is|was|seems?|looks?)\s+(?:completely\s+|totally\s+)?(?:wrong|incorrect|inaccurate|outdated|false|mistaken|not\s+(?:right|correct|accurate|true))\b/i,
      new RegExp(String.raw`\bremember\s+(?:that|this)\b(?!\s+(?:memory\s+)?${TECHNICAL_MEMORY_CONTINUATION_PATTERN}\b)`, "i"),
      new RegExp(String.raw`^\s*(?:(?:hey|hi)[\s,;:!.-]+)?(?:jarvis[\s,:-]+)?(?:please[\s,]+)?recall(?:\s+that)?\b(?!\s+(?:(?:not|never)\s+)?to\b)(?=[^.!?\n]{1,120}${RECALL_PERSONAL_CUE_PATTERN})`, "i"),
      /\b(my work hours|my goals|my routines|my projects|about me)\b/i,
      /\bwhat('?s|\s+is)\s+my\s+(name|nickname)\b/i,
      /\bwho\s+am\s+i\s*\??\s*$/i,
      /\bwhat\s+(name|nickname)\s+should\s+you\s+call\s+me\b/i,
      /\bwhat\s+should\s+you\s+call\s+me\b/i,
      /\bdo\s+you\s+know\s+my\s+(name|nickname)\b/i,
    ],
    capabilityIds: ["memory"],
    toolGroups: ["memory"],
    priorityToolNames: ["memory_search", "memory_get", "memory_save", "living_context_update"],
    guidance: "For memory or preference questions, search memory/living context before claiming not to know. When the user explicitly asks Jarvis to remember or save one or more stated facts, call memory_save for each distinct durable fact. When the user asks to edit or correct an existing memory, call memory_search first to retrieve its memory_id. If the turn states the corrected content, call memory_save with that content and supersedes_memory_id so the change remains reviewable and provenance-aware; otherwise ask the user for the corrected content and do not call memory_save.",
  },
  {
    intent: "research",
    patterns: [
      /\b(search\s+(up|for)?|look\s+up|lookup|google|find|research|investigate)\b/i,
      /\b(?:latest|current|recent)\s+(?:[$\w.\/&,'\u2019-]+\s+){0,6}(?:news|stories?|docs?|documentation|events?|games?|matches?|fixtures?|schedules?|hours?|opening\s+hours|business\s+hours|store\s+hours|updates?|developments?|situations?|sources?|articles?|headlines?|videos?|uploads?|posts?|information|info|data|traffic|quality|conditions?|prices?|scores?|results?|delays?|cancellations?|cancelations?|rulings?|decisions?|orders?|opinions?|judg(?:e)?ments?|verdicts?|versions?|releases?|rates?|values?|rankings?|standings?|polls?|odds?|availability|status|population|counts?|totals?)\b/i,
      new RegExp(String.raw`\b(?:latest|current|recent)\s+(?:[$\w.\/&,'\u2019-]+\s+){0,6}${PUBLIC_SHOWTIME_PATTERN}\b`, "i"),
      new RegExp(String.raw`\b(?:latest|current|recent)\s+(?!(?:my|our|your|their|his|her)\b)(?:[$\w.\/&,'\u2019-]+\s+){0,6}${PUBLIC_INCIDENT_NOUN_PATTERN}\b`, "i"),
      /\b(?:latest|current|recent)\s+(?:[$\w.\/&-]+\s+){0,6}(?:models?|products?|services?|features?|capabilities?)\b/i,
      /\b(?:latest|current|recent)\s+(?:[$\w.\/&-]+\s+){0,6}(?:presidents?|ceos?|cfos?|ctos?|coos?|chief\s+executives?|chief\s+executive\s+officers?|founders?|owners?|leaders?|mayors?|governors?|senators?|representatives?|directors?|chairs?|chairmen|chairwomen|chairpersons?|heads?|ministers?|secretar(?:y|ies)|generals?)\b/i,
      /\b(?:latest|current|recent)\s+(?:on|about|for|in|with)\b/i,
      /\b(?:latest|current|recent)\s+(?:S&P\s*500|NASDAQ(?:\s+Composite)?|Dow(?:\s+Jones)?(?:\s+Industrial\s+Average)?|Russell\s*2000|[$][A-Za-z]{1,8}|[A-Z]{1,6}(?:[\/.-][A-Z]{1,6})?)\b/,
      new RegExp(String.raw`\b(?:latest|current|recent)\s+${FIAT_CURRENCY_PAIR_PATTERN}\b`, "i"),
      /\b(?:latest|current|recent)\s+(?:s&p\s*500|nasdaq(?:\s+composite)?|dow(?:\s+jones)?(?:\s+industrial\s+average)?|russell\s*2000|tsla|aapl|nvda|msft|amzn|meta|googl?|nflx|spy|qqq|spx|btc(?:\/usd)?|eth(?:\/usd)?|sol|xrp|doge|ada)\b/i,
      /\b(?:latest|current|recent)\s+(?!(?:i|me|you|we|us|they|them|he|she|it|my|our|this|that|your|their|one|ones|thing|things|stuff|item|items|reply|replies|response|responses|answer|answers|question|questions|prompt|prompts|request|requests|report|reports|draft|drafts|document|documents|doc|docs|conversation|conversations|message|messages|email|emails|inbox|calendar|events?|schedule|schedules|meeting|meetings|appointment|appointments|reminder|reminders|task|tasks|to-?dos?|note|notes|time(?:\s*zone)?)\b)(?:[A-Z][A-Za-z0-9&.-]*(?:\s+[A-Z][A-Za-z0-9&.-]*){0,5})\s*\??$/i,
      new RegExp(String.raw`\b(?:current|local)\s+time(?:\s*zone)?\s+(?:in|at|for)\s+(?!${PRIVATE_TIME_LOCATION_SUBJECT_PATTERN}\b)(?:[$\w.\/&,'\u2019-]+\s*){1,6}\??\s*$`, "i"),
      new RegExp(String.raw`\b(?:current|local)\s+time(?:\s*zone)?\s+(?!(?:(?:in|at|for|on)|${PRIVATE_TIME_LOCATION_SUBJECT_PATTERN})\b)(?:[$\w.\/&,'\u2019-]+\s*){1,6}\??\s*$`, "i"),
      /\bwhat\s+time\s+is\s+it\s+(?:in|at)\s+(?!(?:my|our|your|their)\b)(?:[$\w.\/&,'\u2019-]+\s+){0,5}[$\w.\/&,'\u2019-]+(?:\s+(?:now|right\s+now))?\s*\??\s*$/i,
      new RegExp(String.raw`^\s*(?!(?:[Hh]ey|[Hh]ello|[Hh]i|[Yy]o|JARVIS|Jarvis|jarvis|Travis|travis|i|me|you|we|us|they|them|he|she|it|my|our|this|that|your|their|one|ones|thing|things|stuff|item|items|reply|replies|response|responses|answer|answers|question|questions|prompt|prompts|request|requests|report|reports|draft|drafts|document|documents|doc|docs|conversation|conversations|message|messages|email|emails|inbox|calendar|events?|schedule|schedules|meeting|meetings|appointment|appointments|reminder|reminders|task|tasks|to-?dos?|note|notes|${PERSONAL_TODAY_SUBJECT_PATTERN})\b)(?:[A-Z][A-Za-z0-9&.'\u2019-]*(?:\s+[A-Z][A-Za-z0-9&.'\u2019-]*){1,5})\s+today\s*\??\s*$`),
      new RegExp(String.raw`^\s*${PUBLIC_RESEARCH_SUBJECT_PATTERN}\s+(?:today|tonight|now|right\s+now)\s*\??\s*$`, "i"),
      /\b(?:S&P\s*500|NASDAQ(?:\s+Composite)?|Dow(?:\s+Jones)?(?:\s+Industrial\s+Average)?|Russell\s*2000|[$][A-Za-z]{1,8}|(?!I\b)[A-Z]{1,6}(?:[\/.-][A-Z]{1,6})?)\s+(?:today|currently|recently|now|right\s+now)\b/,
      new RegExp(String.raw`\b${FIAT_CURRENCY_PAIR_PATTERN}\s+(?:today|currently|recently|now|right\s+now)\b`, "i"),
      /\b(?:s&p\s*500|nasdaq(?:\s+composite)?|dow(?:\s+jones)?(?:\s+industrial\s+average)?|russell\s*2000|tsla|aapl|nvda|msft|amzn|meta|googl?|nflx|spy|qqq|spx|btc(?:\/usd)?|eth(?:\/usd)?|sol|xrp|doge|ada)\s+(?:today|currently|recently|now|right\s+now)\b/i,
      /^\s*(?:what(?:'s|\s+is)\s+)?(?!(?:my|our|this|that)\b)(?:[$\w.\/&-]+\s+){1,6}latest\s*\??\s*$/i,
      /\blatest\s+from\b/i,
      /\bwhat(?:'s|\s+is)?\s+new\s+(?:today|currently|recently|now|right\s+now)\b/i,
      /\bwhat(?:'s|\s+is)?\s+new\s+(?:in|with|about|at|for|on)\s+(?:[$\w.\/&,-]+\s+){1,8}(?:today|currently|recently|now|right\s+now)\b/i,
      new RegExp(String.raw`\bhow(?:'s|\s+(?:is|are))\s+${PUBLIC_RESEARCH_SUBJECT_PATTERN}\s+(?:doing|performing|trending|looking)\s+(?:today|currently|recently|now|right\s+now)\b`, "i"),
      /\bwhat(?:'s|\s+is)?\s+(?:happening|going\s+on)\s+today\b/i,
      /\bwhat\s+happened\s+today\b/i,
      /\bwhat(?:'s|\s+is)?\s+(?:happening|going\s+on)\s+(?:in|with|to|on|about|at|around|near|for)\s+(?:[$\w.\/&,-]+\s+){1,8}today\b/i,
      /\bwhat\s+happened\s+(?:in|with|to|on|about|at|around|near|for)\s+(?:[$\w.\/&,-]+\s+){1,8}today\b/i,
      new RegExp(String.raw`\bwhat\s+did\s+${PUBLIC_RESEARCH_SUBJECT_PATTERN}\s+(?:announce|say|report|release|publish|post|decide|rule|order|sign|launch|introduce|unveil|confirm|deny|approve|reject|win|lose)\s+(?:today|tonight|yesterday|now|right\s+now)\b`, "i"),
      new RegExp(String.raw`\bwhat\s+did\s+${GENERIC_PUBLIC_PROPER_SUBJECT_PATTERN}\s+(?:announce|report|release|publish|post|launch|introduce|unveil)\s+(?:today|tonight|yesterday|now|right\s+now)\b`, "i"),
      new RegExp(String.raw`^\s*(?!${PRIVATE_STATUS_SHORTHAND_SUBJECT_PATTERN}\b)(?:the\s+)?${PUBLIC_MATCHUP_SUBJECT_PATTERN}\s+(?:vs\.?|versus|at|@)\s+(?!${PRIVATE_STATUS_SHORTHAND_SUBJECT_PATTERN}\b)(?:the\s+)?${PUBLIC_MATCHUP_SUBJECT_PATTERN}\s+(?:today|tonight|tomorrow|now|right\s+now)\s*\??\s*$`, "i"),
      new RegExp(String.raw`\b(?:who\s+(?:is|are)\s+playing|who\s+plays|(?:is|are)\s+(?!${PRIVATE_SPORTS_SUBJECT_PATTERN}\b)(?:the\s+)?(?:[$\w.\/&,-]+\s+){0,5}playing|(?:do|does)\s+(?!${PRIVATE_SPORTS_SUBJECT_PATTERN}\b)(?:the\s+)?(?:[$\w.\/&,-]+\s+){0,5}play)\s+(?:today|tonight|tomorrow|now|right\s+now)\b`, "i"),
      new RegExp(String.raw`\b(?:is|are)\s+${PUBLIC_RESEARCH_SUBJECT_PATTERN}\s+(?:open|closed)\s+(?:today|tonight|tomorrow|now|right\s+now)\b`, "i"),
      new RegExp(String.raw`\b(?:is|are)\s+the\s+${PUBLIC_OPEN_STATUS_PLACE_PATTERN}\s+(?:open|closed)\s+(?:today|tonight|tomorrow|now|right\s+now)\b`, "i"),
      new RegExp(String.raw`\b(?:is|are)\s+(?!${PRIVATE_LOCAL_STATUS_SUBJECT_PATTERN}\b)${GENERIC_PUBLIC_PROPER_SUBJECT_PATTERN}\s+(?:open|closed)\s+(?:today|tonight|tomorrow|now|right\s+now)\b`),
      new RegExp(String.raw`\b(?:is|are)\s+(?!${PRIVATE_LOCAL_STATUS_SUBJECT_PATTERN}\b)(?!(?:you|we|i|it|this|that|my|our|your|their|his|her|the)\b)(?:[$\w.\/&,'\u2019-]+\s+){1,6}(?:open|closed)\s+(?:today|tonight|tomorrow|now|right\s+now)\b`, "i"),
      new RegExp(String.raw`\b(?:is|are)\s+(?!${PRIVATE_LOCAL_STATUS_SUBJECT_PATTERN}\b)(?!(?:you|we|i|it|this|that|my|our|your|their|his|her|the)\b)(?:[$\w.\/&,'\u2019-]+\s+){1,6}(?:delayed|cancelled|canceled|on\s+time|running)\s+(?:today|tonight|tomorrow|now|right\s+now)\b`, "i"),
      new RegExp(String.raw`^\s*${PUBLIC_RESEARCH_SUBJECT_PATTERN}\s+(?:open|closed|delayed|cancelled|canceled|on\s+time|running)\s+(?:today|tonight|tomorrow|now|right\s+now)\s*\??\s*$`, "i"),
      new RegExp(String.raw`^\s*(?!(?:my|our|your|their)\b)(?:[$\w.\/&,'\u2019.-]+\s+){0,4}(?:schools?|school\s+districts?|campuses?)\s+(?:open|closed|delayed|cancelled|canceled|on\s+time|running)\s+(?:today|tonight|tomorrow|now|right\s+now)\s*\??\s*$`, "i"),
      new RegExp(String.raw`^\s*(?!${PRIVATE_STATUS_SHORTHAND_SUBJECT_PATTERN}\b)(?!${PRIVATE_LOCAL_STATUS_SUBJECT_PATTERN}\b)(?:[$\w.\/&,'\u2019.-]+\s+){1,6}(?:open|closed|delayed|cancelled|canceled|on\s+time|running)\s+(?:today|tonight|tomorrow|now|right\s+now)\s*\??\s*$`, "i"),
      new RegExp(String.raw`\bdid\s+(?!${PRIVATE_SPORTS_SUBJECT_PATTERN}\b)(?:the\s+)?(?:[$\w.\/&,-]+\s+){0,5}(?:win|lose|play)\s+(?:today|tonight|yesterday)\b`, "i"),
      /\bwho\s+(?:won|lost)\s+(?:today|tonight|yesterday)\b/i,
      /\b(?:stock\s+market|stocks?|markets?)\b.{0,60}\b(?:today|currently|recently|latest|now|right\s+now)\b/i,
      /\b(?:news|updates?|sources?|articles?)\s+(?:today|currently|recently|latest|on|about|for)\b/i,
      /\bheadlines?\s+(?:today|currently|recently|latest)\b/i,
      /\btoday(?:['\u2019]s|s)?\s+(?:top\s+)?stories?\b/i,
      /\b(?:top\s+)?stories?\s+(?:today|currently|recently|latest|now|right\s+now)\b/i,
      new RegExp(String.raw`^\s*${BARE_LIVE_DATA_NOUN_PATTERN}\s+(?:today|tonight|currently|recently|latest|now|right\s+now)\s*\??\s*$`, "i"),
      new RegExp(String.raw`^\s*today(?:['\u2019]s|s)\s+(?!${PERSONAL_TODAY_SUBJECT_PATTERN}\b)(?:[$\w.\/&,'\u2019-]+\s*){1,8}\??\s*$`, "i"),
      /\btoday(?:['\u2019]s|s)?\s+(?:[$\w.\/&-]+\s+){0,6}(?:news|stories?|events?|games?|matches?|fixtures?|schedules?|hours?|opening\s+hours|business\s+hours|store\s+hours|updates?|developments?|situations?|sources?|articles?|headlines?|videos?|uploads?|posts?|information|info|data|traffic|quality|conditions?|prices?|scores?|results?|delays?|cancellations?|cancelations?|rulings?|decisions?|orders?|opinions?|judg(?:e)?ments?|verdicts?|versions?|releases?|rates?|values?|rankings?|standings?|polls?|odds?|availability|status|population|counts?|totals?)\b/i,
      new RegExp(String.raw`\btoday(?:['\u2019]s|s)?\s+(?:[$\w.\/&,'\u2019-]+\s+){0,6}${PUBLIC_SHOWTIME_PATTERN}\b`, "i"),
      /\b(?:news|updates?|sources?)\b/i,
      /^\s*(?:the\s+)?headlines?\s*\??\s*$/i,
      /\b(?:[$\w.\/&-]+\s+){1,6}(?:news|updates?)\b/i,
      /^\s*(?!(?:my|our|your|their|his|her)\b)(?:[$\w.\/&,'\u2019-]+\s+){1,6}articles?\s*\??\s*$/i,
      /\b(?:[$\w.\/&,'\u2019-]+\s+){1,6}(?:stories?|events?|games?|matches?|fixtures?|schedules?|hours?|opening\s+hours|business\s+hours|store\s+hours|headlines?|videos?|uploads?|posts?|information|info|data|traffic|quality|conditions?|prices?|scores?|results?|delays?|cancellations?|cancelations?|rulings?|decisions?|orders?|opinions?|judg(?:e)?ments?|verdicts?|developments?|situations?|versions?|releases?|rates?|values?|rankings?|standings?|polls?|odds?|availability|status|population|counts?|totals?)\s+(?:today|currently|recently|latest|now|right\s+now)\b/i,
      new RegExp(String.raw`\b(?:[$\w.\/&,'\u2019-]+\s+){0,6}${PUBLIC_SHOWTIME_PATTERN}\s+(?:today|tonight|tomorrow|currently|recently|latest|now|right\s+now)\b`, "i"),
      new RegExp(String.raw`\b(?!(?:my|our|your|their|his|her)\b)(?:[$\w.\/&,'\u2019-]+\s+){1,6}${PUBLIC_INCIDENT_NOUN_PATTERN}\s+(?:today|tonight|currently|recently|latest|now|right\s+now)\b`, "i"),
      /\b(?:stories?|events?|games?|matches?|fixtures?|schedules?|hours?|opening\s+hours|business\s+hours|store\s+hours|headlines?|videos?|uploads?|posts?|information|info|data|traffic|quality|conditions?|prices?|scores?|results?|delays?|cancellations?|cancelations?|rulings?|decisions?|orders?|opinions?|judg(?:e)?ments?|verdicts?|developments?|situations?|versions?|releases?|rates?|values?|rankings?|standings?|polls?|odds?|availability|status|population|counts?|totals?)\s+(?:of|for|from|in|on|at|near|around|about|with)\s+(?:[$\w.\/&,-]+\s+){1,8}(?:today|currently|recently|latest|now|right\s+now)\b/i,
      new RegExp(String.raw`\b${PUBLIC_SHOWTIME_PATTERN}\s+(?:of|for|from|in|on|at|near|around|about|with)\s+(?:[$\w.\/&,'\u2019-]+\s+){1,8}(?:today|tonight|tomorrow|currently|recently|latest|now|right\s+now)\b`, "i"),
      new RegExp(String.raw`^\s*(?:(?:are|is)\s+there\s+)?(?:(?:any|an?|some)\s+)?(?:new\s+)?${PUBLIC_EVENT_CATEGORY_PATTERN}\s+(?:today|tonight|tomorrow|this\s+(?:weekend|week|month))\s*\??\s*$`, "i"),
      new RegExp(String.raw`\b${PUBLIC_EVENT_CATEGORY_PATTERN}\s+(?:in|near|around|at)\s+(?:[$\w.\/&,-]+\s+){1,8}(?:today|tonight|tomorrow|this\s+(?:weekend|week|month))\b`, "i"),
      new RegExp(String.raw`\b${PUBLIC_EVENT_CATEGORY_PATTERN}\s+(?:today|tonight|tomorrow|this\s+(?:weekend|week|month))\s+(?:in|near|around|at)\s+(?!(?:my|our)\b)(?:[$\w.\/&,-]+\s+){0,7}[$\w.\/&,-]+\s*\??$`, "i"),
      /\b(?:presidents?|ceos?|cfos?|ctos?|coos?|chief\s+executives?|chief\s+executive\s+officers?|founders?|owners?|leaders?|mayors?|governors?|senators?|representatives?|directors?|chairs?|chairmen|chairwomen|chairpersons?|heads?|ministers?|secretar(?:y|ies)|generals?)\s+(?:of|for|at|in)\s+(?:[$\w.\/&,-]+\s+){1,8}(?:today|currently|recently|latest|now|right\s+now)\b/i,
    ],
    capabilityIds: ["research", "browser"],
    toolGroups: ["research", "browser"],
    priorityToolNames: ["search_web", "research_topic", "web_fetch", "browser_navigate", "browser_extract"],
    guidance: "For research, news, source-finding, or current-info requests, call search_web or research_topic before answering. If search is not configured, use browser_navigate and browser_extract as the fallback. Cite useful source URLs from the tool results.",
  },
  {
    intent: "browser",
    patterns: [
      /\b(browser|browse|open\s+(a\s+)?(website|site|page|url|tab)|navigate to|click|screenshot of (the )?page)\b/i,
      /https?:\/\//i,
      /\b(inspect|extract|read)\s+.*\b(page|website|site|url)\b/i,
    ],
    capabilityIds: ["browser", "research"],
    toolGroups: ["browser", "research"],
    priorityToolNames: ["browser_navigate", "browser_snapshot", "browser_extract", "web_fetch", "search_web"],
    guidance: "For browser/navigation/page-inspection requests, use browser tools or web fetch/search before giving a capability disclaimer.",
  },
  {
    intent: "github",
    patterns: [
      /\b(github|pull request|pull requests|prs?|repo|repository|branch|merge|workflow|ci|checks?)\b/i,
      /\b(issue|issues)\s+#?\d*\b/i,
    ],
    capabilityIds: ["github"],
    toolGroups: ["github"],
    priorityToolNames: ["list_github_prs", "get_github_pr", "merge_github_pr"],
    guidance: "For GitHub requests, use GitHub tools when connected instead of answering from memory.",
  },
  {
    intent: "railway",
    patterns: [
      /\b(railway|railway\.app|deployment|deployments|deploy|service logs?|build logs?|environment variables?|env vars?)\b/i,
      /\b(database url|postgres service|railway status|railway project)\b/i,
    ],
    capabilityIds: ["system", "browser", "research"],
    toolGroups: ["app_build", "mcp", "browser", "research"],
    priorityToolNames: ["deploy_app", "project_shell", "browser_navigate", "search_web"],
    guidance: "For Railway/deploy/status requests, use Railway MCP/deploy/project tools when available before falling back to docs or a setup explanation.",
  },
  {
    intent: "project",
    patterns: [
      /\b(start|create|make|open|set up|setup)\s+(a\s+|new\s+)?project\b/i,
      /\bproject\s+(called|named|titled)\b/i,
      /\bnew\s+project\b/i,
    ],
    capabilityIds: ["coaching"],
    toolGroups: ["coaching"],
    priorityToolNames: ["start_project", "queue_background_job"],
    guidance: "For project creation requests, use start_project. For websites, landing pages, dashboards, tools, or standalone apps, set project_kind='app'. If the user only supplies a project name, create the project with that name as the initial goal instead of claiming no project API exists.",
  },
  {
    intent: "code",
    patterns: [
      /\b(build|create|make|implement|add|code|write|fix|debug|inspect|edit|test)\s+.*\b(app|website|feature|tool|script|function|repo|repository|source|code|bug|integration|connector)\b/i,
      /\b(delegate to codex|use codex|self[- ]?write|write your source|change your code|patch your code)\b/i,
    ],
    capabilityIds: ["system", "self_edit", "agent_delegation"],
    toolGroups: ["system", "self_edit", "app_build", "mcp"],
    priorityToolNames: ["delegate_to_codex", "build_feature", "queue_background_job", "project_shell", "list_source_files", "read_source_file", "propose_code_change"],
    guidance: "For code-writing or self-improvement requests, route to Codex delegation/build/self-edit tools before replying in plain text. If the user explicitly asks for the fix to be permanent, pushed, published, deployed, or on GitHub, include the commit/push/publish requirement in the Codex delegation and allow external side effects only for that exact requested action.",
  },
  {
    intent: "diagnostics",
    patterns: [
      /\b(what'?s wrong|what is wrong|why did .{0,80}\bfail|why (is|are) .* not working|are you ok|are you okay|system health|self[- ]?diagnos(e|is)|diagnose yourself)\b/i,
      /\b(browser|tool|gateway|codex|railway|deploy|deployment|server|app|jarvis).*\b(broken|fail|failing|failed|down|stuck|not working)\b/i,
    ],
    capabilityIds: ["system"],
    toolGroups: ["system"],
    priorityToolNames: ["jarvis_self_diagnose"],
    guidance: "For Jarvis health, failure, or reliability questions, call jarvis_self_diagnose before answering so the reply is based on current subsystem status instead of stale chat history.",
  },
];

const EMPTY_PLAN: ToolAwareRoutePlan = {
  intents: [],
  capabilityIds: [],
  toolGroups: [],
  priorityToolNames: [],
  blockedToolNames: [],
  guidance: "",
  shouldPreferTool: false,
  actionType: "unknown",
  actor: "jarvis",
  approvalRequired: false,
  actionReason: "No tool-aware route matched.",
};

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function isStandaloneAppCreationRequest(query: string): boolean {
  const genericAppRequest = /\b(?:build|create|make|start|develop)\b\s+(?:(?:me|us)\s+)?(?:(?:a|an|the|my|our|new)\s+)?(?:(?!(?:features?|screens?|pages?|components?|routes?|endpoints?|fix(?:es)?|changes?|updates?|icons?|logos?|assets?|inside|in|for|on|of|to)\b)[\w-]+\s+){0,6}app\b(?!['’]s\b|\s+(?:features?|screens?|pages?|components?|routes?|endpoints?|fix(?:es)?|changes?|updates?|icons?|logos?|assets?)\b)/i;
  return (
    genericAppRequest.test(query) ||
    /\b(?:build|create|make|start|develop)\b[\s\S]{0,100}\bgame\b(?!\s+plan)/i.test(query)
  );
}

function isExistingProjectRequest(query: string): boolean {
  return (
    /\b(?:how(?:'s|\s+is)|what(?:'s|\s+is))\b[\s\S]{0,60}\b(?:project|app)\b/i.test(query) ||
    /\b(?:status|progress)\b[\s\S]{0,40}\b(?:project|app)\b/i.test(query) ||
    /\b(?:continue|resume|finish|complete|work\s+on|keep\s+working\s+on)\b[\s\S]{0,80}\b(?:project|app)\b/i.test(query) ||
    /\b(?:it(?:'s|\s+is)|that(?:'s|\s+is))\s+in\s+(?:the|a|my)\s+project\b/i.test(query) ||
    /\b(?:access|inspect|open|read)\b[\s\S]{0,50}\bproject(?:\s+files?|\s+workspace)?\b/i.test(query)
    || /\bhow\s+goes\b[\s\S]{0,60}\b(?:project|app)\b/i.test(query)
    || /^\s*(?:an?\s+)?(?:android|iphone|ios|web)\s+app\s*$/i.test(query)
    || /\b(?:open|launch|play)\b[\s\S]{0,80}\b(?:inside|in)\s+jarvis\b/i.test(query)
  );
}

function isPrivateCalendarEventQuery(query: string): boolean {
  return (
    /\b(?:my|our)\s+(?:[\w.-]+\s+){0,2}calendar\b/i.test(query) ||
    /\b(?:my|our)\s+(?:calendar\s+)?(?:events?|meetings?|appointments?)\b/i.test(query) ||
    /\bevents?\s+(?:are\s+)?(?:on|in|for)\s+(?:my|our)\s+calendar\b/i.test(query) ||
    /\b(?:my|our)\s+(?:calendar\s+)?schedule\b/i.test(query) ||
    /\bon\s+(?:my|our)\s+schedule\b/i.test(query) ||
    /\bschedule\s+(?:on|in|for)\s+(?:my|our)\s+calendar\b/i.test(query)
  );
}

const MIXED_RESEARCH_LIVE_NOUN_PATTERN = String.raw`(?:news|stories?|docs?|documentation|updates?|headlines?|articles?|sources?|events?|games?|matches?|fixtures?|schedules?|hours?|opening\s+hours|business\s+hours|store\s+hours|videos?|uploads?|posts?|information|info|data|traffic|air\s+quality|quality|conditions?|prices?|scores?|results?|delays?|cancellations?|cancelations?|rulings?|decisions?|orders?|opinions?|judg(?:e)?ments?|verdicts?|developments?|situations?|versions?|releases?|rates?|values?|rankings?|standings?|polls?|odds?|availability|status|population|counts?|totals?|${PUBLIC_EVENT_CATEGORY_PATTERN}|${PUBLIC_INCIDENT_NOUN_PATTERN})`;
const MIXED_RESEARCH_COMMAND_PREFIX_PATTERN = String.raw`(?:(?:(?:can|could|would|will)\s+you\s+|please\s+)?(?:tell|give|show|find|get|bring|check)\s+(?:(?:me|us)\s+)?)?`;
const MIXED_RESEARCH_CLAUSE_START_PATTERN = String.raw`${MIXED_RESEARCH_COMMAND_PREFIX_PATTERN}(?:what(?:'s|\s+is)\s+(?:happening|going\s+on)\b|what\s+happened\b|(?:the\s+)?(?:latest|current|recent)\b|${PUBLIC_RESEARCH_SUBJECT_PATTERN}\s+(?:today|tonight|now|right\s+now)\b|(?:[$\w.\/&,'\u2019-]+\s+){0,6}${MIXED_RESEARCH_LIVE_NOUN_PATTERN}\b)`;
const MIXED_RESEARCH_CLAUSE_SEPARATOR = new RegExp(
  String.raw`(?:\s+(?:and|also|plus|then|along\s+with|together\s+with|as\s+well\s+as)\s+|\s+with\s+|[,;]+\s*)(?=${MIXED_RESEARCH_CLAUSE_START_PATTERN})|[.!?]+(?:\s+(?=${MIXED_RESEARCH_CLAUSE_START_PATTERN})|$)`,
  "i",
);

function hasExplicitWebResearchCommand(query: string): boolean {
  return (
    /\b(?:search\s+(?:the\s+)?(?:web|internet)|web\s+search|google(?!\s+(?:[\w.-]+\s+){0,2}calendar\b)|research|investigate)\b/i.test(query) ||
    /\b(?:search\s+(?:up|for)|look\s+up|lookup)\b.{0,80}\b(?:how\s+to|why|what|when|where|whether|sources?|articles?|docs?|documentation|online|web|internet)\b/i.test(query) ||
    /\b(?:search(?:\s+(?:up|for))?|look\s+up|lookup)\b.{0,80}\b(?:latest|current|recent)\s+(?:[$\w.\/&,'\u2019-]+\s+){0,5}(?:updates?|news|announcements?|changes?|information|info)\b/i.test(query)
  );
}

function hasSeparateResearchClause(query: string): boolean {
  const clauses = query
    .split(MIXED_RESEARCH_CLAUSE_SEPARATOR)
    .map((clause) => clause.trim())
    .filter(Boolean);

  return clauses.some((clause) => {
    if (isPrivateCalendarEventQuery(clause)) return false;
    return TOOL_AWARE_RULES.some(
      (rule) =>
        rule.intent === "research" &&
        rule.patterns.some((pattern) => pattern.test(clause)),
    );
  });
}

export function classifyToolAwareRoute(text: string): ToolAwareRoutePlan {
  const query = text.trim().replace(/[\u2018\u2019]/g, "'");
  if (!query) return EMPTY_PLAN;
  const ontology = classifyActionOntology(query);
  if (isStandaloneAppCreationRequest(query)) {
    return {
      intents: ["project"],
      capabilityIds: ["coaching"],
      toolGroups: ["coaching"],
      priorityToolNames: ["start_project"],
      blockedToolNames: ["build_feature", "delegate_to_codex", "propose_code_change"],
      guidance: "Create a persistent installable Jarvis mini-app with start_project. This request is for a separate user application, not a change to Jarvis's own source. Use framework='android-kotlin' for Android apps and a web framework for games or embedded interactive experiences.",
      shouldPreferTool: true,
      actionType: ontology.actionType,
      actor: ontology.actor,
      approvalRequired: false,
      actionReason: "The user asked Jarvis to create a standalone application project.",
    };
  }
  if (isExistingProjectRequest(query)) {
    return {
      intents: ["project"],
      capabilityIds: ["coaching"],
      toolGroups: ["coaching"],
      priorityToolNames: ["manage_project"],
      blockedToolNames: ["build_feature", "delegate_to_codex", "start_project"],
      guidance: "Use manage_project to inspect or continue the existing persistent project. Never ask the user to enable workspace access.",
      shouldPreferTool: true,
      actionType: ontology.actionType,
      actor: ontology.actor,
      approvalRequired: false,
      actionReason: "The user referenced an existing Jarvis project.",
    };
  }
  if (isConversationInspectionQuestion(query) && ontology.actionType === "unknown") {
    return {
      ...EMPTY_PLAN,
      actionReason: "The request inspects this conversation and does not require a connected account.",
    };
  }
  const toolResolution = resolveToolsForAction(ontology);

  const ruleMatches = TOOL_AWARE_RULES.filter((rule) =>
    rule.patterns.some((pattern) => pattern.test(query)),
  );
  const shouldSuppressResearch =
    isPrivateCalendarEventQuery(query) &&
    ruleMatches.some((rule) => rule.intent === "calendar") &&
    !hasExplicitWebResearchCommand(query) &&
    !hasSeparateResearchClause(query);
  const matched = shouldSuppressResearch ? ruleMatches.filter((rule) => rule.intent !== "research") : ruleMatches;
  const ontologyToolGroups = shouldSuppressResearch
    ? ontology.allowedToolGroups.filter((group) => group !== "research" && group !== "browser")
    : ontology.allowedToolGroups;
  const resolverPriorityToolNames = shouldSuppressResearch
    ? []
    : [...toolResolution.requiredToolNames, ...toolResolution.optionalToolNames];
  const toolResolverReason = shouldSuppressResearch
    ? "Private calendar lookup is limited to connected-account calendar tools."
    : toolResolution.reason;
  if (matched.length === 0) {
    return {
      intents: [],
      capabilityIds: [],
      toolGroups: ontologyToolGroups,
      priorityToolNames: resolverPriorityToolNames,
      blockedToolNames: toolResolution.blockedToolNames,
      guidance: ontology.actionType === "unknown" ? "" : `- ${ontology.reason}\n- Tool resolver: ${toolResolverReason}`,
      shouldPreferTool: resolverPriorityToolNames.length > 0 || ontology.actionType === "blocked_physical_action",
      actionType: ontology.actionType,
      actor: ontology.actor,
      approvalRequired: toolResolution.approvalRequired,
      actionReason: ontology.reason,
    };
  }

  return {
    intents: matched.map((rule) => rule.intent),
    capabilityIds: unique(matched.flatMap((rule) => rule.capabilityIds)),
    toolGroups: unique([...matched.flatMap((rule) => rule.toolGroups), ...ontologyToolGroups]),
    priorityToolNames: unique([
      ...matched.flatMap((rule) => rule.priorityToolNames),
      ...resolverPriorityToolNames,
    ]),
    blockedToolNames: toolResolution.blockedToolNames,
    guidance: [
      ...matched.map((rule) => `- ${rule.guidance}`),
      `- Action ownership: ${ontology.reason}`,
      `- Tool resolver: ${toolResolverReason}`,
    ].join("\n"),
    shouldPreferTool: true,
    actionType: ontology.actionType,
    actor: ontology.actor,
    approvalRequired: toolResolution.approvalRequired,
    actionReason: ontology.reason,
  };
}

const CONTEXTUAL_TOOL_CONFIRMATION_PATTERN = /^(?:(?:yes|yep|yeah|sure|absolutely|definitely|certainly|of\s+course|ok(?:ay)?|go\s+(?:ahead|for\s+it)|proceed|do\s+(?:it|that)|let'?s\s+do\s+it|sounds\s+(?:good|great|perfect)|that\s+works|works\s+for\s+me|fine\s+by\s+me|that\s+would\s+be\s+(?:good|great|perfect)|i(?:'d|\s+would)\s+(?:like|love)\s+that)(?:\s+(?:please|thanks|thank\s+you))?|please\s+(?:go\s+(?:ahead|for\s+it)|proceed|do\s+(?:it|that)))$/i;
const CONTEXTUAL_TOOL_NEGATION_PATTERN = /\b(?:no|not|never|cancel|do\s+not|don['’]?t|can(?:not|['’]t)|couldn['’]?t|won['’]?t|wouldn['’]?t|shouldn['’]?t)\b/i;
const CONTEXTUAL_TOOL_RETRY_PATTERN = /\b(?:try\s+(?:(?:it|that)\s+)?(?:again|once\s+more)|retry(?:\s+(?:it|that))?|give\s+(?:it|that)\s+another\s+(?:try|shot)|run\s+(?:it|that)\s+again|one\s+more\s+time)\b/i;
const ASSISTANT_PROPOSAL_PATTERN = /(?:would\s+you\s+like\s+me\s+to|do\s+you\s+want\s+me\s+to|shall\s+i|should\s+i|may\s+i|can\s+i|i\s+(?:can|could|will)|i['’]ll|let\s+me)\s+([^.!?;]+)/gi;
const NON_ACTION_PROPOSAL_PATTERN = /^(?:explain|describe|discuss|tell\s+you\s+(?:about|how)|show\s+you\s+how|walk\s+you\s+through)\b/i;
const SELF_DECLARATIVE_PROPOSAL_PATTERN = /^i(?:\s+(?:can|could|will)|['’]ll)\b/i;
const ACTION_PROPOSAL_PATTERN = /^(?:add|archive|book|cancel|change|check|complete|connect|create|delete|diagnose|draft|edit|generate|handle|log|look\s+up|make|mark|move|open|post|read|record|remove|rename|reply|reschedule|run|save|schedule|search|send|set|share|start|submit|take\s+care\s+of|track|update|upload|write)\b/i;

const DYNAMIC_TOOL_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into", "is", "it",
  "mcp", "my", "of", "on", "or", "please", "that", "the", "this", "to", "tool", "use", "with", "you",
]);

const TOOL_TOKEN_EQUIVALENT_GROUPS = [
  ["generate", "generated", "generating", "make", "made", "create", "created", "creating", "draw", "drawn", "render", "rendered", "produce", "produced", "add", "put", "place", "placed"],
  ["image", "picture", "photo", "illustration", "graphic", "artwork", "visual"],
  ["connect", "connected", "connecting", "link", "linked", "pair", "paired", "integrate", "integrated"],
  ["log", "logged", "logging", "record", "recorded", "track", "tracked", "tracking"],
  ["complete", "completed", "completing", "mark", "marked", "done", "finish", "finished"],
  ["task", "todo"],
  ["delete", "deleted", "remove", "removed"],
  ["update", "updated", "edit", "edited", "change", "changed", "modify", "modified"],
  ["search", "searched", "find", "found", "lookup"],
] as const;

const TOOL_TOKEN_CANONICAL = new Map<string, string>(
  TOOL_TOKEN_EQUIVALENT_GROUPS.flatMap((group) => group.map((token) => [token, group[0]] as const)),
);

function normalizeDynamicToolToken(rawToken: string): string {
  let token = rawToken;
  if (token.length > 4 && token.endsWith("ies")) token = `${token.slice(0, -3)}y`;
  else if (token.length > 3 && token.endsWith("s") && !/(?:ss|us|is)$/.test(token)) token = token.slice(0, -1);
  return TOOL_TOKEN_CANONICAL.get(token) ?? token;
}

function dynamicToolTokens(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      .filter((token) => token.length >= 3 && !DYNAMIC_TOOL_STOP_WORDS.has(token))
      .map(normalizeDynamicToolToken),
  );
}

function isContextualToolFollowUp(text: string): boolean {
  const normalized = text
    .trim()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[.!?,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.split(/\s+/).length > 8 || CONTEXTUAL_TOOL_NEGATION_PATTERN.test(normalized)) {
    return false;
  }
  return CONTEXTUAL_TOOL_RETRY_PATTERN.test(normalized)
    || CONTEXTUAL_TOOL_CONFIRMATION_PATTERN.test(normalized);
}

function extractAssistantActionProposal(text: string): string | null {
  const proposals = [...text.matchAll(ASSISTANT_PROPOSAL_PATTERN)]
    .flatMap((match) => {
      const proposal = match[1]?.trim();
      return proposal ? [{ proposal, source: match[0] }] : [];
    });
  for (let index = proposals.length - 1; index >= 0; index -= 1) {
    const { proposal, source } = proposals[index];
    if (/\bor\b/i.test(proposal) || NON_ACTION_PROPOSAL_PATTERN.test(proposal)) return null;
    if (CONTEXTUAL_TOOL_NEGATION_PATTERN.test(source)) continue;
    if (SELF_DECLARATIVE_PROPOSAL_PATTERN.test(source) && !ACTION_PROPOSAL_PATTERN.test(proposal)) continue;
    if (/^(?:do\s+(?:it|that)|go\s+ahead|proceed)$/i.test(proposal)) continue;
    return proposal;
  }
  return null;
}

/**
 * Returns the action-bearing text that should be scored against offered tool
 * metadata. Short confirmations and retries carry no useful tokens by
 * themselves, so reuse only the immediately validated proposal/request.
 */
export function getToolMetadataRoutingText(
  messages: Array<{ role?: string; content?: unknown }>,
): string {
  const lastUserIndex = messages.findLastIndex((message) => (
    message.role === "user" && typeof message.content === "string"
  ));
  if (lastUserIndex < 0) return "";
  const lastUserText = String(messages[lastUserIndex].content);
  if (!isContextualToolFollowUp(lastUserText)) return lastUserText;

  const isRetry = CONTEXTUAL_TOOL_RETRY_PATTERN.test(lastUserText);
  const previousMessage = messages[lastUserIndex - 1];
  if (!isRetry) {
    if (previousMessage?.role !== "assistant" || typeof previousMessage.content !== "string") {
      return lastUserText;
    }
    return extractAssistantActionProposal(previousMessage.content) ?? lastUserText;
  }

  const contextFloor = Math.max(0, lastUserIndex - 2);
  for (let index = lastUserIndex - 1; index >= contextFloor; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && typeof message.content === "string") return message.content;
  }
  for (let index = lastUserIndex - 1; index >= contextFloor; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || typeof message.content !== "string") continue;
    const proposal = extractAssistantActionProposal(message.content);
    if (proposal) return proposal;
  }
  return lastUserText;
}

/**
 * Selects offered tools whose names or descriptions materially overlap the
 * user's request. This retains built-in and installed-tool extensibility
 * without making ordinary conversation pay for a buffered selection turn.
 */
export function selectRelevantToolNames(
  text: string,
  tools: Array<{ name: string; description?: string }>,
  limit = 12,
): string[] {
  const queryTokens = dynamicToolTokens(text);
  if (queryTokens.size === 0) return [];

  return tools
    .map((tool) => {
      const nameTokens = dynamicToolTokens(tool.name);
      const descriptionTokenList = [...dynamicToolTokens(tool.description ?? "")];
      const descriptionTokens = new Set(descriptionTokenList);
      const nameOverlap = [...nameTokens].filter((token) => queryTokens.has(token));
      const descriptionOverlap = [...descriptionTokens].filter((token) => (
        queryTokens.has(token) && !nameTokens.has(token)
      ));
      const score = (nameOverlap.length * 2) + descriptionOverlap.length;
      const nameActionToken = [...nameTokens][0];
      const matchesBuiltInNameAction = !tool.name.startsWith("mcp__")
        && queryTokens.size >= 3
        && !!nameActionToken
        && queryTokens.has(nameActionToken);
      const matchesDescriptionAction = descriptionTokenList.length > 0
        && queryTokens.has(descriptionTokenList[0]);
      const descriptionOnlyThreshold = tool.name.startsWith("mcp__") && matchesDescriptionAction ? 2 : 3;
      const relevant = nameOverlap.length >= 2
        || (nameOverlap.length >= 1 && descriptionOverlap.length >= 1)
        || matchesBuiltInNameAction
        || descriptionOverlap.length >= descriptionOnlyThreshold;
      return { name: tool.name, score, relevant };
    })
    .filter((candidate) => candidate.relevant)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, Math.max(0, limit))
    .map((candidate) => candidate.name);
}

/**
 * Preserve a tool route when a short affirmative user turn confirms an action
 * proposed by the immediately preceding assistant message.
 */
export function classifyToolAwareConversationRoute(
  messages: Array<{ role?: string; content?: unknown }>,
): ToolAwareRoutePlan {
  const lastUserIndex = messages.findLastIndex((message) => (
    message.role === "user" && typeof message.content === "string"
  ));
  const lastUserText = lastUserIndex >= 0 && typeof messages[lastUserIndex]?.content === "string"
    ? messages[lastUserIndex].content
    : "";
  const directRoute = classifyToolAwareRoute(lastUserText);
  if (directRoute.shouldPreferTool || !isContextualToolFollowUp(lastUserText)) {
    return directRoute;
  }

  const isRetry = CONTEXTUAL_TOOL_RETRY_PATTERN.test(lastUserText);
  if (!isRetry) {
    const previousMessage = messages[lastUserIndex - 1];
    if (previousMessage?.role !== "assistant" || typeof previousMessage.content !== "string") {
      return directRoute;
    }
    const proposal = extractAssistantActionProposal(previousMessage.content);
    return proposal ? classifyToolAwareRoute(proposal) : directRoute;
  }

  // A retry may need the prior user request when the assistant failure message
  // itself contains no action vocabulary. Do not reach further back and revive
  // an unrelated stale tool intent.
  const contextFloor = Math.max(0, lastUserIndex - 2);
  for (let index = lastUserIndex - 1; index >= contextFloor; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user" || typeof message.content !== "string") continue;
    const contextualRoute = classifyToolAwareRoute(message.content);
    if (contextualRoute.shouldPreferTool) return contextualRoute;
  }

  for (let index = lastUserIndex - 1; index >= contextFloor; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || typeof message.content !== "string") continue;
    const proposal = extractAssistantActionProposal(message.content);
    if (!proposal) continue;
    const contextualRoute = classifyToolAwareRoute(proposal);
    if (contextualRoute.shouldPreferTool) return contextualRoute;
  }

  return directRoute;
}
