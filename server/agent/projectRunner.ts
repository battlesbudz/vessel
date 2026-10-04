/**
 * Jarvis Projects — core project engine.
 *
 * A project is a persistent, multi-session goal that Jarvis works on
 * autonomously across days. Each session advances the plan a few steps,
 * then schedules the next session. If Jarvis hits an ambiguity it can't
 * resolve, it asks the user a question and pauses until answered.
 */

import { db } from "../db";
import { and, eq, asc, desc, inArray, sql } from "drizzle-orm";
import * as schema from "@shared/schema";
import type { ProjectPlanStep } from "@shared/schema";
import { runAgent } from "./harness";
import { verifyJobOutput } from "./orchestrator";
import { filterToolsByGroups, type ToolGroup } from "./tools/index";
import { getValidGoogleTokens } from "../userTokenStore";
import { submitAgentJob } from "./jobClient";
import { getChannel } from "../channels/registry";

const AUTONOMOUS_INTERVAL_MINUTES = 30;
const MAX_CONSECUTIVE_ERRORS = 3;
const STEPS_PER_SESSION = 2;
const MAX_STEP_VERIFY_RETRIES = 2;

// ── Phase → tool groups ────────────────────────────────────────────────────────
// Each step phase gets the minimal toolset needed for its work.
// "system" includes build_feature and test_tool (the Task A iterative build tools).

function toolGroupsForPhase(phase: string): ToolGroup[] {
  const normalized = phase.toLowerCase();
  if (normalized.includes("implement") || normalized.includes("test") || normalized.includes("deploy")) {
    return ["system", "self_edit", "memory", "research"];
  }
  if (normalized.includes("research")) {
    return ["research", "browser", "memory"];
  }
  if (normalized.includes("design")) {
    return ["research", "system", "memory"];
  }
  // Default: give research + system so the agent can look things up and build if needed
  return ["research", "system", "memory"];
}

// ── Type helpers ──────────────────────────────────────────────────────────────

function asPlan(raw: unknown): ProjectPlanStep[] {
  if (!Array.isArray(raw)) return [];
  return raw as ProjectPlanStep[];
}

// ── Planning prompt ───────────────────────────────────────────────────────────

function buildPlanningPrompt(title: string, description: string, goal: string): string {
  return `You are Jarvis, an autonomous AI project manager. The user wants to start a new project.

**Project Title:** ${title}
**Description:** ${description || "(none provided)"}
**Goal (what done looks like):** ${goal}

Your task: produce a detailed, phased execution plan for this project.

Respond with a JSON object in this exact format:
{
  "plan": [
    {
      "step_id": "step_001",
      "label": "Research existing solutions",
      "phase": "Research",
      "acceptance_criteria": "Summary of 3+ existing approaches documented"
    },
    ...more steps...
  ],
  "questions": ["Any ambiguity 1", "Any ambiguity 2"],
  "summary": "One paragraph overview of the plan"
}

Rules:
- Use phases: Research → Design → Implement → Test → Deploy (use only relevant phases)
- Each step should be completable in one autonomous session (15-30 min of work)
- Include 4-14 steps total
- acceptance_criteria should be specific and verifiable
- If you have critical questions that would change the plan significantly, list up to 3 in "questions"
- If no questions, return an empty array
- Return ONLY the JSON object, nothing else`;
}

function buildStepPrompt(
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

  const answerContext = userAnswer
    ? `\n\n**User's answer to the previous question:**\n${userAnswer}\n\nUse this answer to guide this step.`
    : "";

  return `You are Jarvis, executing a step in an autonomous project.

**Project:** ${project.title}
**Goal:** ${project.goal}

**Session history:**
${sessionHistory || "(this is the first session)"}

**Previously completed steps:**
${completedSummary}${answerContext}

**Current step to complete:**
Label: ${step.label}
Phase: ${step.phase}
Acceptance criteria: ${step.acceptance_criteria || "step completed successfully"}

Your task: execute this step autonomously using your available tools and knowledge.

Produce a clear, detailed output that satisfies the acceptance criteria.
At the end, include a section:
## Step Output Summary
<one paragraph summary of what was accomplished>

If you need to ask the user a critical question before you can continue, respond with ONLY:
QUESTION: <your question here>

Otherwise, just complete the step and show your work.`;
}

// ── Core functions ─────────────────────────────────────────────────────────────

