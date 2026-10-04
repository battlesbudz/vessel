import type { AgentTool } from "../types";

type ProjectKind = "general" | "app";
type AppFramework = "nextjs" | "react-vite" | "node-express" | "android-kotlin" | "custom";

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeProjectKind(value: unknown, framework: string): ProjectKind {
  const raw = cleanString(value).toLowerCase();
  if (raw === "app" || raw === "website" || raw === "web_app" || raw === "web-app") return "app";
  if (framework) return "app";
  return "general";
}

function normalizeFramework(value: unknown): AppFramework {
  const raw = cleanString(value).toLowerCase();
  if (raw === "react-vite") return "react-vite";
  if (raw === "node-express") return "node-express";
  if (raw === "android-kotlin" || raw === "android" || raw === "kotlin" || raw === "jetpack-compose") return "android-kotlin";
  if (raw === "custom") return "custom";
  return "nextjs";
}

export const startProjectTool: AgentTool = {
  name: "start_project",
  description:
    "Create a persistent Jarvis project and queue its complete build. Use this for standalone apps, games, websites, and installable Jarvis mini-apps, not build_feature (which changes Jarvis itself). For an Android app, set project_kind='app' and framework='android-kotlin'. For interactive games such as Pong, use a web framework so the finished app can launch inside Jarvis and use the permissioned agent bridge. Calculator requests produce a complete native Kotlin/Jetpack Compose project plus an embedded Jarvis version immediately. If the user only gives a title, use it as the goal instead of claiming no project tool exists.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short project name, e.g. 'Battles Budz landing page'.",
      },
      goal: {
        type: "string",
        description:
          "What done looks like. If missing, use the project title as a lightweight initial goal and let the planning session ask follow-up questions.",
      },
      description: {
        type: "string",
        description: "Optional extra context for Jarvis.",
      },
      project_kind: {
        type: "string",
        enum: ["general", "app"],
        description: "Use 'app' for websites, landing pages, dashboards, tools, or standalone apps.",
      },
      framework: {
        type: "string",
        enum: ["nextjs", "react-vite", "node-express", "android-kotlin", "custom"],
        description: "Framework for app projects. Use android-kotlin for native Android apps. Defaults to nextjs.",
      },
      autonomous_mode: {
        type: "boolean",
        description: "Whether Jarvis should keep working every 30 minutes. Defaults to true for app projects and false for general projects.",
      },
    },
    required: ["title"],
  },
  async execute(args, ctx) {
    const title = cleanString(args.title);
    if (!title) {
      return { ok: false, content: "title is required.", label: "Missing project title" };
    }

    const description = cleanString(args.description);
    const goal = cleanString(args.goal) || description || title;
    const framework = normalizeFramework(args.framework);
    const projectKind = normalizeProjectKind(args.project_kind, cleanString(args.framework));
    const autonomousMode =
      typeof args.autonomous_mode === "boolean" ? args.autonomous_mode : projectKind === "app";

    if (projectKind === "app") {
      const { startAppProject } = await import("../appProjectRunner");
      const { projectId } = await startAppProject({
        userId: ctx.userId,
        title,
        description,
        goal,
        framework,
        originChannel: ctx.channel,
      });

      return {
        ok: true,
        content:
          `App project created: ${title} (projectId=${projectId}, framework=${framework}). ` +
          "Jarvis queued the planning/build session and will deliver the app when it is ready.",
        label: "App project started",
        detail: projectId,
        metadata: { projectId, projectKind, framework },
      };
    }

    const { startProject, setAutonomousMode } = await import("../projectRunner");
    const projectId = await startProject(ctx.userId, title, description, goal, ctx.channel);
    if (autonomousMode) {
      await setAutonomousMode(projectId, true);
    }

    return {
      ok: true,
      content:
        `Project created: ${title} (projectId=${projectId}). ` +
        "Jarvis queued the planning session and will continue from the Projects tab.",
      label: "Project started",
      detail: projectId,
      metadata: { projectId, projectKind },
    };
  },
};
