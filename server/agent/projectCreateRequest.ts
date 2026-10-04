export type CreateProjectKind = "general" | "app";
export type CreateProjectFramework = "nextjs" | "react-vite" | "node-express" | "android-kotlin" | "custom";

export interface NormalizedCreateProjectRequest {
  title: string;
  description: string;
  goal: string;
  originChannel: string;
  projectKind: CreateProjectKind;
  framework: CreateProjectFramework;
  autonomousMode: boolean;
  errors: string[];
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeFramework(value: unknown): CreateProjectFramework {
  const raw = cleanString(value).toLowerCase();
  if (raw === "react-vite") return "react-vite";
  if (raw === "node-express") return "node-express";
  if (raw === "android-kotlin" || raw === "android" || raw === "kotlin" || raw === "jetpack-compose") return "android-kotlin";
  if (raw === "custom") return "custom";
  return "nextjs";
}

function normalizeProjectKind(value: unknown, frameworkRaw: string): CreateProjectKind {
  const raw = cleanString(value).toLowerCase();
  if (raw === "app" || raw === "website" || raw === "web_app" || raw === "web-app") return "app";
  if (frameworkRaw) return "app";
  return "general";
}

export function normalizeCreateProjectRequest(body: unknown): NormalizedCreateProjectRequest {
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const title = cleanString(input.title);
  const description = cleanString(input.description);
  const goal = cleanString(input.goal);
  const frameworkRaw = cleanString(input.framework);
  const projectKind = normalizeProjectKind(input.projectKind ?? input.project_kind, frameworkRaw);
  const framework = normalizeFramework(input.framework);
  const autonomousMode =
    typeof input.autonomousMode === "boolean"
      ? input.autonomousMode
      : typeof input.autonomous_mode === "boolean"
        ? input.autonomous_mode
        : projectKind === "app";
  const originChannel = cleanString(input.originChannel) || "app";

  const errors: string[] = [];
  if (!title) errors.push("title is required");
  if (!goal) errors.push("goal is required");

  return {
    title,
    description,
    goal,
    originChannel,
    projectKind,
    framework,
    autonomousMode,
    errors,
  };
}

const BLOCKED_FILE_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".expo",
  "dist",
  "build",
]);

export function isSafeProjectFilePath(value: unknown): boolean {
  const raw = cleanString(value).replace(/\\/g, "/");
  if (!raw || raw.includes("\0")) return false;
  if (raw.startsWith("/") || /^[a-zA-Z]:\//.test(raw)) return false;
  const parts = raw.split("/").filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.some((part) => part === "." || part === "..")) return false;
  if (parts.some((part) => BLOCKED_FILE_SEGMENTS.has(part))) return false;
  return true;
}