export async function startProject(
  userId: string,
  title: string,
  description: string,
  goal: string,
  originChannel?: string,
): Promise<string> {
  const [project] = await db
    .insert(schema.jarvisProjects)
    .values({
      userId,
      title,
      description,
      goal,
      status: "planning",
      originChannel,
      updatedAt: new Date(),
    })
    .returning({ id: schema.jarvisProjects.id });

  const projectId = project.id;
  console.log(`[ProjectRunner] startProject: created project ${projectId} for user ${userId}`);

  await submitAgentJob({
    userId,
    agentType: "project_session",
    title: `Plan project: ${title}`,
    prompt: `Run planning phase for project ${projectId}`,
    input: { projectId, phase: "planning", originChannel },
  });

  return projectId;
}

export async function runProjectSession(
  projectId: string,
  userAnswer?: string,
): Promise<{
  status: string;
  stepsCompleted: number;
  summary: string;
}> {
  const startTime = Date.now();

  const [project] = await db
    .select()
    .from(schema.jarvisProjects)
    .where(eq(schema.jarvisProjects.id, projectId))
    .limit(1);

  if (!project) throw new Error(`Project ${projectId} not found`);

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
    return await runPlanningSession(project, sessionNumber, startTime);
  }

  // ── Question pending — re-notify and reschedule for autonomous mode ──────
  if (project.status === "waiting_for_input" && project.questionPending && !userAnswer) {
    await sendProjectMessage(
      project.userId,
      project.originChannel ?? undefined,
      `⏳ **Project: ${project.title}** is still waiting for your answer:\n\n${project.questionPending}\n\nReply to my earlier message or use: \`/project answer ${projectId} <your answer>\``,
    );
    // In autonomous mode, reschedule another reminder so the user gets re-pinged
    if (project.autonomousMode) {
      const nextReminder = new Date(Date.now() + AUTONOMOUS_INTERVAL_MINUTES * 60 * 1000);
      await db
        .update(schema.jarvisProjects)
        .set({ nextRunAt: nextReminder, updatedAt: new Date() })
        .where(eq(schema.jarvisProjects.id, projectId));
    }
    return { status: "waiting_for_input", stepsCompleted: 0, summary: "Waiting for user input" };
  }

  // ── Building phase — execute next N steps ────────────────────────────────
  let currentPlan = asPlan(project.plan);
  const pendingSteps = currentPlan
    .map((s, i) => ({ ...s, _idx: i }))
    .filter((s) => s.status === "pending");

  if (pendingSteps.length === 0) {
    await markProjectComplete(project, sessions.length);
    return { status: "complete", stepsCompleted: 0, summary: "All steps complete!" };
  }

  const stepsToRun = pendingSteps.slice(0, STEPS_PER_SESSION);
  const completedLabels: string[] = [];
  let verificationRetriesTotal = 0;
  let sessionSummary = "";
  // Only pass userAnswer into the first step of this session
  let remainingAnswer: string | undefined = userAnswer;

  const { getModel } = await import("../lib/modelPrefs");
  const orchModel = await getModel(project.userId, "orchestrator");

  for (const step of stepsToRun) {
    let tokens: string[] = [];
    try {
      tokens = await getValidGoogleTokens(project.userId);
    } catch {
      // no Google tokens — fine, continue without them
    }
    const hasGoogle = tokens.length > 0;
    const googleAccessToken = tokens[0] ?? null;

    const stepTools = filterToolsByGroups(toolGroupsForPhase(step.phase), hasGoogle);

    const stepPrompt = buildStepPrompt(project, step, sessionHistory, remainingAnswer);
    // Only provide the answer context for the first step
    remainingAnswer = undefined;

    let reply = "";
    try {
      // ── Iterative verified build loop ──────────────────────────────────────
      // Mirrors the jobQueue.ts verification pattern: run the step, then verify
      // output quality with the orchestrator model. Retry with correction context
      // up to MAX_STEP_VERIFY_RETRIES times if the verifier rejects the output.
      let correctionContext: string | undefined;
      for (let attempt = 0; attempt <= MAX_STEP_VERIFY_RETRIES; attempt++) {
        const prompt = correctionContext
          ? `${stepPrompt}\n\n[Previous attempt rejected: ${correctionContext}. Address this in your response.]`
          : stepPrompt;

        const result = await runAgent({
          messages: [
            { role: "system", content: "You are Jarvis, an autonomous AI assistant executing a project step. Use your tools to complete the step thoroughly." },
            { role: "user", content: prompt },
          ],
          tools: stepTools,
          context: {
            userId: project.userId,
            googleAccessToken,
            channel: "ProjectRunner",
            state: { pendingAttachments: [] },
          },
          maxTurns: 8,
        });
        reply = result.reply?.trim() || "";

        // If the agent is asking a question, skip verification and surface it immediately
        if (reply.startsWith("QUESTION:")) break;

        const verification = await verifyJobOutput({
          agentType: "project_step",
          originalPrompt: `Phase: ${step.phase}\nLabel: ${step.label}\nAcceptance criteria: ${step.acceptance_criteria || "step completed successfully"}`,
          result: reply,
          orchestratorModel: orchModel,
          userId: project.userId,
          correctionContext,
        });

        if (verification.passed === true || verification.passed === null) break;

        // Verification failed — retry if attempts remain
        correctionContext = verification.reason;
        if (attempt < MAX_STEP_VERIFY_RETRIES) {
          verificationRetriesTotal++;
          console.log(`[ProjectRunner] step "${step.label}" verify retry ${attempt + 1}/${MAX_STEP_VERIFY_RETRIES}: ${verification.reason}`);
        }
      }
      // ── End iterative verified build loop ──────────────────────────────────
    } catch (err) {
      console.error(`[ProjectRunner] step "${step.label}" threw error:`, err);
      const newErrors = (project.consecutiveErrors ?? 0) + 1;
      if (newErrors >= MAX_CONSECUTIVE_ERRORS) {
        await db
          .update(schema.jarvisProjects)
          .set({ status: "paused", consecutiveErrors: newErrors, updatedAt: new Date() })
          .where(eq(schema.jarvisProjects.id, projectId));
        await sendProjectMessage(
          project.userId,
          project.originChannel ?? undefined,
          `⚠️ **Project: ${project.title}** has been paused after ${newErrors} consecutive errors.\n\nLast error: ${String(err).slice(0, 200)}\n\nUse \`/project resume ${projectId}\` to retry.`,
        );
        return { status: "paused", stepsCompleted: completedLabels.length, summary: "Paused after too many errors" };
      }
      await db
        .update(schema.jarvisProjects)
        .set({ consecutiveErrors: newErrors, updatedAt: new Date() })
        .where(eq(schema.jarvisProjects.id, projectId));
      continue;
    }

    // ── Check if agent is asking a question ──────────────────────────────────
    if (reply.startsWith("QUESTION:")) {
      const question = reply.slice("QUESTION:".length).trim();
      const questionMeta = await sendProjectQuestion(
        project.userId,
        project.originChannel ?? undefined,
        `❓ **Project: ${project.title}** needs your input before continuing:\n\n${question}\n\nReply to this message or use: \`/project answer ${projectId} <your answer>\``,
      );

      await db
        .update(schema.jarvisProjects)
        .set({
          questionPending: question,
          questionAskedAt: new Date(),
          questionMeta,
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
        summary: `Paused: Jarvis needs to know — ${question.slice(0, 200)}`,
      });

      return { status: "waiting_for_input", stepsCompleted: completedLabels.length, summary: question };
    }

    // ── Mark step complete ────────────────────────────────────────────────────
    const extractSummary = (text: string): string => {
      const match = text.match(/## Step Output Summary\s*([\s\S]*?)(?:\n##|$)/);
      return match ? match[1].trim().slice(0, 500) : text.slice(0, 300);
    };

    const stepOutput = extractSummary(reply);

    currentPlan = currentPlan.map((s, i) => {
      if (i === step._idx) {
        return { ...s, status: "complete" as const, output: stepOutput, completedAt: new Date().toISOString() };
      }
      return s;
    });

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

    console.log(`[ProjectRunner] completed step "${step.label}" for project ${projectId}`);
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
    await markProjectComplete(project, sessionNumber);
    return { status: "complete", stepsCompleted: completedLabels.length, summary: "All steps complete!" };
  }

  const nextLabel = currentPlan.find((s) => s.status === "pending")?.label ?? "next step";
  const progressMsg =
    `📋 **Project: ${project.title}** — Session ${sessionNumber} complete\n` +
    `✅ Steps done: ${totalComplete}/${currentPlan.length}\n` +
    `🔨 This session: ${completedLabels.map((l) => `"${l}"`).join(", ")}\n` +
    `⏭ Next: "${nextLabel}"\n` +
    (project.autonomousMode ? `🕐 Next session in ${AUTONOMOUS_INTERVAL_MINUTES} min (autonomous mode)` : `⏸ Paused — use /project resume ${projectId} to continue`);

  await sendProjectMessage(project.userId, project.originChannel ?? undefined, progressMsg);

  if (project.autonomousMode) {
    // Schedule via the DB-level next_run_at field; the scheduler polls every
    // 60s and submits the next job only when the timestamp has passed.
    const nextRunAt = new Date(Date.now() + AUTONOMOUS_INTERVAL_MINUTES * 60 * 1000);
    await db
      .update(schema.jarvisProjects)
      .set({ nextRunAt, updatedAt: new Date() })
      .where(eq(schema.jarvisProjects.id, projectId));
    console.log(`[ProjectRunner] autonomous project ${projectId} scheduled for ${nextRunAt.toISOString()}`);
  }

  return {
    status: "building",
    stepsCompleted: completedLabels.length,
    summary: sessionSummary,
  };
}

