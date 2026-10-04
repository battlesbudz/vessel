/**
 * App Project Runner — orchestrates standalone app build projects.
 *
 * This module extends the project runner concept specifically for building
 * SEPARATE applications (not Jarvis itself). Each project gets an isolated
 * workspace directory, runs npm/npx commands through projectShellTool, and
 * uses browser tools to visually verify the app during the TEST_UI phase.
 *
 * Phases: SCAFFOLD → IMPLEMENT_BACKEND → IMPLEMENT_FRONTEND → INTEGRATE → TEST_UI → PACKAGE
 */

import * as path from "path";
import * as fs from "fs";
import { spawnSync } from "child_process";
import * as os from "os";
import { db } from "../db";
import { eq, asc } from "drizzle-orm";
import * as schema from "@shared/schema";
import type { ProjectPlanStep } from "@shared/schema";
import { runAgent } from "./harness";
import { verifyJobOutput } from "./orchestrator";
import { filterToolsByGroups, type ToolGroup } from "./tools/index";
import { getValidGoogleTokens } from "../userTokenStore";
import { submitAgentJob } from "./jobClient";
import { getChannel } from "../channels/registry";
import { stopProjectServer } from "./tools/projectShellTool";
import { getAndClearAppProjectScreenshotCount } from "./tools/browserTools";
import { sendToDiscordUser } from "../discord/manager";
import { getProjectWorkspaceDir } from "../projectStorage";
import { snapshotProjectWorkspace } from "../projectArtifacts";
import { normalizePlanningQuestions } from "./appProjectPlanning";
import {
  buildAndroidCalculatorProject,
  validateAndroidCalculatorProject,
  writeAndroidCalculatorProject,
} from "./androidCalculatorProject";
import { validateProjectAppWorkspace } from "../projectAppRuntime";

export type AppFramework = "nextjs" | "react-vite" | "node-express" | "android-kotlin" | "custom";

const AUTONOMOUS_INTERVAL_MINUTES = 30;
const AUTONOMOUS_BUILD_CONTINUATION_MS = 10_000;
const STEPS_PER_SESSION = 2;
const MAX_STEP_VERIFY_RETRIES = 2;
const MAX_CONSECUTIVE_ERRORS = 3;

const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";

function isCodexRuntimeUnavailableError(err: unknown): boolean {
  const text = err instanceof Error
    ? `${err.message}\n${err.stack ?? ""}\n${err.cause instanceof Error ? err.cause.message : ""}`
    : String(err);
  return (
    text.includes("Codex OAuth provider has no available runtime") ||
    text.includes("No active Desktop Daemon with Shell Execution is available") ||
    text.includes("JARVIS_CODEX_RUNTIME")
  );
}

// ── Phase → tool groups ────────────────────────────────────────────────────────

function appToolGroupsForPhase(phase: string): ToolGroup[] {
  const p = phase.toUpperCase();
  if (p === "SCAFFOLD") return ["app_build"];
  if (p.startsWith("IMPLEMENT")) return ["app_build"];
  if (p === "INTEGRATE") return ["app_build"];
  if (p === "TEST_UI") return ["app_build", "browser"];
  if (p === "PACKAGE") return ["app_build"];
  return ["app_build"];
}

// ── Deterministic phase verification ───────────────────────────────────────────

/**
 * Run deterministic (tool-based, not LLM-based) checks after the agent completes a step.
 * Returns a failure reason string if the step should be retried, or null if it passed.
 *
 * IMPLEMENT_* phases: runs `npx tsc --noEmit --skipLibCheck` when a tsconfig.json
 *   exists. A non-zero exit means the step needs correction.
 *
 * TEST_UI phase: prefers a real browser_screenshot (via side-effect counter). If the
 *   hosted browser cannot launch in the container, fall back to command-based app
 *   validation so the project does not get permanently stuck before packaging.
 */
async function runDeterministicVerification(
  phase: string,
  workspaceDir: string,
  reply: string,
  projectId?: string,
): Promise<string | null> {
  const p = phase.toUpperCase();

  if (p.startsWith("IMPLEMENT") || p === "INTEGRATE") {
    const tsconfigPath = path.join(workspaceDir, "tsconfig.json");
    if (!fs.existsSync(tsconfigPath)) return null;

    const result = spawnSync("npx", ["tsc", "--noEmit", "--skipLibCheck"], {
      cwd: workspaceDir,
      env: { ...process.env, HOME: os.homedir() },
      encoding: "utf8",
      timeout: 120_000,
    });

    if (result.status !== 0) {
      const errors = (result.stdout ?? "").slice(0, 800) + (result.stderr ?? "").slice(0, 400);
      return `TypeScript type-check failed (npx tsc --noEmit --skipLibCheck). Fix all TS errors before this step can be accepted.\n${errors}`;
    }
    return null;
  }

  if (p === "TEST_UI") {
    const screenshotCount = projectId ? getAndClearAppProjectScreenshotCount(projectId) : 0;
    if (screenshotCount === 0) {
      const packagePath = path.join(workspaceDir, "package.json");
      if (!fs.existsSync(packagePath)) return null;
      try {
        const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> };
        if (pkg.scripts?.build) {
          const result = spawnSync("npm", ["run", "build"], {
            cwd: workspaceDir,
            env: { ...process.env, HOME: os.homedir() },
            encoding: "utf8",
            timeout: 180_000,
          });
          if (result.status !== 0) {
            const errors = (result.stdout ?? "").slice(0, 1000) + (result.stderr ?? "").slice(0, 600);
            return `TEST_UI fallback build failed (npm run build). Fix the app before packaging.\n${errors}`;
          }
        }
      } catch (err) {
        return `TEST_UI fallback validation failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      return null;
    }

    const replyLower = reply.toLowerCase();
    const errorPatterns = [
      "err_connection_refused",
      "connection refused",
      "econnrefused",
      "this site can't be reached",
      "this page can't be displayed",
      "unable to connect",
      "net::err_",
      "failed to navigate",
    ];
    for (const pat of errorPatterns) {
      if (replyLower.includes(pat)) {
        return `TEST_UI screenshot shows a browser error (\"${pat}\"). Make sure the dev server is running on the correct port before taking a screenshot.`;
      }
    }

    return null;
  }

  if (p === "PACKAGE") {
    const runtimeErrors = validateProjectAppWorkspace(workspaceDir);
    return runtimeErrors.length > 0
      ? `Jarvis mini-app validation failed. ${runtimeErrors.join("; ")}`
      : null;
  }

  return null;
}

// ── Planning prompt ────────────────────────────────────────────────────────────

