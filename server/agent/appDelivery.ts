/**
 * appDelivery — package and deliver a completed standalone app project.
 *
 * 1. Runs a production build for the project's framework
 * 2. Zips the workspace (excluding node_modules/.git)
 * 3. Schedules cleanup of the zip after 7 days
 * 4. Notifies the user via all connected channels
 */

import * as fs from "fs";
import * as path from "path";
import { execSync, spawn, spawnSync } from "child_process";
import * as os from "os";
import * as zlib from "zlib";
import { db } from "../db";
import { eq } from "drizzle-orm";
import * as schema from "@shared/schema";
import { getChannel } from "../channels/registry";
import { stopProjectServer } from "./tools/projectShellTool";
import { sendToDiscordUser } from "../discord/manager";
import { hasGitHubPAT } from "../integrations/github";
import { getPublicBaseUrl } from "../publicUrl";
import { getProjectDownloadsDir } from "../projectStorage";
import { hydrateProjectWorkspace, saveProjectArchive, snapshotProjectWorkspace } from "../projectArtifacts";

const DOWNLOADS_DIR = getProjectDownloadsDir();
const ZIP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function isTransientDatabaseError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /database system is (in recovery mode|starting up)|connection terminated unexpectedly|terminating connection/i.test(message);
}

async function withTransientDbRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientDatabaseError(err) || attempt === 5) break;
      const delayMs = attempt * 1500;
      console.warn(`[AppDelivery] ${label} hit transient database error; retrying in ${delayMs}ms (attempt ${attempt}/5)`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

// ── Download token registry ──────────────────────────────────────────────────
// Maps projectId → { token, expiresAt } for time-limited, signed download URLs
// that work from Telegram/Discord without requiring Auth headers.
interface DownloadToken {
  token: string;
  expiresAt: number;
}
const downloadTokens = new Map<string, DownloadToken>();

export function generateDownloadToken(projectId: string): string {
  const token =
    Date.now().toString(36) +
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2);
  downloadTokens.set(projectId, { token, expiresAt: Date.now() + ZIP_TTL_MS });
  return token;
}

export function validateDownloadToken(projectId: string, token: string): boolean {
  const entry = downloadTokens.get(projectId);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    downloadTokens.delete(projectId);
    return false;
  }
  return entry.token === token;
}