async function runPlanningSession(
  project: schema.JarvisProject,
  sessionNumber: number,
  startTime: number,
): Promise<{ status: string; stepsCompleted: number; summary: string }> {
  let tokens: string[] = [];
  try {
    tokens = await getValidGoogleTokens(project.userId);
  } catch {
    // no Google tokens available
  }
  const googleAccessToken = tokens[0] ?? null;

  const planningPrompt = buildPlanningPrompt(
    project.title ?? "Untitled Project",
    project.description ?? "",
    project.goal ?? "",
  );

  const result = await runAgent({
    messages: [
      { role: "system", content: "You are Jarvis, an autonomous AI project planner. Respond with JSON only." },
      { role: "user", content: planningPrompt },
    ],
    tools: [],
    context: {
      userId: project.userId,
      googleAccessToken,
      channel: "ProjectRunner/planning",
      state: { pendingAttachments: [] },
    },
    maxTurns: 3,
  });

  let planData: { plan: Omit<ProjectPlanStep, "status">[]; questions?: string[]; summary?: string } | null = null;
  try {
    const jsonMatch = result.reply.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      planData = JSON.parse(jsonMatch[0]);
    }
  } catch {
    console.error(`[ProjectRunner] failed to parse planning response for project ${project.id}`);
  }

  if (!planData?.plan?.length) {
    await db
      .update(schema.jarvisProjects)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(schema.jarvisProjects.id, project.id));
    return { status: "failed", stepsCompleted: 0, summary: "Planning failed: could not generate a plan" };
  }

  const plan: ProjectPlanStep[] = planData.plan.map((s, i) => ({
    ...s,
    step_id: s.step_id || `step_${String(i + 1).padStart(3, "0")}`,
    status: "pending",
  }));

  const questions = planData.questions?.filter(Boolean) ?? [];
  const durationMs = Date.now() - startTime;

  if (questions.length > 0) {
    const questionText = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
    const planningQuestionMeta = await sendProjectQuestion(
      project.userId,
      project.originChannel ?? undefined,
      `📋 **Project: ${project.title}** — Plan created with ${plan.length} steps!\n\n` +
      `Before I start building, I have a few questions:\n\n${questionText}\n\n` +
      `Reply to this message or use: \`/project answer ${project.id} <your answers>\``,
    );

    await db
      .update(schema.jarvisProjects)
      .set({
        plan,
        status: "waiting_for_input",
        questionPending: `Before I start building, I have a few questions:\n\n${questionText}\n\nPlease answer as many as you can.`,
        questionAskedAt: new Date(),
        questionMeta: planningQuestionMeta,
        updatedAt: new Date(),
      })
      .where(eq(schema.jarvisProjects.id, project.id));
  } else {
    await db
      .update(schema.jarvisProjects)
      .set({ plan, status: "building", updatedAt: new Date() })
      .where(eq(schema.jarvisProjects.id, project.id));

    await sendProjectMessage(
      project.userId,
      project.originChannel ?? undefined,
      `📋 **Project: ${project.title}** — Plan ready!\n\n` +
      `${plan.length} steps across ${[...new Set(plan.map((s) => s.phase))].join(" → ")}\n\n` +
      `${planData.summary || ""}\n\n` +
      `Starting first session now...`,
    );

    await submitAgentJob({
      userId: project.userId,
      agentType: "project_session",
      title: `Build: ${project.title} (session 1)`,
      prompt: `Continue building project ${project.id}`,
      input: { projectId: project.id },
    });
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

async function markProjectComplete(project: schema.JarvisProject, sessionNumber: number): Promise<void> {
  const plan = asPlan(project.plan);
  await db
    .update(schema.jarvisProjects)
    .set({ status: "complete", lastProgressAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.jarvisProjects.id, project.id));

  await sendProjectMessage(
    project.userId,
    project.originChannel ?? undefined,
    `🎉 **Project: ${project.title}** is complete!\n\n` +
    `All ${plan.length} steps finished across ${sessionNumber} session(s).\n\n` +
    `Open the Projects tab to review all outputs.`,
  );

  console.log(`[ProjectRunner] project ${project.id} complete`);
}

export async function answerProjectQuestion(projectId: string, answer: string): Promise<void> {
  const [project] = await db
    .select()
    .from(schema.jarvisProjects)
    .where(eq(schema.jarvisProjects.id, projectId))
    .limit(1);

  if (!project) throw new Error(`Project ${projectId} not found`);

  await db
    .update(schema.jarvisProjects)
    .set({
      questionPending: null,
      questionAskedAt: null,
      status: "building",
      updatedAt: new Date(),
    })
    .where(eq(schema.jarvisProjects.id, projectId));

  console.log(`[ProjectRunner] answerProjectQuestion: project ${projectId} unblocked with answer`);

  await submitAgentJob({
    userId: project.userId,
    agentType: "project_session",
    title: `Build: ${project.title} (resumed after answer)`,
    prompt: `Continue building project ${projectId}. User answered the pending question.`,
    input: { projectId, userAnswer: answer },
  });
}

export async function pauseProject(projectId: string): Promise<void> {
  await db
    .update(schema.jarvisProjects)
    .set({ status: "paused", autonomousMode: false, nextRunAt: null, updatedAt: new Date() })
    .where(eq(schema.jarvisProjects.id, projectId));
}

export async function resumeProject(projectId: string): Promise<void> {
  await db
    .update(schema.jarvisProjects)
    .set({ status: "building", consecutiveErrors: 0, updatedAt: new Date() })
    .where(eq(schema.jarvisProjects.id, projectId));

  const [project] = await db
    .select()
    .from(schema.jarvisProjects)
    .where(eq(schema.jarvisProjects.id, projectId))
    .limit(1);

  if (project) {
    await submitAgentJob({
      userId: project.userId,
      agentType: "project_session",
      title: `Build: ${project.title} (resumed)`,
      prompt: `Continue building project ${projectId}`,
      input: { projectId },
    });
  }
}

export async function setAutonomousMode(projectId: string, enabled: boolean): Promise<void> {
  const updates: Partial<schema.InsertJarvisProject> = {
    autonomousMode: enabled,
    updatedAt: new Date(),
  };

  if (!enabled) {
    updates.nextRunAt = null;
  }

  await db
    .update(schema.jarvisProjects)
    .set(updates)
    .where(eq(schema.jarvisProjects.id, projectId));

  if (enabled) {
    // Immediately schedule the next run so the scheduler can pick it up
    await db
      .update(schema.jarvisProjects)
      .set({ nextRunAt: new Date(Date.now() + 10 * 1000) }) // 10s delay to let DB settle
      .where(
        eq(schema.jarvisProjects.id, projectId),
      );
  }
}

export async function getProjectStatus(projectId: string): Promise<{
  project: schema.JarvisProject;
  sessions: schema.JarvisProjectSession[];
  plan: ProjectPlanStep[];
  completedCount: number;
  totalCount: number;
  nextStep: ProjectPlanStep | null;
} | null> {
  const [project] = await db
    .select()
    .from(schema.jarvisProjects)
    .where(eq(schema.jarvisProjects.id, projectId))
    .limit(1);

  if (!project) return null;

  const sessions = await db
    .select()
    .from(schema.jarvisProjectSessions)
    .where(eq(schema.jarvisProjectSessions.projectId, projectId))
    .orderBy(desc(schema.jarvisProjectSessions.sessionNumber));

  const plan = asPlan(project.plan);
  const completedCount = plan.filter((s) => s.status === "complete").length;
  const nextStep = plan.find((s) => s.status === "pending") ?? null;

  return { project, sessions, plan, completedCount, totalCount: plan.length, nextStep };
}

export async function getUserProjects(userId: string): Promise<(schema.JarvisProject & {
  lastSessionSummary: string | null;
  activeJobStatus: string | null;
  activeJobError: string | null;
})[]> {
  const projects = await db
    .select()
    .from(schema.jarvisProjects)
    .where(eq(schema.jarvisProjects.userId, userId))
    .orderBy(desc(schema.jarvisProjects.updatedAt));

  if (projects.length === 0) return [];

  const projectIds = projects.map((p) => p.id);
  const recentSessions = await db
    .select({
      projectId: schema.jarvisProjectSessions.projectId,
      sessionNumber: schema.jarvisProjectSessions.sessionNumber,
      summary: schema.jarvisProjectSessions.summary,
    })
    .from(schema.jarvisProjectSessions)
    .where(inArray(schema.jarvisProjectSessions.projectId, projectIds))
    .orderBy(desc(schema.jarvisProjectSessions.sessionNumber));
  const activeJobs = await db
    .select({
      projectId: sql<string>`${schema.agentJobs.input}->>'projectId'`,
      status: schema.agentJobs.status,
      error: schema.agentJobs.error,
      createdAt: schema.agentJobs.createdAt,
    })
    .from(schema.agentJobs)
    .where(and(
      eq(schema.agentJobs.userId, userId),
      inArray(schema.agentJobs.status, ["queued", "running", "needs_attention", "resource_paused"]),
    ))
    .orderBy(desc(schema.agentJobs.createdAt));

  const latestSummaryByProject = new Map<string, string | null>();
  for (const session of recentSessions) {
    if (!latestSummaryByProject.has(session.projectId)) {
      latestSummaryByProject.set(session.projectId, session.summary);
    }
  }
  const activeJobByProject = new Map<string, { status: string; error: string | null }>();
  for (const job of activeJobs) {
    if (job.projectId && projectIds.includes(job.projectId) && !activeJobByProject.has(job.projectId)) {
      activeJobByProject.set(job.projectId, { status: job.status, error: job.error });
    }
  }

  return projects.map((p) => ({
    ...p,
    lastSessionSummary: latestSummaryByProject.get(p.id) ?? null,
    activeJobStatus: activeJobByProject.get(p.id)?.status ?? null,
    activeJobError: activeJobByProject.get(p.id)?.error ?? null,
  }));
}

// ── Notification helpers ───────────────────────────────────────────────────────

async function sendProjectMessage(userId: string, originChannel: string | undefined, message: string): Promise<void> {
  try {
    const origin = (originChannel ?? "").toLowerCase();
    if (origin === "telegram") {
      const telegramCh = getChannel("telegram");
      if (telegramCh) await telegramCh.sendMessage(userId, message, {}).catch(() => {});
    } else if (origin.startsWith("discord")) {
      const { sendToDiscordUser } = await import("../discord/manager");
      await sendToDiscordUser(userId, message).catch(() => {});
    }
    const inAppCh = getChannel("in_app");
    if (inAppCh) await inAppCh.sendMessage(userId, message, {}).catch(() => {});
  } catch (err) {
    console.error("[ProjectRunner] sendProjectMessage failed:", err);
  }
}

type QuestionMeta = {
  telegramChatId?: string;
  telegramMessageId?: number;
  discordMessageId?: string;
  discordChannelId?: string;
};

/**
 * Send a question to the user and return channel metadata (message ID + channel/chat ID)
 * so we can route replies back to this project automatically via reply-thread detection.
 */
async function sendProjectQuestion(
  userId: string,
  originChannel: string | undefined,
  message: string,
): Promise<QuestionMeta> {
  const meta: QuestionMeta = {};
  try {
    const origin = (originChannel ?? "").toLowerCase();
    if (origin === "telegram") {
      const { sendMessageGetId } = await import("../integrations/telegram");
      const linkRows = await db
        .select({ chatId: schema.telegramLinks.chatId })
        .from(schema.telegramLinks)
        .where(eq(schema.telegramLinks.userId, userId))
        .limit(1);
      const chatId = linkRows[0]?.chatId;
      if (chatId) {
        const msgId = await sendMessageGetId(chatId, message).catch(() => null);
        if (msgId) {
          meta.telegramChatId = chatId;
          meta.telegramMessageId = msgId;
        }
      }
    } else if (origin.startsWith("discord")) {
      const { sendToDiscordUserGetId } = await import("../discord/manager");
      const result = await sendToDiscordUserGetId(userId, message).catch(() => ({ sent: false as const }));
      if (result.sent && result.messageId && result.channelId) {
        meta.discordMessageId = result.messageId;
        meta.discordChannelId = result.channelId;
      }
    }
    const inAppCh = getChannel("in_app");
    if (inAppCh) await inAppCh.sendMessage(userId, message, {}).catch(() => {});
  } catch (err) {
    console.error("[ProjectRunner] sendProjectQuestion failed:", err);
  }
  return meta;
}
