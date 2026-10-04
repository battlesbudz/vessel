import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  RefreshControl,
  Modal,
  Alert,
  Platform,
  Linking,
  type DimensionValue,
} from "react-native";
import type { ComponentProps } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useIsFocused } from "@react-navigation/native";
import { useColors } from "@/hooks/useColors";
import { apiRequest } from "@/lib/query-client";

interface ProjectPlanStep {
  step_id: string;
  label: string;
  phase: string;
  status: "pending" | "running" | "complete" | "failed" | "skipped";
  acceptance_criteria?: string;
  output?: string;
  completedAt?: string;
}

interface Project {
  id: string;
  title: string | null;
  description: string | null;
  goal: string | null;
  plan: ProjectPlanStep[];
  currentStepIndex: number;
  status: string;
  autonomousMode: boolean;
  questionPending: string | null;
  lastProgressAt: string | null;
  workspaceDir?: string | null;
  appFramework: string | null;
  lastSessionSummary: string | null;
  activeJobStatus: string | null;
  activeJobError: string | null;
  githubRepoUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProjectDetail {
  project: Project;
  sessions: { id: number; sessionNumber: number; stepsCompleted: number; summary: string | null; status: string; createdAt: string }[];
  plan: ProjectPlanStep[];
  completedCount: number;
  totalCount: number;
  nextStep: ProjectPlanStep | null;
}

type ProjectKind = "app" | "general";
type ProjectFramework = "nextjs" | "react-vite" | "node-express" | "android-kotlin" | "custom";

interface ProjectFile {
  path: string;
  name: string;
  type: "file" | "directory";
  size: number;
  updatedAt: string;
}

interface ProjectFilesResponse {
  workspaceDir: string | null;
  files: ProjectFile[];
  launchable: boolean;
}

interface ProjectFileContent {
  path: string;
  content: string;
  size: number;
  updatedAt: string;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: keyof typeof Ionicons.glyphMap }> = {
  draft: { label: "Draft", color: "#6B7280", icon: "document-outline" },
  planning: { label: "Planning", color: "#8B5CF6", icon: "map-outline" },
  building: { label: "Building", color: "#3B82F6", icon: "construct-outline" },
  waiting_for_input: { label: "Needs Input", color: "#F59E0B", icon: "help-circle-outline" },
  paused: { label: "Paused", color: "#6B7280", icon: "pause-circle-outline" },
  complete: { label: "Complete", color: "#10B981", icon: "checkmark-circle-outline" },
  failed: { label: "Failed", color: "#EF4444", icon: "close-circle-outline" },
};

const JOB_STATUS_CONFIG: Record<string, { label: string; color: string; icon: keyof typeof Ionicons.glyphMap }> = {
  queued: { label: "Worker queued", color: "#F59E0B", icon: "hourglass-outline" },
  running: { label: "Worker running", color: "#10B981", icon: "play" },
  needs_attention: { label: "Needs attention", color: "#EF4444", icon: "alert-circle-outline" },
  resource_paused: { label: "Worker paused", color: "#6B7280", icon: "pause-circle-outline" },
};

function formatSessionSummary(summary: string | null | undefined, fallback: string): string {
  if (!summary?.trim()) return fallback;

  const trimmed = summary.trim();
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
        return `Jarvis wrote project files: ${shown}${more}.`;
      }

      const toolNames = [...new Set(parsed.tool_calls.map((call) => call.name).filter(Boolean))];
      if (toolNames.length > 0) {
        return `Jarvis ran project tools: ${toolNames.join(", ")}.`;
      }

      return "Jarvis performed project workspace actions.";
    }
  } catch {
    if (trimmed.includes('"type":"tool_calls"') || trimmed.includes('"tool_calls"')) {
      return "Jarvis performed project workspace actions.";
    }
  }

  return trimmed;
}

function useProjects() {
  return useQuery<Project[]>({
    queryKey: ["/api/projects"],
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 15000;
      const hasActive = data.some((p) => p.status === "building" || p.status === "planning");
      return hasActive ? 8000 : 30000;
    },
  });
}

function useProjectDetail(id: string | null) {
  return useQuery<ProjectDetail>({
    queryKey: ["/api/projects", id],
    enabled: !!id,
    refetchInterval: 15000,
  });
}

function useProjectFiles(id: string | null, enabled: boolean) {
  return useQuery<ProjectFilesResponse>({
    queryKey: ["/api/projects", id, "files"],
    enabled: !!id && enabled,
    refetchInterval: enabled ? 15000 : false,
  });
}

function useProjectFileContent(projectId: string | null, filePath: string | null) {
  return useQuery<ProjectFileContent>({
    queryKey: [`/api/projects/${projectId}/files/content?path=${encodeURIComponent(filePath ?? "")}`],
    enabled: !!projectId && !!filePath,
  });
}

function ProgressBar({ completed, total, color }: { completed: number; total: number; color: string }) {
  const pct = total > 0 ? (completed / total) * 100 : 0;
  return (
    <View style={styles.progressBarBg}>
      <View style={[styles.progressBarFill, { width: `${pct}%` as DimensionValue, backgroundColor: color }]} />
    </View>
  );
}