function ensureDownloadsDir(): void {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

function countFiles(dir: string): number {
  try {
    const result = execSync(
      `find "${dir}" -not -path "*/node_modules/*" -not -path "*/.git/*" -type f | wc -l`,
      { timeout: 10000, encoding: "utf8" },
    );
    return parseInt(result.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function getZipSizeMb(zipPath: string): number {
  try {
    const stat = fs.statSync(zipPath);
    return Math.round((stat.size / 1024 / 1024) * 100) / 100;
  } catch {
    return 0;
  }
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function getDosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: dosTime, date: dosDate };
}

function createZipArchive(sourceDir: string, zipPath: string): void {
  const root = path.resolve(sourceDir);
  const files: { relativePath: string; fullPath: string; stat: fs.Stats }[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".gradle" || entry.name === "build") continue;
      if (entry.name.endsWith(".log")) continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(root, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push({ relativePath, fullPath, stat: fs.statSync(fullPath) });
    }
  };

  walk(root);

  const chunks: Buffer[] = [];
  const centralDirectory: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const data = fs.readFileSync(file.fullPath);
    const compressed = zlib.deflateRawSync(data);
    const name = Buffer.from(file.relativePath, "utf8");
    const crc = crc32(data);
    const dos = getDosDateTime(file.stat.mtime);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(dos.time, 10);
    localHeader.writeUInt16LE(dos.date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    chunks.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(dos.time, 12);
    centralHeader.writeUInt16LE(dos.date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralDirectory.push(centralHeader, name);

    offset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectorySize = centralDirectory.reduce((sum, chunk) => sum + chunk.length, 0);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectorySize, 12);
  end.writeUInt32LE(centralDirectoryOffset, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(zipPath, Buffer.concat([...chunks, ...centralDirectory, end]));
}

/**
 * Schedule the zip to be deleted after ZIP_TTL_MS (7 days).
 * Uses an unref'd timer so it doesn't prevent server shutdown.
 */
function scheduleZipCleanup(zipPath: string): void {
  const timer = setTimeout(() => {
    try {
      if (fs.existsSync(zipPath)) {
        fs.unlinkSync(zipPath);
        console.log(`[AppDelivery] cleaned up expired zip: ${zipPath}`);
      }
    } catch (err) {
      console.warn(`[AppDelivery] failed to delete zip ${zipPath}:`, err);
    }
  }, ZIP_TTL_MS);
  (timer as unknown as { unref(): void }).unref();
}

/**
 * Perform a startup-time cleanup pass: delete any zip files older than 7 days.
 * Safe to call on server boot.
 */
export function cleanupExpiredZips(): void {
  try {
    ensureDownloadsDir();
    const cutoff = Date.now() - ZIP_TTL_MS;
    for (const file of fs.readdirSync(DOWNLOADS_DIR)) {
      if (!file.endsWith(".zip")) continue;
      const fullPath = path.join(DOWNLOADS_DIR, file);
      try {
        const { mtimeMs } = fs.statSync(fullPath);
        if (mtimeMs < cutoff) {
          fs.unlinkSync(fullPath);
          console.log(`[AppDelivery] startup cleanup: deleted expired zip ${file}`);
        }
      } catch {
        // skip files we can't stat
      }
    }
  } catch {
    // non-fatal
  }
}

function validateAndroidProjectStructure(workspaceDir: string): string[] {
  const errors: string[] = [];
  const requireAny = (label: string, candidates: string[]) => {
    if (!candidates.some((candidate) => fs.existsSync(path.join(workspaceDir, candidate)))) {
      errors.push(`Missing ${label}`);
    }
  };
  requireAny("Android settings.gradle(.kts)", ["settings.gradle.kts", "settings.gradle"]);
  requireAny("Android root build.gradle(.kts)", ["build.gradle.kts", "build.gradle"]);
  requireAny("Android app/build.gradle(.kts)", ["app/build.gradle.kts", "app/build.gradle"]);
  requireAny("Gradle wrapper", ["gradlew", "gradlew.bat"]);
  if (!fs.existsSync(path.join(workspaceDir, "app/src/main/AndroidManifest.xml"))) {
    errors.push("Missing app/src/main/AndroidManifest.xml");
  }
  const sourceRoot = path.join(workspaceDir, "app/src/main");
  let hasSource = false;
  const pending = fs.existsSync(sourceRoot) ? [sourceRoot] : [];
  while (pending.length > 0 && !hasSource) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (/\.(?:kt|java)$/i.test(entry.name)) {
        hasSource = true;
        break;
      }
    }
  }
  if (!hasSource) errors.push("Missing Android Kotlin/Java application source");
  return errors;
}

/**
 * Run a production build for the given framework before packaging.
 * Logs a warning and continues if the build fails (zip is still created).
 */
async function runProductionBuild(workspaceDir: string, framework: string, signal?: AbortSignal): Promise<void> {
  if (framework === "android-kotlin") {
    const structuralErrors = validateAndroidProjectStructure(workspaceDir);
    if (structuralErrors.length > 0) {
      throw new Error(`Android source validation failed: ${structuralErrors.join("; ")}`);
    }
    const sdkRoot = process.env.ANDROID_HOME?.trim() || process.env.ANDROID_SDK_ROOT?.trim();
    if (!sdkRoot || !fs.existsSync(sdkRoot)) {
      console.log("[AppDelivery] Android SDK unavailable; packaging structurally validated Android source project");
      return;
    }
    if (signal?.aborted) {
      const error = new Error("Android delivery build aborted");
      error.name = "AbortError";
      throw error;
    }
    const gradle = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(gradle, ["--no-daemon", "testDebugUnitTest", "assembleDebug"], {
        cwd: workspaceDir,
        env: { ...process.env, ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const keepTail = (current: string, chunk: Buffer | string) => `${current}${chunk.toString()}`.slice(-4000);
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        child.kill("SIGTERM");
        const error = new Error("Android delivery build aborted");
        error.name = "AbortError";
        fail(error);
      };
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        fail(new Error("Android delivery build timed out after 15 minutes"));
      }, 15 * 60 * 1000);

      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk) => { stdout = keepTail(stdout, chunk); });
      child.stderr?.on("data", (chunk) => { stderr = keepTail(stderr, chunk); });
      child.once("error", fail);
      child.once("close", (status) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ status, stdout, stderr });
      });
    });
    if (result.status !== 0) {
      throw new Error(`Android production build failed: ${`${result.stdout}\n${result.stderr}`.trim().slice(-2000)}`);
    }
    const generatedApk = path.join(workspaceDir, "app/build/outputs/apk/debug/app-debug.apk");
    if (!fs.existsSync(generatedApk)) throw new Error("Android build completed without producing app-debug.apk");
    fs.copyFileSync(generatedApk, path.join(workspaceDir, "calculator-debug.apk"));
    return;
  }

  const packageJson = path.join(workspaceDir, "package.json");
  const nodeModules = path.join(workspaceDir, "node_modules");
  if (fs.existsSync(packageJson) && !fs.existsSync(nodeModules)) {
    console.log(`[AppDelivery] node_modules missing; running npm install in ${workspaceDir}`);
    const install = spawnSync("npm", ["install"], {
      cwd: workspaceDir,
      env: { ...process.env, HOME: os.homedir(), CI: "true" },
      encoding: "utf8",
      timeout: 300_000,
      stdio: "pipe",
    });
    if (install.status !== 0) {
      console.warn(`[AppDelivery] npm install exited ${install.status}; build may fail. STDERR: ${(install.stderr ?? "").slice(0, 800)}`);
    }
  }

  const buildCmds: Record<string, string[]> = {
    nextjs: ["npm", "run", "build"],
    "react-vite": ["npm", "run", "build"],
    "node-express": [],
    custom: ["npm", "run", "build"],
  };

  const args = buildCmds[framework] ?? buildCmds.custom;
  if (args.length === 0) {
    console.log(`[AppDelivery] framework=${framework} — no build step needed, skipping`);
    return;
  }

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: os.homedir(), CI: "true", NODE_ENV: "production" };
  console.log(`[AppDelivery] running production build: ${args.join(" ")} in ${workspaceDir}`);

  const result = spawnSync(args[0], args.slice(1), {
    cwd: workspaceDir,
    env,
    encoding: "utf8",
    timeout: 300_000,
    stdio: "pipe",
  });

  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").slice(0, 1000);
    console.warn(
      `[AppDelivery] production build exited ${result.status} for ${framework} — ` +
      `packaging source anyway.\nSTDERR: ${stderr}`,
    );
  } else {
    console.log(`[AppDelivery] production build succeeded for framework=${framework}`);
  }
}