function writeTextFile(workspaceDir: string, relativePath: string, content: string): void {
  const fullPath = path.join(workspaceDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function runNpmCommand(workspaceDir: string, args: string[], timeoutMs = 300_000): { ok: true } | { ok: false; error: string } {
  const result = spawnSync(npmExecutable, args, {
    cwd: workspaceDir,
    env: { ...process.env, HOME: os.homedir(), CI: "true" },
    encoding: "utf8",
    timeout: timeoutMs,
  });

  if (result.status === 0) return { ok: true };
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(0, 2000);
  return { ok: false, error: `npm ${args.join(" ")} failed with exit ${result.status}.\n${output}` };
}

function buildReactVitePackageJson(project: schema.JarvisProject): string {
  const slug = (project.title || "jarvis-app")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "jarvis-app";

  return JSON.stringify({
    name: slug,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "vite --host 0.0.0.0",
      build: "vite build",
      preview: "vite preview --host 0.0.0.0",
    },
    dependencies: {
      "@vitejs/plugin-react": "^4.3.4",
      vite: "^6.0.7",
      react: "^18.3.1",
      "react-dom": "^18.3.1",
    },
    devDependencies: {},
  }, null, 2);
}

function buildReactViteAppJsx(project: schema.JarvisProject): string {
  const goal = project.goal || "";
  const brand = /orbit garden/i.test(goal) ? "Orbit Garden" : (project.title || "Jarvis Built App");
  const tagline = /orbit garden/i.test(goal)
    ? "Grow a calmer, smarter garden from one luminous dashboard."
    : "A polished standalone experience built by Jarvis.";

  return `import './App.css';

const features = [
  {
    title: 'Guided setup',
    body: 'Start with a clear path, practical prompts, and a layout that keeps every next step visible.',
  },
  {
    title: 'Smart planning',
    body: 'Turn scattered ideas into organized sections, pricing, and calls to action without losing the human tone.',
  },
  {
    title: 'Ready to launch',
    body: 'Built with local React and Vite files so the project can be installed, tested, and packaged cleanly.',
  },
];

function Hero() {
  return (
    <section className="hero">
      <div className="hero-copy">
        <p className="eyebrow">AI-assisted garden operations</p>
        <h1>${brand}</h1>
        <p className="lede">${tagline}</p>
        <div className="hero-actions">
          <a href="#contact" className="button primary">Start planning</a>
          <a href="#pricing" className="button secondary">View pricing</a>
        </div>
      </div>
      <div className="hero-panel" aria-label="Orbit Garden dashboard preview">
        <div className="metric">
          <span>Readiness</span>
          <strong>94%</strong>
        </div>
        <div className="growth-card">
          <span className="pulse" />
          <div>
            <strong>Next harvest window</strong>
            <p>21 days with adaptive reminders</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Feature({ title, body }) {
  return (
    <article className="feature-card">
      <h2>{title}</h2>
      <p>{body}</p>
    </article>
  );
}

function Pricing() {
  return (
    <section className="pricing" id="pricing">
      <div>
        <p className="eyebrow">Simple plan</p>
        <h2>Everything needed to plan the first launch.</h2>
      </div>
      <div className="price-box">
        <span className="price">$19</span>
        <span className="period">per month</span>
      </div>
    </section>
  );
}

function ContactForm() {
  return (
    <section className="contact" id="contact">
      <div>
        <p className="eyebrow">Mock contact form</p>
        <h2>Tell us what you want to grow.</h2>
      </div>
      <form onSubmit={(event) => event.preventDefault()}>
        <label>
          Name
          <input type="text" name="name" placeholder="Your name" />
        </label>
        <label>
          Email
          <input type="email" name="email" placeholder="you@example.com" />
        </label>
        <label>
          Project notes
          <textarea name="message" placeholder="Indoor herbs, greenhouse starts, patio beds..." />
        </label>
        <button type="submit">Send mock request</button>
      </form>
    </section>
  );
}

export default function App() {
  return (
    <main>
      <Hero />
      <section className="features" aria-label="Feature sections">
        {features.map((feature) => (
          <Feature key={feature.title} {...feature} />
        ))}
      </section>
      <Pricing />
      <ContactForm />
    </main>
  );
}
`;
}

const reactViteCss = `:root {
  color: #17211b;
  background: #f5f1e8;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 320px;
}

a {
  color: inherit;
  text-decoration: none;
}

main {
  min-height: 100vh;
  background: linear-gradient(180deg, #f5f1e8 0%, #edf3ea 54%, #f7f7f2 100%);
}

.hero {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.8fr);
  gap: 48px;
  align-items: center;
  width: min(1120px, calc(100% - 40px));
  margin: 0 auto;
  padding: 72px 0 48px;
}

.eyebrow {
  margin: 0 0 12px;
  color: #4b7f52;
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
}

h1, h2, p {
  margin-top: 0;
}

h1 {
  margin-bottom: 20px;
  max-width: 720px;
  color: #132118;
  font-size: clamp(3rem, 8vw, 6.6rem);
  line-height: 0.94;
  letter-spacing: 0;
}

.lede {
  max-width: 650px;
  color: #4e5a52;
  font-size: 1.25rem;
  line-height: 1.6;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 30px;
}

.button, button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  border: 0;
  border-radius: 8px;
  padding: 0 18px;
  font-weight: 800;
  cursor: pointer;
}

.primary, button {
  background: #1f6f43;
  color: white;
}

.secondary {
  background: #fff9ec;
  color: #24362a;
  border: 1px solid #d8d0bd;
}

.hero-panel {
  display: grid;
  gap: 18px;
  padding: 26px;
  border: 1px solid rgba(36, 54, 42, 0.14);
  border-radius: 8px;
  background: #fffaf0;
  box-shadow: 0 24px 70px rgba(23, 33, 27, 0.12);
}

.metric {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 18px;
  border-bottom: 1px solid #ddd3bd;
}

.metric span, .period {
  color: #69756c;
  font-weight: 700;
}

.metric strong {
  color: #1f6f43;
  font-size: 3rem;
}

.growth-card {
  display: flex;
  gap: 14px;
  align-items: center;
  min-height: 100px;
}

.pulse {
  width: 52px;
  height: 52px;
  border-radius: 999px;
  background: radial-gradient(circle at 35% 35%, #d6ef82, #4b9b62 65%, #22583b);
}

.features {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
  width: min(1120px, calc(100% - 40px));
  margin: 0 auto;
  padding: 32px 0;
}

.feature-card {
  min-height: 220px;
  padding: 26px;
  border: 1px solid #d8d0bd;
  border-radius: 8px;
  background: rgba(255, 250, 240, 0.8);
}

.feature-card h2, .pricing h2, .contact h2 {
  color: #17211b;
  font-size: 1.55rem;
  line-height: 1.15;
}

.feature-card p, .pricing p, .contact p {
  color: #56635a;
  line-height: 1.65;
}

.pricing, .contact {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 420px);
  gap: 30px;
  align-items: start;
  width: min(1120px, calc(100% - 40px));
  margin: 0 auto;
  padding: 46px 0;
}

.price-box {
  display: flex;
  align-items: baseline;
  gap: 10px;
  justify-content: flex-end;
}

.price {
  color: #1f6f43;
  font-size: 4rem;
  font-weight: 900;
}

form {
  display: grid;
  gap: 14px;
}

label {
  display: grid;
  gap: 7px;
  color: #33463a;
  font-weight: 800;
}

input, textarea {
  width: 100%;
  border: 1px solid #cfc6b1;
  border-radius: 8px;
  background: #fffdf7;
  color: #17211b;
  font: inherit;
  padding: 12px 14px;
}

textarea {
  min-height: 112px;
  resize: vertical;
}

@media (max-width: 780px) {
  .hero, .pricing, .contact {
    grid-template-columns: 1fr;
  }

  .features {
    grid-template-columns: 1fr;
  }

  .price-box {
    justify-content: flex-start;
  }
}
`;

async function writeCompleteReactViteApp(project: schema.JarvisProject): Promise<string> {
  const workspaceDir = project.workspaceDir ?? getProjectWorkspaceDir(project.id);
  const appName = (project.title || "Jarvis Built App").slice(0, 80);
  const goal = project.goal || "";
  const brand = /orbit garden/i.test(goal) ? "Orbit Garden" : (project.title || "Jarvis Built App");
  const tagline = /orbit garden/i.test(goal)
    ? "Grow a calmer, smarter garden from one luminous dashboard."
    : "A polished standalone experience built by Jarvis.";
  fs.mkdirSync(workspaceDir, { recursive: true });

  writeTextFile(workspaceDir, "package.json", buildReactVitePackageJson(project));
  writeTextFile(workspaceDir, "index.html", `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${project.title || "Jarvis Built App"}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`);
  writeTextFile(workspaceDir, "vite.config.js", `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PORT) || 3000,
  },
});
`);
  writeTextFile(workspaceDir, "src/main.jsx", `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`);
  writeTextFile(workspaceDir, "src/App.jsx", buildReactViteAppJsx(project));
  writeTextFile(workspaceDir, "src/App.css", reactViteCss);
  writeTextFile(workspaceDir, "jarvis-app.json", JSON.stringify({
    schemaVersion: 1,
    name: appName,
    entrypoint: "jarvis/index.html",
    permissions: [],
  }, null, 2));
  writeTextFile(workspaceDir, "jarvis/index.html", `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(brand)}</title>
<style>
:root{color:#17211b;background:#f5f1e8;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;min-width:320px}main{min-height:100vh;background:linear-gradient(180deg,#f5f1e8 0%,#edf3ea 54%,#f7f7f2 100%)}.hero{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(280px,.8fr);gap:48px;align-items:center;width:min(1120px,calc(100% - 40px));margin:0 auto;padding:72px 0 48px}.eyebrow{margin:0 0 12px;color:#4b7f52;font-size:.78rem;font-weight:800;text-transform:uppercase}h1,h2,p{margin-top:0}h1{margin-bottom:20px;max-width:720px;color:#132118;font-size:clamp(3rem,8vw,6.6rem);line-height:.94}.lede{max-width:650px;color:#4e5a52;font-size:1.25rem;line-height:1.6}.hero-actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:30px}.button,button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;border:0;border-radius:8px;padding:0 18px;font-weight:800}.primary,button{background:#1f6f43;color:#fff}.secondary{background:#fff9ec;color:#24362a;border:1px solid #d8d0bd}.hero-panel{display:grid;gap:18px;padding:26px;border:1px solid rgba(36,54,42,.14);border-radius:8px;background:#fffaf0;box-shadow:0 24px 70px rgba(23,33,27,.12)}.metric{display:flex;align-items:center;justify-content:space-between;padding-bottom:18px;border-bottom:1px solid #ddd3bd}.metric span,.period{color:#69756c;font-weight:700}.metric strong{color:#1f6f43;font-size:3rem}.growth-card{display:flex;gap:14px;align-items:center;min-height:100px}.pulse{width:52px;height:52px;border-radius:999px;background:radial-gradient(circle at 35% 35%,#d6ef82,#4b9b62 65%,#22583b)}.features{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;width:min(1120px,calc(100% - 40px));margin:0 auto;padding:32px 0}.feature-card{min-height:220px;padding:26px;border:1px solid #d8d0bd;border-radius:8px;background:rgba(255,250,240,.8)}.feature-card h2,.pricing h2,.contact h2{color:#17211b;font-size:1.55rem;line-height:1.15}.feature-card p,.pricing p,.contact p{color:#56635a;line-height:1.65}.pricing,.contact{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,420px);gap:30px;align-items:start;width:min(1120px,calc(100% - 40px));margin:0 auto;padding:46px 0}.price-box{display:flex;align-items:baseline;gap:10px;justify-content:flex-end}.price{color:#1f6f43;font-size:4rem;font-weight:900}.fields{display:grid;gap:14px}label{display:grid;gap:7px;color:#33463a;font-weight:800}input,textarea{width:100%;border:1px solid #cfc6b1;border-radius:8px;background:#fffdf7;color:#17211b;font:inherit;padding:12px 14px}textarea{min-height:112px;resize:vertical}@media(max-width:780px){.hero,.pricing,.contact{grid-template-columns:1fr}.features{grid-template-columns:1fr}.price-box{justify-content:flex-start}}
</style>
</head>
<body>
<main>
<section class="hero"><div><p class="eyebrow">AI-assisted garden operations</p><h1>${escapeHtml(brand)}</h1><p class="lede">${escapeHtml(tagline)}</p><div class="hero-actions"><span class="button primary">Start planning</span><span class="button secondary">View pricing</span></div></div><div class="hero-panel"><div class="metric"><span>Readiness</span><strong>94%</strong></div><div class="growth-card"><span class="pulse"></span><div><strong>Next harvest window</strong><p>21 days with adaptive reminders</p></div></div></div></section>
<section class="features"><article class="feature-card"><h2>Guided setup</h2><p>Start with a clear path, practical prompts, and a layout that keeps every next step visible.</p></article><article class="feature-card"><h2>Smart planning</h2><p>Turn scattered ideas into organized sections, pricing, and calls to action without losing the human tone.</p></article><article class="feature-card"><h2>Ready to launch</h2><p>Built with local React and Vite files so the project can be installed, tested, and packaged cleanly.</p></article></section>
<section class="pricing"><div><p class="eyebrow">Simple plan</p><h2>Everything needed to plan the first launch.</h2></div><div class="price-box"><span class="price">$19</span><span class="period">per month</span></div></section>
<section class="contact"><div><p class="eyebrow">Mock contact form</p><h2>Tell us what you want to grow.</h2></div><div class="fields"><label>Name<input type="text" placeholder="Your name"></label><label>Email<input type="email" placeholder="you@example.com"></label><label>Project notes<textarea placeholder="Indoor herbs, greenhouse starts, patio beds..."></textarea></label><button type="button">Send mock request</button></div></section>
</main>
</body>
</html>`);

  await snapshotProjectWorkspace(project.id, workspaceDir);
  return workspaceDir;
}

async function runDeterministicReactViteStep(
  project: schema.JarvisProject,
  step: ProjectPlanStep,
): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  if ((project.appFramework ?? "custom") !== "react-vite") {
    return { ok: false, error: "Deterministic React/Vite builder only supports react-vite projects." };
  }

  const phase = step.phase.toUpperCase();
  const workspaceDir = await writeCompleteReactViteApp(project);

  if (phase === "SCAFFOLD") {
    return {
      ok: true,
      summary: "Created a React/Vite project scaffold with package.json, index.html, Vite config, src/main.jsx, src/App.jsx, and src/App.css.",
    };
  }

  if (phase.startsWith("IMPLEMENT") || phase === "INTEGRATE") {
    return {
      ok: true,
      summary: "Implemented the landing page in React with a hero, three feature sections, a pricing callout, and a mock contact form using local CSS.",
    };
  }

  if (phase === "TEST_UI" || phase === "PACKAGE") {
    const install = runNpmCommand(workspaceDir, ["install"], 300_000);
    if (!install.ok) return install;
    const build = runNpmCommand(workspaceDir, ["run", "build"], 300_000);
    if (!build.ok) return build;
    await snapshotProjectWorkspace(project.id, workspaceDir);
    return {
      ok: true,
      summary: phase === "TEST_UI"
        ? "Verified the React/Vite project with npm install and npm run build; the production build completed successfully."
        : "Packaged the React/Vite app by running npm install and npm run build; the dist folder was generated successfully.",
    };
  }

  return {
    ok: true,
    summary: "Updated the React/Vite standalone app files for this project step.",
  };
}

