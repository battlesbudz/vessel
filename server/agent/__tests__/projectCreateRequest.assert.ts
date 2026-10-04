import assert from "node:assert/strict";
import {
  normalizeCreateProjectRequest,
  isSafeProjectFilePath,
} from "../projectCreateRequest";

const appRequest = normalizeCreateProjectRequest({
  title: "Battles Budz landing page",
  goal: "Build a complete landing page with hero, product sections, and contact form",
  projectKind: "app",
  framework: "react-vite",
  autonomousMode: false,
  originChannel: "app",
});

assert.deepEqual(appRequest.errors, []);
assert.equal(appRequest.projectKind, "app");
assert.equal(appRequest.framework, "react-vite");
assert.equal(appRequest.autonomousMode, false);
assert.equal(appRequest.title, "Battles Budz landing page");

const inferredAppRequest = normalizeCreateProjectRequest({
  title: "Website",
  goal: "Make a site",
  framework: "nextjs",
});

assert.deepEqual(inferredAppRequest.errors, []);
assert.equal(inferredAppRequest.projectKind, "app");
assert.equal(inferredAppRequest.autonomousMode, true);

const androidRequest = normalizeCreateProjectRequest({
  title: "Calculator",
  goal: "Build a complete native Android calculator",
  framework: "android-kotlin",
});

assert.deepEqual(androidRequest.errors, []);
assert.equal(androidRequest.projectKind, "app");
assert.equal(androidRequest.framework, "android-kotlin");
assert.equal(androidRequest.autonomousMode, true);

const generalRequest = normalizeCreateProjectRequest({
  title: "Licensing plan",
  goal: "Organize the licensing work",
});

assert.deepEqual(generalRequest.errors, []);
assert.equal(generalRequest.projectKind, "general");
assert.equal(generalRequest.autonomousMode, false);

const invalidRequest = normalizeCreateProjectRequest({ title: "   " });
assert(invalidRequest.errors.includes("title is required"));
assert(invalidRequest.errors.includes("goal is required"));

assert.equal(isSafeProjectFilePath("src/App.tsx"), true);
assert.equal(isSafeProjectFilePath("README.md"), true);
assert.equal(isSafeProjectFilePath("../server/index.ts"), false);
assert.equal(isSafeProjectFilePath("src/../../.env"), false);
assert.equal(isSafeProjectFilePath("node_modules/react/index.js"), false);

console.log("All project create request assertions passed.");