export async function ensureProjectArchiveAvailable(
  projectId: string,
  signal?: AbortSignal,
): Promise<{ zipSizeMb: number; fileCount: number; framework: string }> {
  const [project] = await db
    .select()
    .from(schema.jarvisProjects)
    .where(eq(schema.jarvisProjects.id, projectId))
    .limit(1);

  if (!project) throw new Error(`Project ${projectId} not found`);

  const workspaceDir = project.workspaceDir;
  if (!workspaceDir) {
    throw new Error(`Workspace directory not found for project ${projectId}`);
  }
  await hydrateProjectWorkspace(projectId, workspaceDir);
  if (!fs.existsSync(workspaceDir)) {
    throw new Error(`Workspace directory not found for project ${projectId}`);
  }

  stopProjectServer(projectId);
  await snapshotProjectWorkspace(projectId, workspaceDir).catch(() => undefined);

  const framework = project.appFramework ?? "custom";

  await runProductionBuild(workspaceDir, framework, signal);

  ensureDownloadsDir();

  const zipPath = path.join(DOWNLOADS_DIR, `${projectId}.zip`);

  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }

  console.log(`[AppDelivery] zipping workspace for project ${projectId}: ${workspaceDir}`);

  try {
    createZipArchive(workspaceDir, zipPath);
  } catch (err) {
    throw new Error(`Failed to zip project workspace: ${String(err).slice(0, 300)}`);
  }

  if (!fs.existsSync(zipPath)) {
    throw new Error("Zip file was not created — zip command may have failed silently");
  }

  scheduleZipCleanup(zipPath);
  await withTransientDbRetry("save project archive", () => saveProjectArchive(projectId, zipPath));

  const zipSizeMb = getZipSizeMb(zipPath);
  const fileCount = countFiles(workspaceDir);
  console.log(`[AppDelivery] project ${projectId} packaged: ${zipSizeMb}MB, ${fileCount} files, framework=${framework}`);

  return { zipSizeMb, fileCount, framework };
}