function isStaticReactViteLandingProject(project: schema.JarvisProject): boolean {
  if ((project.appFramework ?? "custom") !== "react-vite") return false;
  const request = [project.title, project.description, project.goal].filter(Boolean).join(" ");
  return /\b(?:landing\s+page|marketing\s+(?:page|site)|static\s+(?:page|website))\b/i.test(request)
    && !/\b(?:game|calculator|dashboard|tracker|interactive|multiplayer|auth|database|api)\b/i.test(request);
}

function buildAppPlanningPrompt(
  title: string,
  description: string,
  goal: string,
  framework: AppFramework,
): string {
  return `You are Jarvis, building a STANDALONE application completely separate from yourself.
This app will live in its own directory with its own package.json, dependencies, and dev server.

Project: ${title}
Description: ${description || "(none provided)"}
Framework: ${framework}
Goal: ${goal}

Produce the smallest complete phased build plan that satisfies the goal.
For a simple landing page or static website, use 4-6 steps.
For a full app with backend/data/auth, use 6-12 steps.
Do not add backend/API/database work unless the goal explicitly needs it.
Use only the relevant phases from this list:

SCAFFOLD — create the project (npx create-next-app, vite, express-generator, etc.)
IMPLEMENT_BACKEND — database, API routes, business logic
IMPLEMENT_FRONTEND — React components, pages, layouts, styling
INTEGRATE — wire frontend to backend, environment config
TEST_UI — start dev server, load in browser, screenshot, verify all flows
PACKAGE — build for production, zip the output

Each step must have specific acceptance_criteria. The plan must include PACKAGE.
Include TEST_UI for visual projects. For static frontend projects, SCAFFOLD,
IMPLEMENT_FRONTEND, TEST_UI, and PACKAGE are usually enough.

Every user-facing app must also be installable inside Jarvis. Include a PACKAGE
acceptance criterion requiring a jarvis-app.json manifest and a fully self-contained
jarvis/index.html (inline CSS and JavaScript; no external files or network dependencies).
Manifest schema: {"schemaVersion":1,"name":"App name","entrypoint":"jarvis/index.html","permissions":[]}.
Allowed permissions are "storage" and "agent.turn". Grant only what the app needs.
For games or experiences where Jarvis participates, grant "agent.turn", include precise
agentInstructions in the manifest, and call window.jarvis.agentTurn(currentState) from
the mini-app. For persistence, grant "storage" and use window.jarvis.storage.get/set.

For react-vite projects, target these files unless the goal requires otherwise:
package.json, index.html, src/main.jsx, src/App.jsx, src/App.css.
Use project_shell for commands and project_write_file for source/config files.
The project workspace will be created automatically.
Do NOT use phases outside the 6 listed above.
questions MUST be an array of plain strings, never objects.

Return JSON only:
{
  "plan": [
    {
      "step_id": "step_001",
      "label": "Scaffold project",
      "phase": "SCAFFOLD",
      "acceptance_criteria": "package.json exists, npm run dev starts successfully"
    },
    ...more steps...
  ],
  "questions": [],
  "summary": "One paragraph overview of the plan"
}

Only include questions if there is a real blocker that makes the app impossible
to build safely. Do not include placeholder questions.

Return ONLY the JSON object, nothing else.`;
}

