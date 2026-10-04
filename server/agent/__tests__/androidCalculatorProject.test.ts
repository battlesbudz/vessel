import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateAndroidCalculatorProject, writeAndroidCalculatorProject } from "../androidCalculatorProject";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-calculator-test-"));
try {
  writeAndroidCalculatorProject(workspace, { title: "Pocket Calculator" });
  assert.deepEqual(validateAndroidCalculatorProject(workspace), []);

  const engine = fs.readFileSync(path.join(workspace, "app/src/main/java/com/jarvis/calculator/CalculatorEngine.kt"), "utf8");
  assert.match(engine, /BigDecimal/);
  assert.match(engine, /left\.add/);
  assert.match(engine, /left\.subtract/);
  assert.match(engine, /left\.multiply/);
  assert.match(engine, /left\.divide/);
  assert.match(engine, /right\.compareTo\(BigDecimal\.ZERO\)/);

  const activity = fs.readFileSync(path.join(workspace, "app/src/main/java/com/jarvis/calculator/MainActivity.kt"), "utf8");
  for (const label of ["AC", "⌫", "%", "÷", "7", "×", "−", "+", "±", "="]) {
    assert.ok(activity.includes(`\"${label}\"`), `calculator UI includes ${label}`);
  }
  assert.match(activity, /contentDescription = "Calculator display/);
  assert.match(activity, /contentDescription = "Calculator button/);

  const tests = fs.readFileSync(path.join(workspace, "app/src/test/java/com/jarvis/calculator/CalculatorEngineTest.kt"), "utf8");
  assert.match(tests, /addsNumbers/);
  assert.match(tests, /handlesDivisionByZeroAndClear/);
  assert.match(tests, /supportsPercentSignAndBackspace/);

  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, "jarvis-app.json"), "utf8"));
  assert.deepEqual(manifest, {
    schemaVersion: 1,
    name: "Pocket Calculator",
    entrypoint: "jarvis/index.html",
    permissions: ["storage"],
  });
  const embeddedApp = fs.readFileSync(path.join(workspace, "jarvis/index.html"), "utf8");
  assert.match(embeddedApp, /Calculator keypad/);
  assert.match(embeddedApp, /window\.jarvis\.storage\.set/);
  assert.doesNotMatch(embeddedApp, /https?:\/\//);
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}

console.log("androidCalculatorProject tests passed");