export async function packageAndDeliverApp(
  projectId: string,
  userId: string,
  originChannel?: string,
  signal?: AbortSignal,
): Promise<{ downloadUrl: string; zipSizeMb: number }> {
  const [project] = await db
    .select()
    .from(schema.jarvisProjects)
    .where(eq(schema.jarvisProjects.id, projectId))
    .limit(1);

  if (!project) throw new Error(`Project ${projectId} not found`);

  const { zipSizeMb, fileCount, framework } = await ensureProjectArchiveAvailable(projectId, signal);

  // Generate a signed, time-limited download token so the link works from
  // Telegram/Discord without requiring bearer auth headers.
  const signedToken = generateDownloadToken(projectId);

  // Build an absolute URL so the link is usable in Telegram/Discord notifications.
  const baseUrl = getPublicBaseUrl();
  const downloadUrl = `${baseUrl}/api/downloads/project/${projectId}?token=${signedToken}`;

  // Fall back to the channel stored on the project record (set when the project was
  // first created) if no channel is supplied by the caller.  This ensures the
  // delivery notification reaches the right channel even when the job was re-queued
  // by the autonomous scheduler, which does not carry originChannel in its input.
  const effectiveChannel = originChannel ?? project.originChannel ?? undefined;

  // ── GitHub note ────────────────────────────────────────────────────────────
  const userHasGitHub = await hasGitHubPAT(userId).catch(() => false);
  const githubNote = userHasGitHub
    ? `\n\n🐙 **Push to GitHub?** Open the Projects tab in the app and tap "Push to GitHub" to create a repo and push your code directly — no zip needed.`
    : `\n\n💡 Connect GitHub in Settings to push directly to a repo next time.`;


  // ── Cloud deployment offer (opt-in) ───────────────────────────────────────
  // Deployment is always optional. We check whether credentials are available
  // so we can include a deployment offer in the notification, but we never
  // auto-deploy — the user must explicitly ask Jarvis to deploy.
  const hasVercel = !!process.env.VERCEL_TOKEN;
  const hasRailway = !!process.env.RAILWAY_TOKEN;

  // Strict framework → provider mapping, no cross-provider fallback:
  // nextjs/react-vite → Vercel only, node-express → Railway only.
  let deployOffer = "";
  if ((framework === "nextjs" || framework === "react-vite") && hasVercel) {
    deployOffer = `\n\n🚀 **Want a live URL?** Say "deploy my app" and Jarvis will publish it to Vercel.`;
  } else if (framework === "node-express" && hasRailway) {
    deployOffer = `\n\n🚀 **Want a live URL?** Say "deploy my app" and Jarvis will publish it to Railway.`;
  } else if ((hasVercel || hasRailway) && (framework === "custom" || !framework)) {
    const provider = hasVercel ? "Vercel" : "Railway";
    deployOffer = `\n\n🚀 **Want a live URL?** Say "deploy my app" and Jarvis will publish it to ${provider}.`;
  }

  const restoreNote = framework === "android-kotlin"
    ? "Open the project in Android Studio or run `./gradlew testDebugUnitTest assembleDebug`. If this worker had an Android SDK, `calculator-debug.apk` is included."
    : "The zip excludes node_modules — run `npm install` to restore dependencies.";
  const launchNote = fs.existsSync(path.join(project.workspaceDir ?? "", "jarvis-app.json"))
    ? `▶️ Open the Projects tab and tap **Open in Jarvis** to run the installed mini-app.\n\n`
    : "";
  const notificationText =
    `✅ **${project.title}** is complete!\n\n` +
    launchNote +
    `📦 Download your app: ${downloadUrl}\n` +
    `*(Link expires in 7 days)*\n\n` +
    `${restoreNote}\n\n` +
    `Tech stack: ${framework} · ${fileCount} files · ${zipSizeMb} MB` +
    githubNote +
    deployOffer;

  await sendDeliveryNotification(userId, effectiveChannel, notificationText);

  return { downloadUrl, zipSizeMb };
}

/** Send a notification to the appropriate channel(s) for a user. */
async function sendDeliveryNotification(
  userId: string,
  effectiveChannel: string | undefined,
  text: string,
): Promise<void> {
  try {
    const origin = (effectiveChannel ?? "").toLowerCase();
    if (origin === "telegram") {
      const telegramCh = getChannel("telegram");
      if (telegramCh) await telegramCh.sendMessage(userId, text, {}).catch(() => {});
    } else if (origin.startsWith("discord")) {
      await sendToDiscordUser(userId, text).catch(() => {});
    }
    const inAppCh = getChannel("in_app");
    if (inAppCh) await inAppCh.sendMessage(userId, text, {}).catch(() => {});
  } catch {
    console.warn(`[AppDelivery] failed to send notification to channel=${effectiveChannel}`);
  }
}