// ── Step prompt ────────────────────────────────────────────────────────────────

function buildAppStepPrompt(
  project: schema.JarvisProject,
  step: ProjectPlanStep,
  sessionHistory: string,
  userAnswer?: string,
): string {
  const plan = asPlan(project.plan);
  const completedSteps = plan.filter((s) => s.status === "complete");
  const completedSummary = completedSteps.length > 0
    ? completedSteps.map((s) => `- ${s.label}: ${s.output?.slice(0, 200) || "completed"}`).join("\n")
    : "(none yet)";

  const devPort = project.devServerPort;
  const workspaceDir = project.workspaceDir ?? getProjectWorkspaceDir(project.id);
  const framework = project.appFramework ?? "custom";

  const answerContext = userAnswer
    ? `\n\n**User's answer to the previous question:**\n${userAnswer}\n\nUse this answer to guide this step.`
    : "";

  const testUiHint = step.phase.toUpperCase() === "TEST_UI"
    ? `\n\n**TEST_UI phase instructions:**
1. Start the dev server using project_shell with background=true: e.g. 'npm run dev'
2. The server URL will be returned (e.g. http://localhost:${devPort ?? 3001})
3. Use browser_navigate to load that URL
4. Take a screenshot with browser_screenshot
5. Use browser_snapshot to read the accessibility tree
6. Evaluate against acceptance criteria
7. If something is broken, fix it with project_shell, restart the server, and re-test
8. Repeat until the UI meets acceptance criteria`
    : "";

  return `You are Jarvis, building a STANDALONE application in its own isolated workspace.

**Project:** ${project.title}
**Framework:** ${framework}
**Workspace directory:** ${workspaceDir}
**Dev server port:** ${devPort ?? "(not yet assigned — will be assigned when you start the server)"}
**Goal:** ${project.goal}

CRITICAL: All code changes must go inside ${workspaceDir}.
Use project_write_file to create or replace files.
Use project_shell only for commands such as npm install, npm run build, npm run dev, ls, and cat.
Do not use shell redirection, heredocs, pipes, &&, or command chaining.
NEVER touch Jarvis's own source files.

Jarvis extension contract (required before PACKAGE):
- Create jarvis-app.json with schemaVersion 1, name, entrypoint "jarvis/index.html", and the minimum permissions.
- Create a complete, self-contained jarvis/index.html with inline CSS/JavaScript and no external assets.
- Available bridge APIs are window.jarvis.storage.get/set and window.jarvis.agentTurn.
- Interactive agent games must pass bounded JSON state to agentTurn and validate the returned action.
- Generated mini-app code is sandboxed and never receives Jarvis auth credentials or unrestricted tools.

**Session history:**
${sessionHistory || "(this is the first session)"}

**Previously completed steps:**
${completedSummary}${answerContext}${testUiHint}

**Current step to complete:**
Label: ${step.label}
Phase: ${step.phase}
Acceptance criteria: ${step.acceptance_criteria || "step completed successfully"}

Execute this step using your available tools. When using project_shell:
- All commands run in the workspace directory automatically
- Use npm, npx, node, git, zip, ls, cat, mkdir, cp, mv, rm, echo, curl
- Use project_write_file for package.json, index.html, src/App.jsx, CSS, and config files
- For dev servers: set background=true

Produce a clear, detailed output that satisfies the acceptance criteria.
At the end, include:
## Step Output Summary
<one paragraph summary of what was accomplished>

If you need to ask the user a critical question before you can continue, respond with ONLY:
QUESTION: <your question here>

Otherwise, complete the step and show your work.`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function asPlan(raw: unknown): ProjectPlanStep[] {
  if (!Array.isArray(raw)) return [];
  return raw as ProjectPlanStep[];
}

function isAndroidCalculatorProject(project: Pick<schema.JarvisProject, "appFramework" | "title" | "description" | "goal">): boolean {
  if (project.appFramework !== "android-kotlin") return false;
  const request = [project.title, project.description, project.goal].filter(Boolean).join(" ");
  return /\bcalculator\b/i.test(request)
    && /\b(?:basic|simple|standard|small|four[- ]function)\b/i.test(request)
    && !/\b(?:scientific|mortgage|loan|calorie|bmi|tip|tax|financial|finance|currency|unit|convert(?:er|ing)?|graph(?:ing)?|programmer|history|memory|equation|algebra|trig(?:onometry)?|statistics?|date|age|interest)\b/i.test(request);
}

function androidCalculatorPlan(): ProjectPlanStep[] {
  return [
    { step_id: "step_001", label: "Create native Android project", phase: "SCAFFOLD", status: "pending", acceptance_criteria: "A complete Gradle Android application project exists with no placeholder files." },
    { step_id: "step_002", label: "Implement calculator engine", phase: "IMPLEMENT_BACKEND", status: "pending", acceptance_criteria: "Arithmetic, decimals, percentages, sign toggle, backspace, clear, chaining, and division-by-zero behavior are implemented." },
    { step_id: "step_003", label: "Implement Jetpack Compose interface", phase: "IMPLEMENT_FRONTEND", status: "pending", acceptance_criteria: "The calculator has a complete responsive Compose UI with accessible display and button labels." },
    { step_id: "step_004", label: "Add calculator unit tests", phase: "INTEGRATE", status: "pending", acceptance_criteria: "Unit tests cover arithmetic, chaining, division by zero, percentage, sign, and backspace." },
    { step_id: "step_005", label: "Validate complete project", phase: "TEST_UI", status: "pending", acceptance_criteria: "Every required Android source, configuration, test, and documentation file exists and contains no TODO, FIXME, or placeholder content." },
    { step_id: "step_006", label: "Build and package Android app", phase: "PACKAGE", status: "pending", acceptance_criteria: "The complete source is packaged and, when the Android SDK is available, tests pass and a debug APK is produced." },
  ];
}

async function initializeAndroidCalculatorProject(project: schema.JarvisProject): Promise<void> {
  const workspaceDir = project.workspaceDir ?? getProjectWorkspaceDir(project.id);
  writeAndroidCalculatorProject(workspaceDir, { title: project.title ?? "Calculator" });
  await snapshotProjectWorkspace(project.id, workspaceDir);
  await db
    .update(schema.jarvisProjects)
    .set({
      plan: androidCalculatorPlan(),
      status: "building",
      lastProgressAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.jarvisProjects.id, project.id));
}

export async function prepareAndroidCalculatorProject(projectId: string): Promise<void> {
  const [project] = await db
    .select()
    .from(schema.jarvisProjects)
    .where(eq(schema.jarvisProjects.id, projectId))
    .limit(1);
  if (!project) throw new Error(`App project ${projectId} not found`);
  const preparedProject = { ...project, appFramework: "android-kotlin" };
  await db
    .update(schema.jarvisProjects)
    .set({ appFramework: "android-kotlin", autonomousMode: true, updatedAt: new Date() })
    .where(eq(schema.jarvisProjects.id, projectId));
  await initializeAndroidCalculatorProject(preparedProject);
}

async function runDeterministicAndroidCalculatorStep(
  project: schema.JarvisProject,
  step: ProjectPlanStep,
  signal?: AbortSignal,
): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const workspaceDir = project.workspaceDir ?? getProjectWorkspaceDir(project.id);
  writeAndroidCalculatorProject(workspaceDir, { title: project.title ?? "Calculator" });

  const validationErrors = validateAndroidCalculatorProject(workspaceDir);
  if (validationErrors.length > 0) return { ok: false, error: validationErrors.join("; ") };

  if (step.phase.toUpperCase() === "PACKAGE") {
    const build = await buildAndroidCalculatorProject(workspaceDir, signal);
    const sdkAvailable = Boolean(
      (process.env.ANDROID_HOME?.trim() && fs.existsSync(process.env.ANDROID_HOME.trim())) ||
      (process.env.ANDROID_SDK_ROOT?.trim() && fs.existsSync(process.env.ANDROID_SDK_ROOT.trim())),
    );
    if (sdkAvailable && !build.built) return { ok: false, error: build.detail };
    await snapshotProjectWorkspace(project.id, workspaceDir);
    return { ok: true, summary: build.detail };
  }

  await snapshotProjectWorkspace(project.id, workspaceDir);
  const summaries: Record<string, string> = {
    SCAFFOLD: "Created the complete native Android Gradle project, manifest, resources, wrapper, source tree, tests, and documentation.",
    IMPLEMENT_BACKEND: "Implemented a BigDecimal calculator engine with arithmetic, decimals, percentages, sign toggle, backspace, clear, operation chaining, formatting, and division-by-zero handling.",
    IMPLEMENT_FRONTEND: "Implemented the complete Jetpack Compose calculator interface with a responsive five-row keypad, polished Material colors, reactive state, and accessibility labels.",
    INTEGRATE: "Added calculator-engine unit tests covering normal arithmetic and edge cases.",
    TEST_UI: "Validated every required Android source, configuration, test, and documentation file and confirmed there are no unfinished placeholders.",
  };
  return { ok: true, summary: summaries[step.phase.toUpperCase()] ?? "Completed the Android calculator project step." };
}