function ProjectCard({ project, onPress }: { project: Project; onPress: () => void }) {
  const colors = useColors();
  const cfg = STATUS_CONFIG[project.status] ?? STATUS_CONFIG.draft;
  const jobCfg = project.activeJobStatus ? JOB_STATUS_CONFIG[project.activeJobStatus] : null;
  const plan = project.plan ?? [];
  const completed = plan.filter((s) => s.status === "complete").length;
  const total = plan.length;
  const isAppProject = !!project.appFramework;
  const runningStep = plan.find((s) => s.status === "running") ?? null;
  const currentStep = runningStep ?? (plan.find((s) => s.status === "pending") ?? null);

  return (
    <TouchableOpacity style={[styles.card, { backgroundColor: colors.surface, borderColor: isAppProject ? "#6366F144" : colors.border }]} onPress={onPress} activeOpacity={0.75}>
      <View style={styles.cardHeader}>
        <View style={[styles.statusBadge, { backgroundColor: cfg.color + "22" }]}>
          <Ionicons name={cfg.icon} size={14} color={cfg.color} />
          <Text style={[styles.statusText, { color: cfg.color }]}>{cfg.label}</Text>
        </View>
        {isAppProject && (
          <View style={[styles.autoBadge, { backgroundColor: "#6366F122" }]}>
            <Ionicons name="code-slash" size={12} color="#6366F1" />
            <Text style={[styles.autoText, { color: "#6366F1" }]}>App Build</Text>
          </View>
        )}
        {project.autonomousMode && (
          <View style={[styles.autoBadge, { backgroundColor: "#3B82F622" }]}>
            <Ionicons name="flash" size={12} color="#3B82F6" />
            <Text style={styles.autoText}>Auto</Text>
          </View>
        )}
        {jobCfg && (
          <View style={[styles.autoBadge, { backgroundColor: jobCfg.color + "22" }]}>
            <Ionicons name={jobCfg.icon} size={12} color={jobCfg.color} />
            <Text style={[styles.autoText, { color: jobCfg.color }]}>{jobCfg.label}</Text>
          </View>
        )}
        {project.githubRepoUrl && project.status === "complete" && (
          <TouchableOpacity
            style={styles.githubIconBtn}
            onPress={() => {
              Linking.openURL(project.githubRepoUrl!).catch(() => {
                Alert.alert("Could not open link", "Unable to open the GitHub repository URL.");
              });
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="logo-github" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        )}
      </View>

      <Text style={[styles.cardTitle, { color: colors.text }]} numberOfLines={2}>
        {project.title ?? "Untitled Project"}
      </Text>

      {project.goal && (
        <Text style={[styles.cardGoal, { color: colors.textSecondary }]} numberOfLines={2}>
          {project.goal}
        </Text>
      )}

      {project.activeJobError && (project.activeJobStatus === "needs_attention" || project.activeJobStatus === "resource_paused") && (
        <Text style={[styles.cardGoal, { color: jobCfg?.color ?? colors.textSecondary }]} numberOfLines={2}>
          {project.activeJobError}
        </Text>
      )}

      {total > 0 && (
        <View style={styles.progressSection}>
          <ProgressBar completed={completed} total={total} color={cfg.color} />
          <View style={styles.progressRow}>
            <Text style={[styles.progressLabel, { color: colors.textTertiary }]}>
              {completed}/{total} steps
            </Text>
            {(project.status === "building" || project.status === "planning") && currentStep && (
              <Text style={[styles.currentStepLabel, { color: cfg.color }]} numberOfLines={1}>
                {currentStep.phase} · {currentStep.label}
              </Text>
            )}
          </View>
        </View>
      )}

      {project.lastSessionSummary && project.status !== "draft" && (
        <View style={[styles.sessionSummaryBanner, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <Ionicons name="time-outline" size={13} color={colors.textTertiary} />
          <Text style={[styles.sessionSummaryText, { color: colors.textSecondary }]} numberOfLines={2}>
            {formatSessionSummary(project.lastSessionSummary, "Jarvis is working on this project.")}
          </Text>
        </View>
      )}

      {project.questionPending && (
        <View style={[styles.questionBanner, { backgroundColor: "#F59E0B11", borderColor: "#F59E0B44" }]}>
          <Ionicons name="help-circle" size={14} color="#F59E0B" />
          <Text style={styles.questionBannerText} numberOfLines={2}>
            {project.questionPending}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

function StepRow({ step, idx }: { step: ProjectPlanStep; idx: number }) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(false);
  const icon =
    step.status === "complete" ? "checkmark-circle" :
    step.status === "failed" ? "close-circle" :
    step.status === "running" ? "reload-circle" :
    "ellipse-outline";
  const color =
    step.status === "complete" ? "#10B981" :
    step.status === "failed" ? "#EF4444" :
    step.status === "running" ? "#3B82F6" :
    colors.textTertiary;

  return (
    <TouchableOpacity onPress={() => step.output && setExpanded(!expanded)} activeOpacity={step.output ? 0.7 : 1}>
      <View style={styles.stepRow}>
        <Ionicons name={icon as ComponentProps<typeof Ionicons>["name"]} size={18} color={color} style={{ marginTop: 2 }} />
        <View style={styles.stepContent}>
          <Text style={[styles.stepPhase, { color: colors.textTertiary }]}>{step.phase}</Text>
          <Text style={[styles.stepLabel, { color: colors.text }]}>{step.label}</Text>
          {step.acceptance_criteria && (
            <Text style={[styles.stepCriteria, { color: colors.textSecondary }]} numberOfLines={expanded ? undefined : 1}>
              {step.acceptance_criteria}
            </Text>
          )}
          {expanded && step.output && (
            <Text style={[styles.stepOutput, { color: colors.textSecondary, borderLeftColor: colors.border }]}>
              {step.output}
            </Text>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

function NewProjectModal({ visible, onClose, onCreated }: {
  visible: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [goal, setGoal] = useState("");
  const [projectKind, setProjectKind] = useState<ProjectKind>("app");
  const [framework, setFramework] = useState<ProjectFramework>("nextjs");
  const [autonomousMode, setAutonomousMode] = useState(true);
  const isAppProject = projectKind === "app";

  const { mutate: createProject, isPending } = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/projects", {
        title,
        description,
        goal,
        autonomousMode,
        projectKind,
        framework: isAppProject ? framework : undefined,
        originChannel: "app",
      });
      return res.json() as Promise<{ projectId: string }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      setTitle("");
      setDescription("");
      setGoal("");
      setProjectKind("app");
      setFramework("nextjs");
      setAutonomousMode(true);
      onCreated(data.projectId);
    },
    onError: (err) => {
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to create project");
    },
  });

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <View style={[styles.modal, { backgroundColor: colors.background }]}>
        <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={onClose}>
            <Text style={[styles.modalCancel, { color: colors.textSecondary }]}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[styles.modalTitle, { color: colors.text }]}>New Project</Text>
          <TouchableOpacity onPress={() => createProject()} disabled={!title || !goal || isPending}>
            <Text style={[styles.modalSave, { color: (!title || !goal || isPending) ? colors.textTertiary : "#3B82F6" }]}>
              {isPending ? "Creating..." : "Create"}
            </Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
          <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Project Type</Text>
          <View style={[styles.segmentedControl, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <TouchableOpacity
              style={[styles.segmentOption, projectKind === "app" && styles.segmentOptionActive]}
              onPress={() => {
                setProjectKind("app");
                setAutonomousMode(true);
              }}
              activeOpacity={0.75}
            >
              <Ionicons name="code-slash" size={16} color={projectKind === "app" ? "#fff" : colors.textSecondary} />
              <Text style={[styles.segmentText, { color: projectKind === "app" ? "#fff" : colors.textSecondary }]}>App / Website</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.segmentOption, projectKind === "general" && styles.segmentOptionActive]}
              onPress={() => {
                setProjectKind("general");
                setAutonomousMode(false);
              }}
              activeOpacity={0.75}
            >
              <Ionicons name="list-outline" size={16} color={projectKind === "general" ? "#fff" : colors.textSecondary} />
              <Text style={[styles.segmentText, { color: projectKind === "general" ? "#fff" : colors.textSecondary }]}>Plan / Tracker</Text>
            </TouchableOpacity>
          </View>

          {isAppProject && (
            <>
              <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Framework</Text>
              <View style={styles.frameworkGrid}>
                {([
                  ["nextjs", "Next.js"],
                  ["react-vite", "React/Vite"],
                  ["node-express", "Node API"],
                  ["android-kotlin", "Android"],
                  ["custom", "Custom"],
                ] as const).map(([value, label]) => (
                  <TouchableOpacity
                    key={value}
                    style={[
                      styles.frameworkBtn,
                      { backgroundColor: colors.surface, borderColor: framework === value ? "#3B82F6" : colors.border },
                      framework === value && styles.frameworkBtnActive,
                    ]}
                    onPress={() => setFramework(value)}
                    activeOpacity={0.75}
                  >
                    <Text style={[styles.frameworkText, { color: framework === value ? "#3B82F6" : colors.textSecondary }]}>{label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}

          <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Project Title *</Text>
          <TextInput
            style={[styles.input, { backgroundColor: colors.surface, color: colors.text, borderColor: colors.border }]}
            placeholder="e.g. Build landing page"
            placeholderTextColor={colors.textTertiary}
            value={title}
            onChangeText={setTitle}
          />

          <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Description</Text>
          <TextInput
            style={[styles.input, { backgroundColor: colors.surface, color: colors.text, borderColor: colors.border, minHeight: 72, textAlignVertical: "top" }]}
            placeholder="Optional: additional context for Jarvis"
            placeholderTextColor={colors.textTertiary}
            value={description}
            onChangeText={setDescription}
            multiline
            numberOfLines={3}
          />

          <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Goal — What does done look like? *</Text>
          <TextInput
            style={[styles.input, { backgroundColor: colors.surface, color: colors.text, borderColor: colors.border, minHeight: 90, textAlignVertical: "top" }]}
            placeholder="e.g. A complete landing page with hero section, features, pricing, and contact form — deployed and live"
            placeholderTextColor={colors.textTertiary}
            value={goal}
            onChangeText={setGoal}
            multiline
            numberOfLines={4}
          />

          <TouchableOpacity
            style={[styles.toggleRow, { backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={() => setAutonomousMode(!autonomousMode)}
            activeOpacity={0.75}
          >
            <View>
              <Text style={[styles.toggleLabel, { color: colors.text }]}>Autonomous Mode</Text>
              <Text style={[styles.toggleDesc, { color: colors.textSecondary }]}>
                {isAppProject ? "Jarvis keeps building every 30 min until the app is complete" : "Jarvis continues the plan in scheduled sessions"}
              </Text>
            </View>
            <View style={[styles.toggleSwitch, { backgroundColor: autonomousMode ? "#3B82F6" : colors.border }]}>
              <View style={[styles.toggleThumb, { left: autonomousMode ? 22 : 2 }]} />
            </View>
          </TouchableOpacity>
        </ScrollView>
      </View>
    </Modal>
  );
}

function GitHubPushModal({ visible, project, onClose, onPushed }: {
  visible: boolean;
  project: Project;
  onClose: () => void;
  onPushed: (repoUrl: string, wasSyncMode: boolean) => void;
}) {
  const colors = useColors();
  const isSyncMode = !!project.githubRepoUrl;
  const [repoName, setRepoName] = useState(() => {
    const base = (project.title ?? "jarvis-project").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return base || "jarvis-project";
  });
  const [isPrivate, setIsPrivate] = useState(false);
  const [isPushing, setIsPushing] = useState(false);

  const canSubmit = isSyncMode ? true : repoName.trim().length > 0;

  const handlePush = useCallback(async () => {
    if (!canSubmit) return;
    setIsPushing(true);
    try {
      const body = isSyncMode
        ? { existingRepoUrl: project.githubRepoUrl }
        : { repoName: repoName.trim(), isPrivate, description: project.goal ?? project.description ?? undefined };

      const res = await apiRequest("POST", `/api/projects/${project.id}/push-to-github`, body);
      const data = await res.json() as { repoUrl?: string; error?: string };
      if (!res.ok || !data.repoUrl) {
        Alert.alert(isSyncMode ? "Sync failed" : "Push failed", data.error ?? "Failed to push to GitHub");
      } else {
        onPushed(data.repoUrl, isSyncMode);
      }
    } catch (err) {
      Alert.alert(isSyncMode ? "Sync failed" : "Push failed", err instanceof Error ? err.message : "Network error");
    } finally {
      setIsPushing(false);
    }
  }, [canSubmit, isSyncMode, project.id, project.githubRepoUrl, repoName, isPrivate, project.goal, project.description, onPushed]);

  const actionLabel = isPushing
    ? (isSyncMode ? "Syncing..." : "Pushing...")
    : (isSyncMode ? "Sync" : "Push");

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <View style={[styles.modal, { backgroundColor: colors.background }]}>
        <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={onClose}>
            <Text style={[styles.modalCancel, { color: colors.textSecondary }]}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[styles.modalTitle, { color: colors.text }]}>
            {isSyncMode ? "Sync to GitHub" : "Create GitHub Repo"}
          </Text>
          <TouchableOpacity onPress={handlePush} disabled={!canSubmit || isPushing}>
            <Text style={[styles.modalSave, { color: (!canSubmit || isPushing) ? colors.textTertiary : "#3B82F6" }]}>
              {actionLabel}
            </Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
          {isSyncMode ? (
            <>
              <View style={[styles.syncRepoRow, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Ionicons name="logo-github" size={18} color={colors.text} />
                <Text style={[styles.syncRepoUrl, { color: colors.text }]} numberOfLines={1}>
                  {project.githubRepoUrl}
                </Text>
              </View>
              <Text style={[styles.githubNote, { color: colors.textTertiary }]}>
                Jarvis will commit any new or changed files and push them to this repo. Your existing commit history is preserved.
              </Text>
            </>
          ) : (
            <>
              <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Repository Name *</Text>
              <TextInput
                style={[styles.input, { backgroundColor: colors.surface, color: colors.text, borderColor: colors.border }]}
                placeholder="my-awesome-app"
                placeholderTextColor={colors.textTertiary}
                value={repoName}
                onChangeText={setRepoName}
                autoCapitalize="none"
                autoCorrect={false}
              />

              <TouchableOpacity
                style={[styles.toggleRow, { backgroundColor: colors.surface, borderColor: colors.border }]}
                onPress={() => setIsPrivate(!isPrivate)}
                activeOpacity={0.75}
              >
                <View>
                  <Text style={[styles.toggleLabel, { color: colors.text }]}>Private Repository</Text>
                  <Text style={[styles.toggleDesc, { color: colors.textSecondary }]}>Only you can see this repo</Text>
                </View>
                <View style={[styles.toggleSwitch, { backgroundColor: isPrivate ? "#3B82F6" : colors.border }]}>
                  <View style={[styles.toggleThumb, { left: isPrivate ? 22 : 2 }]} />
                </View>
              </TouchableOpacity>

              <Text style={[styles.githubNote, { color: colors.textTertiary }]}>
                Jarvis will create a new GitHub repo and push all project files. Make sure your GitHub token has repo creation permissions.
              </Text>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

function AppWorkspaceSection({ project }: { project: Project }) {
  const colors = useColors();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const filesQuery = useProjectFiles(project.id, !!project.appFramework);
  const contentQuery = useProjectFileContent(project.id, selectedFile);
  const files = filesQuery.data?.files ?? [];
  const selectedFileMeta = selectedFile ? files.find((file) => file.path === selectedFile) : null;
  const fileCount = files.filter((file) => file.type === "file").length;

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    try {
      const res = await apiRequest("GET", `/api/projects/${project.id}/download-url`);
      const data = await res.json() as { downloadUrl?: string };
      if (!data.downloadUrl) {
        Alert.alert("Download not ready", "Jarvis has not packaged this project yet.");
        return;
      }
      await Linking.openURL(data.downloadUrl);
    } catch (err) {
      Alert.alert("Download not ready", err instanceof Error ? err.message : "The project zip is not available yet.");
    } finally {
      setDownloading(false);
    }
  }, [project.id]);

  const handleLaunch = useCallback(async () => {
    setLaunching(true);
    try {
      const response = await apiRequest("GET", `/api/projects/${project.id}/launch-url`);
      const data = await response.json() as { launchUrl?: string };
      if (!data.launchUrl) throw new Error("Jarvis did not return a launch URL.");
      await WebBrowser.openBrowserAsync(data.launchUrl, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
        controlsColor: "#4D7CFE",
      });
    } catch (err) {
      Alert.alert("App unavailable", err instanceof Error ? err.message : "This project is not installable inside Jarvis.");
    } finally {
      setLaunching(false);
    }
  }, [project.id]);

  return (
    <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.workspaceHeader}>
        <View style={styles.workspaceTitleBlock}>
          <Text style={[styles.sectionTitle, { color: colors.text, paddingBottom: 2 }]}>App Workspace</Text>
          <Text style={[styles.workspaceMeta, { color: colors.textTertiary }]}>
            {project.appFramework} {fileCount > 0 ? `- ${fileCount} files` : "- preparing files"}
          </Text>
        </View>
        <View style={styles.actionRow}>
          {project.status === "complete" && filesQuery.data?.launchable && (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: "#4D7CFE22", opacity: launching ? 0.6 : 1 }]}
              onPress={handleLaunch}
              disabled={launching}
              testID="launch-jarvis-app-button"
            >
              <Ionicons name="play" size={14} color="#4D7CFE" />
              <Text style={[styles.actionBtnText, { color: "#4D7CFE" }]}>{launching ? "Launching..." : "Open in Jarvis"}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: project.status === "complete" ? "#10B98122" : "#6B728022", opacity: downloading ? 0.6 : 1 }]}
            onPress={handleDownload}
            disabled={downloading}
          >
            <Ionicons name="download-outline" size={14} color={project.status === "complete" ? "#10B981" : colors.textSecondary} />
            <Text style={[styles.actionBtnText, { color: project.status === "complete" ? "#10B981" : colors.textSecondary }]}>
              {downloading ? "Opening..." : "Zip"}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {!!filesQuery.data?.workspaceDir && (
        <Text style={[styles.workspacePath, { color: colors.textTertiary }]} numberOfLines={1}>
          {filesQuery.data.workspaceDir}
        </Text>
      )}

      {filesQuery.isLoading && (
        <Text style={[styles.workspaceEmpty, { color: colors.textTertiary }]}>Loading workspace...</Text>
      )}

      {!filesQuery.isLoading && files.length === 0 && (
        <Text style={[styles.workspaceEmpty, { color: colors.textTertiary }]}>
          Files will appear here as Jarvis builds the project.
        </Text>
      )}

      {files.length > 0 && (
        <View style={[styles.fileList, { borderTopColor: colors.border }]}>
          {files.slice(0, 80).map((file) => {
            const isSelected = selectedFile === file.path;
            const depth = Math.max(0, file.path.split("/").length - 1);
            return (
              <TouchableOpacity
                key={file.path}
                style={[
                  styles.fileRow,
                  { paddingLeft: 14 + depth * 12, borderBottomColor: colors.border },
                  isSelected && { backgroundColor: "#3B82F611" },
                ]}
                onPress={() => file.type === "file" && setSelectedFile(file.path)}
                activeOpacity={file.type === "file" ? 0.75 : 1}
              >
                <Ionicons
                  name={file.type === "directory" ? "folder-outline" : "document-text-outline"}
                  size={15}
                  color={file.type === "directory" ? colors.textTertiary : colors.textSecondary}
                />
                <Text
                  style={[
                    styles.fileName,
                    { color: file.type === "directory" ? colors.textTertiary : colors.text },
                    isSelected && { color: "#3B82F6", fontWeight: "600" },
                  ]}
                  numberOfLines={1}
                >
                  {file.name}
                </Text>
                {file.type === "file" && (
                  <Text style={[styles.fileSize, { color: colors.textTertiary }]}>{Math.max(1, Math.round(file.size / 1024))} KB</Text>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {selectedFile && (
        <View style={[styles.filePreview, { borderTopColor: colors.border, backgroundColor: colors.background }]}>
          <Text style={[styles.filePreviewTitle, { color: colors.text }]} numberOfLines={1}>
            {selectedFileMeta?.path ?? selectedFile}
          </Text>
          {contentQuery.isLoading ? (
            <Text style={[styles.workspaceEmpty, { color: colors.textTertiary }]}>Loading file...</Text>
          ) : contentQuery.data?.content ? (
            <ScrollView horizontal style={styles.fileCodeScroll}>
              <Text style={[styles.fileCode, { color: colors.textSecondary }]}>{contentQuery.data.content}</Text>
            </ScrollView>
          ) : (
            <Text style={[styles.workspaceEmpty, { color: colors.textTertiary }]}>Could not preview this file.</Text>
          )}
        </View>
      )}
    </View>
  );
}

function ProjectDetailView({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { data, isLoading, refetch } = useProjectDetail(projectId);
  const [answerText, setAnswerText] = useState("");
  const [answering, setAnswering] = useState(false);
  const [showGitHubModal, setShowGitHubModal] = useState(false);

  const { mutate: updateProject } = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      return apiRequest("PATCH", `/api/projects/${projectId}`, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId] });
    },
    onError: (err) => {
      Alert.alert("Error", err instanceof Error ? err.message : "Action failed");
    },
  });

  const handleAnswer = useCallback(() => {
    if (!answerText.trim()) return;
    setAnswering(true);
    updateProject({ answer: answerText.trim() });
    setAnswerText("");
    setAnswering(false);
  }, [answerText, updateProject]);

  const handleDelete = useCallback(() => {
    Alert.alert("Delete Project", "This will permanently delete the project and all sessions.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await apiRequest("DELETE", `/api/projects/${projectId}`);
            queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
            onBack();
          } catch {
            Alert.alert("Error", "Failed to delete project");
          }
        },
      },
    ]);
  }, [projectId, queryClient, onBack]);

  const handleGitHubPushed = useCallback((repoUrl: string, wasSyncMode: boolean) => {
    setShowGitHubModal(false);
    queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
    queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId] });
    const title = wasSyncMode ? "Synced to GitHub!" : "Pushed to GitHub!";
    const message = wasSyncMode
      ? `Latest changes pushed to:\n${repoUrl}`
      : `Your project is live at:\n${repoUrl}`;
    Alert.alert(title, message, [{ text: "OK" }]);
  }, [projectId, queryClient]);

  if (isLoading || !data) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Ionicons name="time-outline" size={32} color={colors.textTertiary} />
        <Text style={[styles.emptyText, { color: colors.textTertiary }]}>Loading project...</Text>
      </View>
    );
  }

  const { project, sessions, completedCount, totalCount } = data;
  const cfg = STATUS_CONFIG[project.status] ?? STATUS_CONFIG.draft;
  const phases = [...new Set((project.plan ?? []).map((s) => s.phase))];
  const isComplete = project.status === "complete";

  return (
    <View style={[styles.flex, { backgroundColor: colors.background }]}>
      <View style={[styles.detailHeader, { borderBottomColor: colors.border, backgroundColor: colors.background }]}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.detailTitle, { color: colors.text }]} numberOfLines={1}>
          {project.title ?? "Project"}
        </Text>
        <TouchableOpacity onPress={handleDelete}>
          <Ionicons name="trash-outline" size={20} color="#EF4444" />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.detailContent}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refetch} />}
      >
        <View style={[styles.statusCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={[styles.statusBadge, { backgroundColor: cfg.color + "22" }]}>
            <Ionicons name={cfg.icon} size={14} color={cfg.color} />
            <Text style={[styles.statusText, { color: cfg.color }]}>{cfg.label}</Text>
          </View>

          {totalCount > 0 && (
            <View style={{ marginTop: 12 }}>
              <ProgressBar completed={completedCount} total={totalCount} color={cfg.color} />
              <Text style={[styles.progressLabel, { color: colors.textSecondary, marginTop: 6 }]}>
                {completedCount} of {totalCount} steps complete
              </Text>
            </View>
          )}

          {project.goal && (
            <Text style={[styles.goalText, { color: colors.textSecondary }]}>{project.goal}</Text>
          )}

          <View style={styles.actionRow}>
            {(project.status === "building" || project.status === "planning") && (
              <TouchableOpacity style={[styles.actionBtn, { backgroundColor: "#6B728022" }]} onPress={() => updateProject({ action: "pause" })}>
                <Ionicons name="pause-circle-outline" size={16} color={colors.textSecondary} />
                <Text style={[styles.actionBtnText, { color: colors.textSecondary }]}>Pause</Text>
              </TouchableOpacity>
            )}
            {project.status === "paused" && (
              <TouchableOpacity style={[styles.actionBtn, { backgroundColor: "#3B82F622" }]} onPress={() => updateProject({ action: "resume" })}>
                <Ionicons name="play-circle-outline" size={16} color="#3B82F6" />
                <Text style={[styles.actionBtnText, { color: "#3B82F6" }]}>Resume</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: project.autonomousMode ? "#3B82F622" : "#6B728022" }]}
              onPress={() => updateProject({ autonomousMode: !project.autonomousMode })}
            >
              <Ionicons name="flash" size={16} color={project.autonomousMode ? "#3B82F6" : colors.textSecondary} />
              <Text style={[styles.actionBtnText, { color: project.autonomousMode ? "#3B82F6" : colors.textSecondary }]}>
                {project.autonomousMode ? "Auto ON" : "Auto OFF"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {!!project.appFramework && <AppWorkspaceSection project={project} />}

        {isComplete && !!project.appFramework && (
          <View style={[styles.githubCard, { backgroundColor: colors.surface, borderColor: project.githubRepoUrl ? "#10B98133" : colors.border }]}>
            {project.githubRepoUrl ? (
              <>
                <View style={styles.githubCardHeader}>
                  <Ionicons name="logo-github" size={18} color="#10B981" />
                  <Text style={[styles.githubCardTitle, { color: colors.text }]}>Pushed to GitHub</Text>
                </View>
                <Text style={[styles.githubRepoUrl, { color: "#3B82F6" }]} numberOfLines={1}>
                  {project.githubRepoUrl}
                </Text>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: "#10B98122", alignSelf: "flex-start" }]}
                  onPress={() => setShowGitHubModal(true)}
                >
                  <Ionicons name="git-branch-outline" size={14} color="#10B981" />
                  <Text style={[styles.actionBtnText, { color: "#10B981" }]}>Sync to GitHub</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <View style={styles.githubCardHeader}>
                  <Ionicons name="logo-github" size={18} color={colors.text} />
                  <Text style={[styles.githubCardTitle, { color: colors.text }]}>Push to GitHub</Text>
                </View>
                <Text style={[styles.githubCardDesc, { color: colors.textSecondary }]}>
                  Create a GitHub repo and push your project code — ready to clone, open in VS Code, or deploy.
                </Text>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: "#1F293722", alignSelf: "flex-start" }]}
                  onPress={() => setShowGitHubModal(true)}
                  testID="push-to-github-button"
                >
                  <Ionicons name="logo-github" size={14} color={colors.text} />
                  <Text style={[styles.actionBtnText, { color: colors.text }]}>Create GitHub repo</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}

        {project.questionPending && (
          <View style={[styles.questionCard, { backgroundColor: "#F59E0B11", borderColor: "#F59E0B44" }]}>
            <View style={styles.questionHeader}>
              <Ionicons name="help-circle" size={18} color="#F59E0B" />
              <Text style={styles.questionTitle}>Jarvis needs your input</Text>
            </View>
            <Text style={[styles.questionText, { color: "#B45309" }]}>{project.questionPending}</Text>
            <TextInput
              style={[styles.answerInput, { backgroundColor: "#fff", borderColor: "#F59E0B88", color: "#374151" }]}
              placeholder="Type your answer..."
              placeholderTextColor="#9CA3AF"
              value={answerText}
              onChangeText={setAnswerText}
              multiline
              numberOfLines={3}
            />
            <TouchableOpacity
              style={[styles.answerBtn, { opacity: (!answerText.trim() || answering) ? 0.5 : 1 }]}
              onPress={handleAnswer}
              disabled={!answerText.trim() || answering}
            >
              <Text style={styles.answerBtnText}>Send Answer</Text>
            </TouchableOpacity>
          </View>
        )}

        {phases.length > 0 && (
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Plan</Text>
            {(project.plan ?? []).map((step, i) => (
              <StepRow key={step.step_id} step={step} idx={i} />
            ))}
          </View>
        )}

        {sessions.length > 0 && (
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Session History</Text>
            {sessions.map((s) => (
              <View key={s.id} style={[styles.sessionRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.sessionNum, { color: colors.textTertiary }]}>Session {s.sessionNumber}</Text>
                <Text style={[styles.sessionSummary, { color: colors.textSecondary }]} numberOfLines={2}>
                  {formatSessionSummary(s.summary, `${s.stepsCompleted} step(s) completed`)}
                </Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {isComplete && (
        <GitHubPushModal
          visible={showGitHubModal}
          project={project}
          onClose={() => setShowGitHubModal(false)}
          onPushed={handleGitHubPushed}
        />
      )}
    </View>
  );
}

export default function ProjectsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [showNew, setShowNew] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const isFocused = useIsFocused();
  const representationClientId = useRef(`${Date.now()}-${Math.random()}`);
  const representationSequence = useRef(0);
  const { data: projects, dataUpdatedAt: projectsUpdatedAt, isLoading, refetch } = useProjects();
  useEffect(() => {
    if (!projects) return;
    const renderedProjects = !isFocused || selectedId ? [] : projects.slice(0, 100);
    void apiRequest("POST", "/api/live-actions/baseline/representations", {
      kind: "project",
      surface: "projects",
      clientId: representationClientId.current,
      sequence: ++representationSequence.current,
      representations: renderedProjects.map((project) => ({ id: project.id, status: project.status })),
    }).catch(() => {});
  }, [isFocused, projects, projectsUpdatedAt, selectedId]);

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const botPad = Platform.OS === "web" ? 34 : insets.bottom;

  if (selectedId) {
    return <ProjectDetailView projectId={selectedId} onBack={() => setSelectedId(null)} />;
  }

  const activeProjects = (projects ?? []).filter((p) => !["complete", "failed"].includes(p.status));
  const doneProjects = (projects ?? []).filter((p) => ["complete", "failed"].includes(p.status));

  return (
    <View style={[styles.flex, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Projects</Text>
        <TouchableOpacity style={styles.newBtn} onPress={() => setShowNew(true)}>
          <Ionicons name="add" size={22} color="#fff" />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={[styles.listContent, { paddingBottom: botPad + 20 }]}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
      >
        {!isLoading && (projects ?? []).length === 0 && (
          <View style={styles.emptyState}>
            <Ionicons name="briefcase-outline" size={48} color={colors.textTertiary} />
            <Text style={[styles.emptyTitle, { color: colors.text }]}>No projects yet</Text>
            <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
              Start a project and Jarvis will build it autonomously — even while you sleep.
            </Text>
            <TouchableOpacity style={styles.emptyBtn} onPress={() => setShowNew(true)}>
              <Text style={styles.emptyBtnText}>Start a Project</Text>
            </TouchableOpacity>
          </View>
        )}

        {activeProjects.length > 0 && (
          <>
            <Text style={[styles.groupLabel, { color: colors.textTertiary }]}>Active</Text>
            {activeProjects.map((p) => (
              <ProjectCard key={p.id} project={p} onPress={() => setSelectedId(p.id)} />
            ))}
          </>
        )}

        {doneProjects.length > 0 && (
          <>
            <Text style={[styles.groupLabel, { color: colors.textTertiary, marginTop: 16 }]}>Completed</Text>
            {doneProjects.map((p) => (
              <ProjectCard key={p.id} project={p} onPress={() => setSelectedId(p.id)} />
            ))}
          </>
        )}
      </ScrollView>

      <NewProjectModal
        visible={showNew}
        onClose={() => setShowNew(false)}
        onCreated={(id) => {
          setShowNew(false);
          setSelectedId(id);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", gap: 12 },
  emptyText: { fontSize: 15 },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 28, fontWeight: "700" },
  newBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#3B82F6",
    alignItems: "center",
    justifyContent: "center",
  },

  listContent: { padding: 16, gap: 12 },
  groupLabel: { fontSize: 12, fontWeight: "600", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 4, paddingHorizontal: 4 },

  card: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    gap: 8,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  cardTitle: { fontSize: 16, fontWeight: "600", lineHeight: 22 },
  cardGoal: { fontSize: 13, lineHeight: 18 },

  statusBadge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20 },
  statusText: { fontSize: 12, fontWeight: "600" },
  autoBadge: { flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 20 },
  autoText: { fontSize: 11, fontWeight: "600", color: "#3B82F6" },
  githubIconBtn: { marginLeft: "auto", padding: 2 },

  progressSection: { gap: 4 },
  progressBarBg: { height: 4, borderRadius: 2, backgroundColor: "#E5E7EB" },
  progressBarFill: { height: 4, borderRadius: 2 },
  progressRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  progressLabel: { fontSize: 12 },
  currentStepLabel: { fontSize: 11, fontWeight: "500", flex: 1, textAlign: "right" },

  sessionSummaryBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 5,
    padding: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  sessionSummaryText: { flex: 1, fontSize: 12, lineHeight: 17 },

  questionBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  questionBannerText: { flex: 1, fontSize: 12, color: "#B45309" },

  emptyState: { alignItems: "center", paddingVertical: 60, gap: 12 },
  emptyTitle: { fontSize: 20, fontWeight: "600" },
  emptySubtitle: { fontSize: 14, textAlign: "center", maxWidth: 280, lineHeight: 20 },
  emptyBtn: { backgroundColor: "#3B82F6", paddingHorizontal: 24, paddingVertical: 12, borderRadius: 24, marginTop: 8 },
  emptyBtnText: { color: "#fff", fontWeight: "600", fontSize: 15 },

  modal: { flex: 1 },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    paddingTop: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalTitle: { fontSize: 17, fontWeight: "600" },
  modalCancel: { fontSize: 16 },
  modalSave: { fontSize: 16, fontWeight: "600" },
  modalBody: { padding: 16 },
  fieldLabel: { fontSize: 13, fontWeight: "500", marginBottom: 6, marginTop: 16 },
  segmentedControl: { flexDirection: "row", borderRadius: 12, borderWidth: 1, padding: 4, gap: 4 },
  segmentOption: { flex: 1, minHeight: 42, borderRadius: 9, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  segmentOptionActive: { backgroundColor: "#3B82F6" },
  segmentText: { fontSize: 13, fontWeight: "600" },
  frameworkGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  frameworkBtn: { width: "48%", minHeight: 40, borderRadius: 10, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  frameworkBtnActive: { backgroundColor: "#3B82F611" },
  frameworkText: { fontSize: 13, fontWeight: "600" },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 20,
  },
  toggleLabel: { fontSize: 15, fontWeight: "500" },
  toggleDesc: { fontSize: 12, marginTop: 2, maxWidth: 240 },
  toggleSwitch: { width: 44, height: 24, borderRadius: 12, padding: 2, position: "relative" },
  toggleThumb: { position: "absolute", top: 2, width: 20, height: 20, borderRadius: 10, backgroundColor: "#fff" },

  detailHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingTop: 60,
  },
  backBtn: { marginRight: 12 },
  detailTitle: { flex: 1, fontSize: 17, fontWeight: "600" },
  detailContent: { padding: 16, gap: 12, paddingBottom: 40 },

  statusCard: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 10 },
  goalText: { fontSize: 14, lineHeight: 20, marginTop: 4 },
  actionRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  actionBtn: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20 },
  actionBtnText: { fontSize: 13, fontWeight: "500" },

  questionCard: { borderRadius: 14, borderWidth: 1, padding: 16, gap: 10 },
  questionHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  questionTitle: { fontSize: 15, fontWeight: "600", color: "#B45309" },
  questionText: { fontSize: 14, lineHeight: 20 },
  answerInput: { borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 14, minHeight: 72, textAlignVertical: "top" },
  answerBtn: { backgroundColor: "#F59E0B", borderRadius: 10, padding: 12, alignItems: "center" },
  answerBtnText: { color: "#fff", fontWeight: "600", fontSize: 15 },

  section: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  sectionTitle: { fontSize: 15, fontWeight: "600", padding: 14, paddingBottom: 10 },
  workspaceHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingRight: 14 },
  workspaceTitleBlock: { flex: 1 },
  workspaceMeta: { fontSize: 12, paddingHorizontal: 14, paddingBottom: 10 },
  workspacePath: { fontSize: 11, paddingHorizontal: 14, paddingBottom: 10 },
  workspaceEmpty: { fontSize: 13, lineHeight: 18, paddingHorizontal: 14, paddingBottom: 14 },
  fileList: { borderTopWidth: StyleSheet.hairlineWidth },
  fileRow: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 38, paddingRight: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  fileName: { flex: 1, fontSize: 13 },
  fileSize: { fontSize: 11 },
  filePreview: { borderTopWidth: StyleSheet.hairlineWidth, padding: 12, gap: 8 },
  filePreviewTitle: { fontSize: 12, fontWeight: "600" },
  fileCodeScroll: { maxHeight: 280 },
  fileCode: { fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }), fontSize: 11, lineHeight: 16 },

  stepRow: { flexDirection: "row", gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#E5E7EB" },
  stepContent: { flex: 1, gap: 2 },
  stepPhase: { fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4 },
  stepLabel: { fontSize: 14, fontWeight: "500", lineHeight: 20 },
  stepCriteria: { fontSize: 12, lineHeight: 17 },
  stepOutput: { fontSize: 12, lineHeight: 18, borderLeftWidth: 2, paddingLeft: 8, marginTop: 6 },

  sessionRow: { paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  sessionNum: { fontSize: 11, fontWeight: "600", marginBottom: 2 },
  sessionSummary: { fontSize: 13, lineHeight: 18 },

  githubCard: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 8 },
  githubCardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  githubCardTitle: { fontSize: 15, fontWeight: "600" },
  githubCardDesc: { fontSize: 13, lineHeight: 19 },
  githubRepoUrl: { fontSize: 13, fontWeight: "500" },
  githubNote: { fontSize: 12, lineHeight: 18, marginTop: 16 },
  syncRepoRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14, borderRadius: 10, borderWidth: 1, marginBottom: 12 },
  syncRepoUrl: { flex: 1, fontSize: 13, fontWeight: "500" as const },
});
