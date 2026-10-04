import { and, desc, inArray, sql } from "drizzle-orm";
import * as schema from "@shared/schema";
import { db } from "../../db";
import type { AgentTool } from "../types";
import { getProjectStatus, getUserProjects, resumeProject } from "../projectRunner";
import { prepareAndroidCalculatorProject, resumeAppProject } from "../appProjectRunner";
import { createProjectAppLaunchToken, loadProjectApp } from "../../projectAppRuntime";
import { getPublicBaseUrl } from "../../publicUrl";

type ProjectRow = typeof schema.jarvisProjects.$inferSelect;

async function resolveProject(userId: string, projectId: string, title: string): Promise<ProjectRow | null> {
  const projects = await getUserProjects(userId);
  if (projectId) return projects.find((project) => project.id === projectId) ?? null;
  if (title) {
    const normalized = title.toLowerCase();
    const exact = projects.find((project) => project.title?.toLowerCase() === normalized);
    return exact ?? projects.find((project) => project.title?.toLowerCase().includes(normalized)) ?? null;
  }
  return projects.find((project) => !["complete", "failed"].includes(project.status)) ?? projects[0] ?? null;
}

type ActiveProjectJob = {
  id: string;
  status: string;
  title: string;
  error: string | null;
  startedAt: Date | null;
  createdAt: Date;
};

async function activeJobForProject(projectId: string): Promise<ActiveProjectJob | null> {
  const [job] = await db
    .select({
      id: schema.agentJobs.id,
      status: schema.agentJobs.status,
      title: schema.agentJobs.title,
      error: schema.agentJobs.error,
      startedAt: schema.agentJobs.startedAt,
      createdAt: schema.agentJobs.createdAt,
    })
    .from(schema.agentJobs)
    .where(and(
      sql`${schema.agentJobs.input}->>'projectId' = ${projectId}`,
      inArray(schema.agentJobs.status, ["queued", "running", "needs_attention", "resource_paused"]),
    ))
    .orderBy(desc(schema.agentJobs.createdAt))
    .limit(1);
  return job ?? null;
}

function projectSummary(project: ProjectRow, completed: number, total: number, job: ActiveProjectJob | null): string {
  const jobText = job
    ? ` Background job ${job.id} is ${job.status}${job.error ? `: ${job.error}` : ""}.`
    : " No active background job is attached.";
  const question = project.questionPending ? ` Waiting for: ${project.questionPending}` : "";
  return `${project.title ?? "Untitled project"} (${project.id}) is ${project.status}. Progress: ${completed}/${total} steps.${jobText}${question}`;
}

function isBasicCalculatorProject(project: Pick<ProjectRow, "title" | "description" | "goal">): boolean {
  const request = [project.title, project.description, project.goal].filter(Boolean).join(" ");
  return /\bcalculator\b/i.test(request)
    && /\b(?:basic|simple|standard|small|four[- ]function)\b/i.test(request)
    && !/\b(?:scientific|mortgage|loan|calorie|bmi|tip|tax|financial|finance|currency|unit|convert(?:er|ing)?|graph(?:ing)?|programmer|history|memory|equation|algebra|trig(?:onometry)?|statistics?|date|age|interest)\b/i.test(request);
}

export const manageProjectTool: AgentTool = {
  name: "manage_project",
  description:
    "List, inspect, continue, or launch an existing Jarvis project. Use this when the user asks how a project is going, says the work is in a project, asks Jarvis to resume/finish/continue an app, or asks to open an installed mini-app inside Jarvis. Omit project_id/title to use the most recent active project. For an existing basic Android calculator request, set framework='android-kotlin' while resuming.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "status", "resume", "launch"] },
      project_id: { type: "string", description: "Known project ID, if available." },
      title: { type: "string", description: "Project title or a distinctive part of it." },
      framework: { type: "string", enum: ["android-kotlin"], description: "Set only when converting/resuming a basic native Android calculator project." },
    },
    required: ["action"],
  },
  async execute(args, ctx) {
    const action = String(args.action ?? "status");
    if (action === "list") {
      const projects = await getUserProjects(ctx.userId);
      if (projects.length === 0) return { ok: true, content: "No projects exist yet.", label: "No projects" };
      return {
        ok: true,
        content: projects.slice(0, 20).map((project) => `${project.title ?? "Untitled"} (${project.id}) — ${project.status}, framework=${project.appFramework ?? "general"}`).join("\n"),
        label: "Projects listed",
        metadata: { projectIds: projects.slice(0, 20).map((project) => project.id) },
      };
    }

    const project = await resolveProject(
      ctx.userId,
      typeof args.project_id === "string" ? args.project_id.trim() : "",
      typeof args.title === "string" ? args.title.trim() : "",
    );
    if (!project) return { ok: false, content: "I could not find that project.", label: "Project not found" };

    if (action === "launch") {
      try {
        await loadProjectApp(project.id, ctx.userId);
        const token = createProjectAppLaunchToken(project.id, ctx.userId);
        const launchUrl = `${getPublicBaseUrl()}/api/project-apps/${project.id}?token=${encodeURIComponent(token)}`;
        return {
          ok: true,
          content: `Open ${project.title ?? "this app"} inside Jarvis: ${launchUrl}`,
          label: "Jarvis app ready",
          detail: launchUrl,
          metadata: { projectId: project.id, launchUrl },
        };
      } catch (error) {
        return { ok: false, content: error instanceof Error ? error.message : "This project cannot be launched.", label: "App unavailable" };
      }
    }

    if (action === "resume") {
      if (project.status === "complete") {
        const detail = await getProjectStatus(project.id);
        return { ok: true, content: projectSummary(project, detail?.completedCount ?? 0, detail?.totalCount ?? 0, null), label: "Project already complete" };
      }
      const existingJob = await activeJobForProject(project.id);
      if (existingJob?.status === "running" || existingJob?.status === "queued" || existingJob?.status === "resource_paused") {
        const detail = await getProjectStatus(project.id);
        return { ok: true, content: projectSummary(project, detail?.completedCount ?? 0, detail?.totalCount ?? 0, existingJob), label: "Project already running" };
      }
      if (args.framework === "android-kotlin") {
        if (!isBasicCalculatorProject(project)) {
          return { ok: false, content: "Deterministic Android conversion is available for basic calculator projects only. Specialized calculators must use the normal app builder.", label: "Unsupported deterministic Android project" };
        }
        if (project.appFramework !== "android-kotlin") {
          await prepareAndroidCalculatorProject(project.id);
        }
      }
      if (project.appFramework || args.framework === "android-kotlin") {
        await resumeAppProject(project.id);
      } else {
        await resumeProject(project.id);
      }
    }

    const detail = await getProjectStatus(project.id);
    if (!detail) return { ok: false, content: "The project disappeared while I was checking it.", label: "Project not found" };
    const refreshedJob = await activeJobForProject(project.id);
    return {
      ok: true,
      content: projectSummary(detail.project, detail.completedCount, detail.totalCount, refreshedJob),
      label: action === "resume" ? "Project resumed" : "Project status",
      detail: detail.project.id,
      metadata: { projectId: detail.project.id, status: detail.project.status, jobId: refreshedJob?.id },
    };
  },
};