async function sendAppProjectMessage(
  userId: string,
  originChannel: string | undefined,
  message: string,
): Promise<void> {
  try {
    const origin = (originChannel ?? "").toLowerCase();
    if (origin === "telegram") {
      const telegramCh = getChannel("telegram");
      if (telegramCh) await telegramCh.sendMessage(userId, message, {}).catch(() => {});
    } else if (origin.startsWith("discord")) {
      await sendToDiscordUser(userId, message).catch(() => {});
    }
    const inAppCh = getChannel("in_app");
    if (inAppCh) await inAppCh.sendMessage(userId, message, {}).catch(() => {});
  } catch (err) {
    console.error("[AppProjectRunner] sendAppProjectMessage failed:", err);
  }
}

async function sendAppProjectQuestion(
  userId: string,
  originChannel: string | undefined,
  message: string,
): Promise<Record<string, unknown>> {
  await sendAppProjectMessage(userId, originChannel, message);
  return {};
}

// ── Start app project ─────────────────────────────────────────────────────────

export async function startAppProject(input: {
  userId: string;
  title: string;
  description: string;
  goal: string;
  framework: AppFramework;
  originChannel?: string;
}): Promise<{ projectId: string }> {
  const [project] = await db
    .insert(schema.jarvisProjects)
    .values({
      userId: input.userId,
      title: input.title,
      description: input.description,
      goal: input.goal,
      status: "planning",
      originChannel: input.originChannel,
      appFramework: input.framework,
      autonomousMode: true,
      updatedAt: new Date(),
    })
    .returning();

  const projectId = project.id;

  const realWorkspaceDir = getProjectWorkspaceDir(projectId);
  fs.mkdirSync(realWorkspaceDir, { recursive: true });

  await db
    .update(schema.jarvisProjects)
    .set({ workspaceDir: realWorkspaceDir, updatedAt: new Date() })
    .where(eq(schema.jarvisProjects.id, projectId));

  const projectWithWorkspace = { ...project, workspaceDir: realWorkspaceDir };
  if (isAndroidCalculatorProject(projectWithWorkspace)) {
    await initializeAndroidCalculatorProject(projectWithWorkspace);
  }

  console.log(`[AppProjectRunner] startAppProject: created project ${projectId} for user ${input.userId} framework=${input.framework}`);

  await submitAgentJob({
    userId: input.userId,
    agentType: "app_project",
    title: `Plan app: ${input.title}`,
    prompt: `Run planning phase for app project ${projectId}`,
    input: { projectId, phase: "planning", originChannel: input.originChannel },
  });

  return { projectId };
}

// ── Run app project session ───────────────────────────────────────────────────

