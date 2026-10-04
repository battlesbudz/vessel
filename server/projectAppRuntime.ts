import * as fs from "node:fs";
import * as path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "./db";
import * as schema from "@shared/schema";
import { readProjectSnapshotFile } from "./projectArtifacts";
import { runAgent } from "./agent/harness";

export const JARVIS_APP_MANIFEST = "jarvis-app.json";
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_APP_HTML_BYTES = 2_000_000;
const MAX_TURN_INPUT_BYTES = 12_000;
const MAX_STORAGE_VALUE_BYTES = 50_000;
const MAX_STORAGE_TOTAL_BYTES = 200_000;
const MAX_STORAGE_KEYS = 100;

export interface JarvisAppManifest {
  schemaVersion: 1;
  name: string;
  entrypoint: string;
  permissions: Array<"agent.turn" | "storage">;
  agentInstructions?: string;
}

interface LaunchClaims {
  projectId: string;
  userId: string;
  expiresAt: number;
}

function signingKey(): string {
  const key = process.env.JWT_SECRET?.trim();
  if (!key) throw new Error("JWT_SECRET is required to launch Jarvis apps");
  return key;
}

function encodeClaims(claims: LaunchClaims): string {
  return Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
}

export function createProjectAppLaunchToken(projectId: string, userId: string): string {
  const payload = encodeClaims({ projectId, userId, expiresAt: Date.now() + TOKEN_TTL_MS });
  const signature = createHmac("sha256", signingKey()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyProjectAppLaunchToken(token: string, projectId: string): LaunchClaims | null {
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra) return null;
  const expectedSignature = createHmac("sha256", signingKey()).update(payload).digest("base64url");
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as LaunchClaims;
    if (claims.projectId !== projectId || !claims.userId || claims.expiresAt <= Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

function isSafeEntrypoint(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== ".." && !normalized.startsWith("../") && normalized.endsWith(".html");
}

export function parseJarvisAppManifest(raw: string): JarvisAppManifest {
  const parsed = JSON.parse(raw) as Partial<JarvisAppManifest>;
  if (parsed.schemaVersion !== 1) throw new Error("Unsupported Jarvis app manifest schemaVersion");
  if (typeof parsed.name !== "string" || !parsed.name.trim() || parsed.name.length > 80) throw new Error("Jarvis app manifest requires a valid name");
  if (typeof parsed.entrypoint !== "string" || !isSafeEntrypoint(parsed.entrypoint)) throw new Error("Jarvis app manifest requires a safe HTML entrypoint");
  if (!Array.isArray(parsed.permissions) || parsed.permissions.some((permission) => permission !== "agent.turn" && permission !== "storage")) {
    throw new Error("Jarvis app manifest contains an unsupported permission");
  }
  if (parsed.agentInstructions != null && (typeof parsed.agentInstructions !== "string" || parsed.agentInstructions.length > 2_000)) {
    throw new Error("Jarvis app agentInstructions must be at most 2,000 characters");
  }
  return {
    schemaVersion: 1,
    name: parsed.name.trim(),
    entrypoint: parsed.entrypoint,
    permissions: [...new Set(parsed.permissions)],
    ...(parsed.agentInstructions?.trim() ? { agentInstructions: parsed.agentInstructions.trim() } : {}),
  };
}

export function validateProjectAppWorkspace(workspaceDir: string): string[] {
  const errors: string[] = [];
  const manifestPath = path.join(workspaceDir, JARVIS_APP_MANIFEST);
  if (!fs.existsSync(manifestPath)) return [`Missing ${JARVIS_APP_MANIFEST}`];
  let manifest: JarvisAppManifest;
  try {
    manifest = parseJarvisAppManifest(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return [error instanceof Error ? error.message : "Invalid Jarvis app manifest"];
  }
  const root = path.resolve(workspaceDir);
  const entrypoint = path.resolve(root, manifest.entrypoint);
  if (!entrypoint.startsWith(root + path.sep) || !fs.existsSync(entrypoint) || !fs.statSync(entrypoint).isFile()) {
    errors.push(`Missing Jarvis app entrypoint ${manifest.entrypoint}`);
    return errors;
  }
  const html = fs.readFileSync(entrypoint, "utf8");
  if (Buffer.byteLength(html, "utf8") > MAX_APP_HTML_BYTES) errors.push("Jarvis app entrypoint exceeds the 2 MB limit");
  if (/<script\b[^>]*\bsrc\s*=|<link\b[^>]*\bhref\s*=|<(?:img|audio|video|source)\b[^>]*\bsrc\s*=\s*["'](?!data:|blob:)/i.test(html)) {
    errors.push("Jarvis app entrypoint must be self-contained with inline code and data URLs");
  }
  const directNavigation = /(?:\b(?:window|document|self|top|parent)\s*\.\s*)?location\s*(?:=|\.href\s*=|\.assign\s*\(|\.replace\s*\()|(?:window|document|self)\s*\[\s*["']location["']\s*\]\s*(?:=|\.href\s*=|\.assign\s*\(|\.replace\s*\()|(?:window\s*\.\s*)?open\s*\(/i;
  if (directNavigation.test(html) || /<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh\b/i.test(html)) {
    errors.push("Jarvis app entrypoint may not initiate browser navigation");
  }
  return errors;
}

async function readProjectText(project: schema.JarvisProject, relativePath: string): Promise<string | null> {
  if (project.workspaceDir) {
    const root = path.resolve(project.workspaceDir);
    const fullPath = path.resolve(root, relativePath);
    if (fullPath.startsWith(root + path.sep) && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return fs.readFileSync(fullPath, "utf8");
    }
  }
  const snapshot = await readProjectSnapshotFile(project.id, relativePath);
  return snapshot?.content ?? null;
}

export async function loadProjectApp(projectId: string, userId?: string): Promise<{
  project: schema.JarvisProject;
  manifest: JarvisAppManifest;
  html: string;
}> {
  const conditions = [eq(schema.jarvisProjects.id, projectId)];
  if (userId) conditions.push(eq(schema.jarvisProjects.userId, userId));
  const [project] = await db.select().from(schema.jarvisProjects).where(and(...conditions)).limit(1);
  if (!project) throw new Error("Project not found");
  if (project.status !== "complete") throw new Error("Project is not complete");
  const manifestText = await readProjectText(project, JARVIS_APP_MANIFEST);
  if (!manifestText) throw new Error("This project is not installable in Jarvis");
  const manifest = parseJarvisAppManifest(manifestText);
  const html = await readProjectText(project, manifest.entrypoint);
  if (!html) throw new Error("Jarvis app entrypoint is missing");
  if (Buffer.byteLength(html, "utf8") > MAX_APP_HTML_BYTES) throw new Error("Jarvis app entrypoint exceeds the 2 MB limit");
  return { project, manifest, html };
}

function bridgeScript(permissions: JarvisAppManifest["permissions"]): string {
  const allowed = JSON.stringify(permissions);
  return `<script>(()=>{const navigationApi=globalThis.navigation;if(!navigationApi||typeof navigationApi.addEventListener!=='function')throw new DOMException('Navigation isolation is unavailable in this browser','SecurityError');navigationApi.addEventListener('navigate',(event)=>{if(!event.hashChange)event.preventDefault();});const allowed=new Set(${allowed});let sequence=0;const pending=new Map();function request(type,payload){return new Promise((resolve,reject)=>{const requestId=String(++sequence);pending.set(requestId,{resolve,reject});parent.postMessage({source:'jarvis-app',type,requestId,payload},'*');setTimeout(()=>{if(pending.delete(requestId))reject(new Error('Jarvis bridge request timed out'));},30000);});}addEventListener('message',(event)=>{if(event.source!==parent)return;const message=event.data;if(!message||message.source!=='jarvis-host'||!message.requestId)return;const item=pending.get(message.requestId);if(!item)return;pending.delete(message.requestId);message.ok?item.resolve(message.result):item.reject(new Error(message.error||'Jarvis bridge request failed'));});addEventListener('submit',(event)=>event.preventDefault(),true);addEventListener('click',(event)=>{const target=event.target;const anchor=target&&typeof target.closest==='function'?target.closest('a[href]'):null;if(anchor){const href=anchor.getAttribute('href')||'';if(!href.startsWith('#'))event.preventDefault();}},true);const blockNavigation=()=>{throw new DOMException('Navigation is blocked in Jarvis apps','SecurityError');};try{location.assign=blockNavigation;location.replace=blockNavigation;}catch{}window.open=()=>null;window.jarvis=Object.freeze({permissions:Object.freeze([...allowed]),agentTurn:(payload)=>{if(!allowed.has('agent.turn'))return Promise.reject(new Error('agent.turn permission not granted'));return request('agent.turn',payload);},storage:Object.freeze({get:(key)=>{if(!allowed.has('storage'))return Promise.reject(new Error('storage permission not granted'));return request('storage.get',{key});},set:(key,value)=>{if(!allowed.has('storage'))return Promise.reject(new Error('storage permission not granted'));return request('storage.set',{key,value});}})});parent.postMessage({source:'jarvis-app',type:'ready'},'*');})();</script>`;
}

function injectBridge(html: string, permissions: JarvisAppManifest["permissions"]): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; navigate-to 'none'">`;
  const prelude = `${csp}${bridgeScript(permissions)}`;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (head) => `${head}${prelude}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (root) => `${root}<head>${prelude}</head>`);
  }
  return `${prelude}${html}`;
}

export function renderProjectAppShell(projectId: string, manifest: JarvisAppManifest, html: string, token: string): string {
  const appHtml = Buffer.from(injectBridge(html, manifest.permissions), "utf8").toString("base64");
  const title = manifest.name.replace(/[<>&"']/g, "");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${title}</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;background:#090b10}body{overflow:hidden}.blocked{box-sizing:border-box;padding:24px;color:#f4f6fb;font:16px/1.5 system-ui,sans-serif}</style></head><body><iframe id="app" title="${title}" sandbox="allow-scripts allow-modals allow-pointer-lock" referrerpolicy="no-referrer"></iframe><script>(()=>{const frame=document.getElementById('app');if(!globalThis.navigation||typeof globalThis.navigation.addEventListener!=='function'){const message=document.createElement('div');message.className='blocked';message.textContent='This Jarvis app cannot launch because this browser cannot enforce navigation isolation.';frame.replaceWith(message);return;}const token=${JSON.stringify(token)};const projectId=${JSON.stringify(projectId)};const allowed=new Set(${JSON.stringify(manifest.permissions)});const prefix='jarvis-app:'+projectId+':';const maxValueBytes=${MAX_STORAGE_VALUE_BYTES};const maxTotalBytes=${MAX_STORAGE_TOTAL_BYTES};const maxKeys=${MAX_STORAGE_KEYS};frame.srcdoc=new TextDecoder().decode(Uint8Array.from(atob(${JSON.stringify(appHtml)}),c=>c.charCodeAt(0)));function reply(requestId,ok,result,error){frame.contentWindow.postMessage({source:'jarvis-host',requestId,ok,result,error},'*');}function storageEntries(){const entries=[];for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key&&key.startsWith(prefix))entries.push([key,localStorage.getItem(key)||'']);}return entries;}addEventListener('message',async(event)=>{if(event.source!==frame.contentWindow)return;const message=event.data;if(!message||message.source!=='jarvis-app'||!message.requestId)return;try{if(message.type==='storage.get'){if(!allowed.has('storage'))throw new Error('storage permission not granted');const key=String(message.payload?.key||'').slice(0,100);reply(message.requestId,true,JSON.parse(localStorage.getItem(prefix+key)||'null'));return;}if(message.type==='storage.set'){if(!allowed.has('storage'))throw new Error('storage permission not granted');const key=String(message.payload?.key||'').slice(0,100);if(!key)throw new Error('Storage key is required');const encoded=JSON.stringify(message.payload?.value??null);const encodedBytes=new TextEncoder().encode(encoded).length;if(encodedBytes>maxValueBytes)throw new Error('Stored value exceeds 50 KB');const fullKey=prefix+key;const entries=storageEntries();const existing=localStorage.getItem(fullKey);if(existing===null&&entries.length>=maxKeys)throw new Error('Jarvis app storage key limit reached');let totalBytes=entries.reduce((sum,[,value])=>sum+new TextEncoder().encode(value).length,0);if(existing!==null)totalBytes-=new TextEncoder().encode(existing).length;totalBytes+=encodedBytes;if(totalBytes>maxTotalBytes)throw new Error('Jarvis app storage limit reached');localStorage.setItem(fullKey,encoded);reply(message.requestId,true,true);return;}if(message.type==='agent.turn'){if(!allowed.has('agent.turn'))throw new Error('agent.turn permission not granted');const response=await fetch('/api/project-apps/'+encodeURIComponent(projectId)+'/agent-turn',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+token},body:JSON.stringify({input:message.payload})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Agent turn failed');reply(message.requestId,true,data.result);return;}throw new Error('Unsupported bridge request');}catch(error){reply(message.requestId,false,null,error instanceof Error?error.message:String(error));}});})();</script></body></html>`;
}

const turnWindows = new Map<string, number[]>();
function enforceTurnRateLimit(key: string): void {
  const cutoff = Date.now() - 60_000;
  const recent = (turnWindows.get(key) ?? []).filter((time) => time > cutoff);
  if (recent.length >= 20) throw new Error("Jarvis app agent-turn limit reached; try again in a minute");
  recent.push(Date.now());
  turnWindows.set(key, recent);
}

export async function runProjectAppAgentTurn(projectId: string, userId: string, input: unknown): Promise<unknown> {
  const { project, manifest } = await loadProjectApp(projectId, userId);
  if (!manifest.permissions.includes("agent.turn")) throw new Error("This Jarvis app does not have agent.turn permission");
  const serialized = JSON.stringify(input ?? null);
  if (Buffer.byteLength(serialized, "utf8") > MAX_TURN_INPUT_BYTES) throw new Error("Agent turn input exceeds 12 KB");
  enforceTurnRateLimit(`${userId}:${projectId}`);
  const result = await runAgent({
    messages: [
      { role: "system", content: `You are Jarvis acting inside the installed mini-app \"${manifest.name}\". Follow the app interaction rules and return exactly one JSON value with no markdown. ${manifest.agentInstructions ?? "Respond with the best valid action for the current app state."}` },
      { role: "user", content: `Project goal: ${project.goal ?? "(none)"}\nCurrent app input/state:\n${serialized}` },
    ],
    tools: [],
    toolChoice: "none",
    maxTurns: 1,
    maxCompletionTokens: 500,
    context: { userId, channel: "ProjectAppRuntime", state: { pendingAttachments: [] }, projectId },
  });
  const text = result.reply.trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Jarvis returned an invalid app action");
  }
}
