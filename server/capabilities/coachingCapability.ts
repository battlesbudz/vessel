import type { Capability } from "./types";
import { manageTasksTool } from "../agent/tools/manageTasks";
import { queueBackgroundJobTool } from "../agent/tools/queueBackgroundJob";
import { scheduleJarvisTaskTool } from "../agent/tools/scheduleJarvisTask";
import { startProjectTool } from "../agent/tools/startProject";
import { manageProjectTool } from "../agent/tools/manageProject";

export const coachingCapability: Capability = {
  id: "coaching",
  label: "Coaching",
  toolGroups: ["coaching"],
  toolGroupOverrides: {
    schedule_jarvis_task: ["coaching", "scheduling"],
  },
  tools: [manageTasksTool, queueBackgroundJobTool, scheduleJarvisTaskTool, startProjectTool, manageProjectTool],
  configRequirements: [],
  async healthCheck() {
    return { healthy: true };
  },
};