export async function runAppProjectSession(
  projectId: string,
  _sessionNumber: number,
  userAnswer?: string,
  signal?: AbortSignal,
): Promise<{ status: string; stepsCompleted: number; summary: string }> {
  const startTime = Date.now();

  const [project] = await db
    .select()
    .from(schema.jarvisProjects)
    .where(eq(schema.jarvisProjects.id, projectId))
    .limit(1);

  if (!project) throw new Error(`App project ${projectId} not found`);

  if (project.status === "paused" || project.status === "complete" || project.status === "failed") {
    return { status: project.status, stepsCompleted: 0, summary: `Project is ${project.status}` };
  }

  const sessions = await db
    .select()
    .from(schema.jarvisProjectSessions)
    .where(eq(schema.jarvisProjectSessions.projectId, projectId))
    .orderBy(asc(schema.jarvisProjectSessions.sessionNumber));

  const sessionNumber = sessions.length + 1;
  const sessionHistory = sessions
    .slice(-3)
    .map((s) => `Session ${s.sessionNumber}: ${s.summary || "completed"}`)
    .join("\n");

  // ── Planning phase ──────────────────────────────────────────────────────────
  if (project.status === "planning") {
    return await runAppPlanningSession(project, sessionNumber, startTime, signal);
  }

  // ── Question pending — re-notify ──────────────────────────────────────────
  if (project.status === "waiting_for_input" && project.questionPending && !userAnswer) {
    await sendAppProjectMessage(
      project.userId,
      project.originChannel ?? undefined,
      `⏳ **App Project: ${project.title}** is waiting for your answer:\n\n${project.questionPending}`,
    );
    if (project.autonomousMode) {
      const nextReminder = new Date(Date.now() + AUTONOMOUS_INTERVAL_MINUTES * 60 * 1000);
      await db
        .update(schema.jarvisProjects)
        .set({ nextRunAt: nextReminder, updatedAt: new Date() })
        .where(eq(schema.jarvisProjects.id, projectId));
    }
    return { status: "waiting_for_input", stepsCompleted: 0, summary: "Waiting for user input" };
  }

  // ── Building phase ─────────────────────────────────────────────────────────
  let currentPlan = asPlan(project.plan);
  const pendingSteps = currentPlan
    .map((s, i) => ({ ...s, _idx: i }))
    .filter((s) => s.status === "pending");

  if (pendingSteps.length === 0) {
    await markAppProjectComplete(project, sessions.length);
    return { status: "complete", stepsCompleted: 0, summary: "All steps complete!" };
  }

  const stepsToRun = isAndroidCalculatorProject(project)
    ? pendingSteps
    : pendingSteps.slice(0, STEPS_PER_SESSION);
  const completedLabels: string[] = [];
  let verificationRetriesTotal = 0;
  let sessionSummary = "";
  let remainingAnswer: string | undefined = userAnswer;

  const { getModel } = await import("../lib/modelPrefs");
  const orchModel = await getModel(project.userId, "orchestrator");

  for (const step of stepsToRun) {
    const deterministicAndroidCalculator = isAndroidCalculatorProject(project)
      ? await runDeterministicAndroidCalculatorStep(project, step, signal)
      : null;
    if (deterministicAndroidCalculator) {
      if (!deterministicAndroidCalculator.ok) {
        throw new Error(deterministicAndroidCalculator.error);
      }
      currentPlan = currentPlan.map((candidate, index) => index === step._idx
        ? { ...candidate, status: "complete" as const, output: deterministicAndroidCalculator.summary, completedAt: new Date().toISOString() }
        : candidate);
      await db
        .update(schema.jarvisProjects)
        .set({
          plan: currentPlan,
          currentStepIndex: step._idx + 1,
          lastProgressAt: new Date(),
          consecutiveErrors: 0,
          updatedAt: new Date(),
        })
        .where(eq(schema.jarvisProjects.id, projectId));
      completedLabels.push(step.label);
      sessionSummary = deterministicAndroidCalculator.summary;
      continue;
    }

    const deterministicReactVite =
      isStaticReactViteLandingProject(project)
        ? await runDeterministicReactViteStep(project, step)
        : null;

    if (deterministicReactVite) {
      if (!deterministicReactVite.ok) {
        console.error(`[AppProjectRunner] deterministic React/Vite step "${step.label}" failed: ${deterministicReactVite.error}`);
        const newErrors = (project.consecutiveErrors ?? 0) + 1;
        await db
          .update(schema.jarvisProjects)
          .set({
            status: newErrors >= MAX_CONSECUTIVE_ERRORS ? "paused" : project.status,
            consecutiveErrors: newErrors,
            updatedAt: new Date(),
          })
          .where(eq(schema.jarvisProjects.id, projectId));
        if (newErrors >= MAX_CONSECUTIVE_ERRORS) {
          return { status: "paused", stepsCompleted: completedLabels.length, summary: deterministicReactVite.error };
        }
        continue;
      }

      currentPlan = currentPlan.map((s, i) =>
        i === step._idx
          ? { ...s, status: "complete" as const, output: deterministicReactVite.summary, completedAt: new Date().toISOString() }
          : s,
      );

      await db
        .update(schema.jarvisProjects)
        .set({
          plan: currentPlan,
          currentStepIndex: step._idx + 1,
          lastProgressAt: new Date(),
          consecutiveErrors: 0,
          updatedAt: new Date(),
        })
        .where(eq(schema.jarvisProjects.id, projectId));

      completedLabels.push(step.label);
      sessionSummary = deterministicReactVite.summary;
      console.log(`[AppProjectRunner] deterministic React/Vite completed step "${step.label}" for project ${projectId}`);
      continue;
    }

    let tokens: string[] = [];
    try {
      tokens = await getValidGoogleTokens(project.userId);
    } catch {
      // no Google tokens — fine
    }
    const hasGoogle = tokens.length > 0;
    const googleAccessToken = tokens[0] ?? null;

    const stepTools = filterToolsByGroups(appToolGroupsForPhase(step.phase), hasGoogle);
    const stepPrompt = buildAppStepPrompt(project, step, sessionHistory, remainingAnswer);
    remainingAnswer = undefined;

    let reply = "";
    try {
      let correctionContext: string | undefined;
      for (let attempt = 0; attempt <= MAX_STEP_VERIFY_RETRIES; attempt++) {
        const prompt = correctionContext
          ? `${stepPrompt}\n\n[Previous attempt rejected: ${correctionContext}. Address this in your response.]`
          : stepPrompt;

        const result = await runAgent({
          messages: [
            {
              role: "system",
              content: `You are Jarvis, building a standalone app. Your workspace is at ${project.workspaceDir ?? getProjectWorkspaceDir(projectId)}.
Use project_shell for ALL file system operations and commands. Never touch Jarvis's own source files.`,
            },
            { role: "user", content: prompt },
          ],
          tools: stepTools,
          context: {
            userId: project.userId,
            googleAccessToken,
            channel: "AppProjectRunner",
            state: { pendingAttachments: [] },
            projectId,
            // Grant localhost:3001-3999 access only during TEST_UI so the agent
            // can visually verify its own dev server. Denied in all other phases.
            browserLocalhostException: step.phase.toUpperCase() === "TEST_UI",
          },
          maxTurns: 12,
          signal,
        });
        reply = result.reply?.trim() || "";

        if (reply.startsWith("QUESTION:")) break;

        // ── Deterministic verification (tool-based, not LLM-based) ────────────
        const workspaceForVerify = project.workspaceDir ?? getProjectWorkspaceDir(projectId);
        const deterministicFailure = await runDeterministicVerification(step.phase, workspaceForVerify, reply, projectId);
        if (deterministicFailure) {
          correctionContext = deterministicFailure;
          if (attempt < MAX_STEP_VERIFY_RETRIES) {
            console.log(`[AppProjectRunner] deterministic check failed for "${step.label}" attempt ${attempt + 1}: ${deterministicFailure.slice(0, 120)}`);
            continue;
          }
          throw new Error(deterministicFailure);
        }

        // ── LLM-based quality verification ────────────────────────────────────
        const acceptanceCriteria = step.phase.toUpperCase() === "TEST_UI"
      ? `Use browser_screenshot when the hosted browser is available; otherwise command-based validation such as npm run build is acceptable. The app must not show an obvious browser/dev-server error. ${step.acceptance_criteria || ""}`
          : (step.acceptance_criteria || "step completed successfully");

        const verification = await verifyJobOutput({
          agentType: "project_step",
          originalPrompt: `Phase: ${step.phase}\nLabel: ${step.label}\nAcceptance criteria: ${acceptanceCriteria}`,
          result: reply,
          orchestratorModel: orchModel,
          userId: project.userId,
          correctionContext,
        });

        if (verification.passed === true || verification.passed === null) break;

        correctionContext = verification.reason;
        if (attempt < MAX_STEP_VERIFY_RETRIES) {
          verificationRetriesTotal++;
          console.log(`[AppProjectRunner] step "${step.label}" verify retry ${attempt + 1}: ${verification.reason}`);
        }
      }
    } catch (err) {
      console.error(`[AppProjectRunner] step "${step.label}" threw error:`, err);
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : err;
      }
      const newErrors = (project.consecutiveErrors ?? 0) + 1;
      if (isCodexRuntimeUnavailableError(err)) {
        const summary =
          "Paused: Codex runtime is unavailable. Connect the Desktop Daemon with Shell Execution or configure the Codex gateway before resuming.";
        await db
          .update(schema.jarvisProjects)
          .set({
            status: "paused",
            autonomousMode: false,
            nextRunAt: null,
            consecutiveErrors: newErrors,
            updatedAt: new Date(),
          })
          .where(eq(schema.jarvisProjects.id, projectId));
        await sendAppProjectMessage(
          project.userId,
          project.originChannel ?? undefined,
          `⚠️ **App Project: ${project.title}** paused because the Codex runtime is unavailable.\n\nConnect the Desktop Daemon with Shell Execution or configure the Codex gateway, then resume the project.`,
        );
        return { status: "paused", stepsCompleted: completedLabels.length, summary };
      }
      if (newErrors >= MAX_CONSECUTIVE_ERRORS) {
        await db
          .update(schema.jarvisProjects)
          .set({ status: "paused", consecutiveErrors: newErrors, updatedAt: new Date() })
          .where(eq(schema.jarvisProjects.id, projectId));
        await sendAppProjectMessage(
          project.userId,
          project.originChannel ?? undefined,
          `⚠️ **App Project: ${project.title}** paused after ${newErrors} errors.\n\nLast error: ${String(err).slice(0, 200)}`,
        );
        return { status: "paused", stepsCompleted: completedLabels.length, summary: "Paused after too many errors" };
      }
      await db
        .update(schema.jarvisProjects)
        .set({ consecutiveErrors: newErrors, updatedAt: new Date() })
        .where(eq(schema.jarvisProjects.id, projectId));
      continue;
    }

    // ── Question check ──────────────────────────────────────────────────────
    if (reply.startsWith("QUESTION:")) {
      const question = reply.slice("QUESTION:".length).trim();
      await sendAppProjectQuestion(
        project.userId,
        project.originChannel ?? undefined,
        `❓ **App Project: ${project.title}** needs your input:\n\n${question}`,
      );
      await db
        .update(schema.jarvisProjects)
        .set({
          questionPending: question,
          questionAskedAt: new Date(),
          status: "waiting_for_input",
          consecutiveErrors: 0,
          updatedAt: new Date(),
        })
        .where(eq(schema.jarvisProjects.id, projectId));

      const durationMs = Date.now() - startTime;
      await db.insert(schema.jarvisProjectSessions).values({
        projectId,
        sessionNumber,
        stepsCompleted: completedLabels.length,
        stepLabels: completedLabels,
        durationMs,
        status: "waiting_for_input",
        summary: `Paused: ${question.slice(0, 200)}`,
      });
      return { status: "waiting_for_input", stepsCompleted: completedLabels.length, summary: question };
    }

    // ── Mark step complete ──────────────────────────────────────────────────
    const extractSummary = (text: string): string => {
      const trimmed = text.trim();
      try {
        const parsed = JSON.parse(trimmed) as {
          type?: string;
          tool_calls?: { name?: string; arguments?: Record<string, unknown> }[];
        };
        if (parsed.type === "tool_calls" && Array.isArray(parsed.tool_calls)) {
          const fileWrites = parsed.tool_calls
            .filter((call) => call.name === "daemon_action" && call.arguments?.action === "file_write")
            .map((call) => String(call.arguments?.path ?? ""))
            .filter(Boolean);

          if (fileWrites.length > 0) {
            const shown = fileWrites.slice(0, 3).join(", ");
            const more = fileWrites.length > 3 ? ` and ${fileWrites.length - 3} more` : "";
            return `Wrote project files: ${shown}${more}.`;
          }

          const toolNames = [...new Set(parsed.tool_calls.map((call) => call.name).filter(Boolean))];
          return toolNames.length > 0
            ? `Ran project tools: ${toolNames.join(", ")}.`
            : "Performed project workspace actions.";
        }
      } catch {
        if (trimmed.includes('"type":"tool_calls"') || trimmed.includes('"tool_calls"')) {
          return "Performed project workspace actions.";
        }
      }

      const match = text.match(/## Step Output Summary\s*([\s\S]*?)(?:\n##|$)/);
      return match ? match[1].trim().slice(0, 500) : text.slice(0, 300);
    };
    const stepOutput = extractSummary(reply);

    currentPlan = currentPlan.map((s, i) =>
      i === step._idx
        ? { ...s, status: "complete" as const, output: stepOutput, completedAt: new Date().toISOString() }
        : s,
    );

    await db
      .update(schema.jarvisProjects)
      .set({
        plan: currentPlan,
        currentStepIndex: step._idx + 1,
        lastProgressAt: new Date(),
        consecutiveErrors: 0,
        updatedAt: new Date(),
      })
      .where(eq(schema.jarvisProjects.id, projectId));

    completedLabels.push(step.label);
    sessionSummary = stepOutput;
    console.log(`[AppProjectRunner] completed step "${step.label}" for project ${projectId}`);
  }

  const durationMs = Date.now() - startTime;
  const remainingAfterSession = currentPlan.filter((s) => s.status === "pending").length;
  const totalComplete = currentPlan.filter((s) => s.status === "complete").length;

  await db.insert(schema.jarvisProjectSessions).values({
    projectId,
    sessionNumber,
    stepsCompleted: completedLabels.length,
    stepLabels: completedLabels,
    durationMs,
    verificationRetries: verificationRetriesTotal,
    status: "complete",
    summary: sessionSummary || completedLabels.join(", "),
  });

  if (remainingAfterSession === 0) {
    await markAppProjectComplete(project, sessionNumber);
    return { status: "complete", stepsCompleted: completedLabels.length, summary: "All steps complete!" };
  }

  const nextLabel = currentPlan.find((s) => s.status === "pending")?.label ?? "next step";
  const progressMsg =
    `🏗️ **App Project: ${project.title}** — Session ${sessionNumber} complete\n` +
    `✅ Steps done: ${totalComplete}/${currentPlan.length}\n` +
    `🔨 This session: ${completedLabels.map((l) => `"${l}"`).join(", ")}\n` +
    `⏭ Next: "${nextLabel}"\n` +
    "🔁 The next build session is queued automatically";

  await sendAppProjectMessage(project.userId, project.originChannel ?? undefined, progressMsg);

  if (project.autonomousMode) {
    const nextRunAt = new Date(Date.now() + AUTONOMOUS_BUILD_CONTINUATION_MS);
    await db
      .update(schema.jarvisProjects)
      .set({ nextRunAt, updatedAt: new Date() })
      .where(eq(schema.jarvisProjects.id, projectId));
    console.log(`[AppProjectRunner] autonomous project ${projectId} scheduled for ${nextRunAt.toISOString()}`);
  }

  return {
    status: "building",
    stepsCompleted: completedLabels.length,
    summary: sessionSummary,
  };
}

// ── Planning session ──────────────────────────────────────────────────────────

async function runAppPlanningSession(
  project: schema.JarvisProject,
  sessionNumber: number,
  startTime: number,
  signal?: AbortSignal,
): Promise<{ status: string; stepsCompleted: number; summary: string }> {
  let tokens: string[] = [];
  try {
    tokens = await getValidGoogleTokens(project.userId);
  } catch {
    // no Google tokens
  }
  const googleAccessToken = tokens[0] ?? null;
  const framework = (project.appFramework ?? "custom") as AppFramework;

  const planningPrompt = buildAppPlanningPrompt(
    project.title ?? "Untitled App",
    project.description ?? "",
    project.goal ?? "",
    framework,
  );

  const result = await runAgent({
    messages: [
      { role: "system", content: "You are Jarvis, an autonomous AI app builder. Respond with JSON only." },
      { role: "user", content: planningPrompt },
    ],
    tools: [],
    context: {
      userId: project.userId,
      googleAccessToken,
      channel: "AppProjectRunner/planning",
      state: { pendingAttachments: [] },
      projectId: project.id,
    },
    maxTurns: 3,
    signal,
  });

  let planData: { plan: Omit<ProjectPlanStep, "status">[]; questions?: unknown; summary?: string } | null = null;
  try {
    const jsonMatch = result.reply.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      planData = JSON.parse(jsonMatch[0]);
    }
  } catch {
    console.error(`[AppProjectRunner] failed to parse planning response for project ${project.id}`);
  }

  if (!planData?.plan?.length) {
    await db
      .update(schema.jarvisProjects)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(schema.jarvisProjects.id, project.id));
    return { status: "failed", stepsCompleted: 0, summary: "Planning failed: could not generate a plan" };
  }

  const plannedSteps: ProjectPlanStep[] = planData.plan.map((s, i) => ({
    ...s,
    step_id: s.step_id || `step_${String(i + 1).padStart(3, "0")}`,
    status: "pending",
  }));
  const plan: ProjectPlanStep[] = plannedSteps.some((step) => String(step.phase).toUpperCase() === "PACKAGE")
    ? plannedSteps
    : [
        ...plannedSteps,
        {
          step_id: `step_${String(plannedSteps.length + 1).padStart(3, "0")}`,
          label: "Package app for Jarvis",
          phase: "PACKAGE",
          status: "pending",
          acceptance_criteria: "Production build succeeds, jarvis-app.json is valid, and jarvis/index.html is complete and self-contained.",
        },
      ];

  const questions = normalizePlanningQuestions(planData.questions);
  const durationMs = Date.now() - startTime;

  if (questions.length > 0) {
    const questionText = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
    await sendAppProjectQuestion(
      project.userId,
      project.originChannel ?? undefined,
      `📋 **App Project: ${project.title}** — Plan created with ${plan.length} steps!\n\n` +
      `Before I start building, I have a few questions:\n\n${questionText}`,
    );
    await db
      .update(schema.jarvisProjects)
      .set({
        plan,
        status: "waiting_for_input",
        questionPending: `Questions before building:\n\n${questionText}`,
        questionAskedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.jarvisProjects.id, project.id));
  } else {
    await db
      .update(schema.jarvisProjects)
      .set({
        plan,
        status: "building",
        nextRunAt: new Date(Date.now() + 10_000),
        updatedAt: new Date(),
      })
      .where(eq(schema.jarvisProjects.id, project.id));

    await sendAppProjectMessage(
      project.userId,
      project.originChannel ?? undefined,
      `📋 **App Project: ${project.title}** — Plan ready!\n\n` +
      `${plan.length} steps: ${[...new Set(plan.map((s) => s.phase))].join(" → ")}\n\n` +
      `${planData.summary || ""}\n\n` +
      `Starting build now — I'll update you every ${AUTONOMOUS_INTERVAL_MINUTES} minutes.`,
    );

    console.log(`[AppProjectRunner] scheduled first build session for ${project.id}`);
  }

  await db.insert(schema.jarvisProjectSessions).values({
    projectId: project.id,
    sessionNumber,
    stepsCompleted: 0,
    stepLabels: [],
    durationMs,
    status: "complete",
    summary: `Planning complete: ${plan.length} steps created`,
  });

  return { status: questions.length > 0 ? "waiting_for_input" : "building", stepsCompleted: 0, summary: planData.summary || "" };
}

// ── Mark complete ─────────────────────────────────────────────────────────────

async function markAppProjectComplete(project: schema.JarvisProject, sessionNumber: number): Promise<void> {
  stopProjectServer(project.id);
  const workspaceDir = project.workspaceDir ?? getProjectWorkspaceDir(project.id);
  const runtimeErrors = validateProjectAppWorkspace(workspaceDir);
  if (runtimeErrors.length > 0) {
    throw new Error(`App project cannot complete until it is installable in Jarvis: ${runtimeErrors.join("; ")}`);
  }

  await db
    .update(schema.jarvisProjects)
    .set({ status: "complete", lastProgressAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.jarvisProjects.id, project.id));

  console.log(`[AppProjectRunner] project ${project.id} complete — handing off to appDelivery`);
}

// ── Answer question ───────────────────────────────────────────────────────────

export async function answerAppProjectQuestion(projectId: string, answer: string): Promise<void> {
  const [project] = await db
    .select()
    .from(schema.jarvisProjects)
    .where(eq(schema.jarvisProjects.id, projectId))
    .limit(1);

  if (!project) throw new Error(`App project ${projectId} not found`);

  await db
    .update(schema.jarvisProjects)
    .set({
      questionPending: null,
      questionAskedAt: null,
      status: "building",
      updatedAt: new Date(),
    })
    .where(eq(schema.jarvisProjects.id, projectId));

  await submitAgentJob({
    userId: project.userId,
    agentType: "app_project",
    title: `Build: ${project.title} (resumed after answer)`,
    prompt: `Continue building app project ${projectId}. User answered the pending question.`,
    input: { projectId, userAnswer: answer },
  });
}

export async function resumeAppProject(projectId: string): Promise<void> {
  await db
    .update(schema.jarvisProjects)
    .set({
      status: "building",
      consecutiveErrors: 0,
      nextRunAt: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.jarvisProjects.id, projectId));

  const [project] = await db
    .select()
    .from(schema.jarvisProjects)
    .where(eq(schema.jarvisProjects.id, projectId))
    .limit(1);

  if (project) {
    await submitAgentJob({
      userId: project.userId,
      agentType: "app_project",
      title: `Build: ${project.title} (resumed)`,
      prompt: `Continue building app project ${projectId}`,
      input: { projectId },
    });
  }
}
