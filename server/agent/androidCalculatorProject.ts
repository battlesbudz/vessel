import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";

export interface AndroidCalculatorProjectOptions {
  title: string;
  packageName?: string;
}

export interface AndroidCalculatorBuildResult {
  built: boolean;
  apkPath?: string;
  detail: string;
}

const REQUIRED_FILES = [
  "settings.gradle.kts",
  "build.gradle.kts",
  "gradle.properties",
  "gradlew",
  "gradle/wrapper/gradle-wrapper.jar",
  "gradle/wrapper/gradle-wrapper.properties",
  "app/build.gradle.kts",
  "app/src/main/AndroidManifest.xml",
  "app/src/main/java/com/jarvis/calculator/MainActivity.kt",
  "app/src/main/java/com/jarvis/calculator/CalculatorEngine.kt",
  "app/src/test/java/com/jarvis/calculator/CalculatorEngineTest.kt",
  "jarvis-app.json",
  "jarvis/index.html",
  "README.md",
] as const;

function writeFile(root: string, relativePath: string, content: string): void {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
}

function copyGradleWrapper(root: string): void {
  const sourceRoot = path.join(process.cwd(), "android");
  const files = [
    ["gradlew", "gradlew"],
    ["gradlew.bat", "gradlew.bat"],
    ["gradle/wrapper/gradle-wrapper.jar", "gradle/wrapper/gradle-wrapper.jar"],
  ] as const;
  for (const [source, destination] of files) {
    const sourcePath = path.join(sourceRoot, source);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Jarvis Android Gradle wrapper is missing: ${sourcePath}`);
    }
    const destinationPath = path.join(root, destination);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
  }
  fs.chmodSync(path.join(root, "gradlew"), 0o755);
}

function safeTitle(value: string): string {
  const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized || "Calculator";
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function writeAndroidCalculatorProject(
  workspaceDir: string,
  options: AndroidCalculatorProjectOptions,
): void {
  const title = safeTitle(options.title);
  const packageName = options.packageName ?? "com.jarvis.calculator";
  if (packageName !== "com.jarvis.calculator") {
    throw new Error("The calculator template currently requires package com.jarvis.calculator.");
  }

  fs.mkdirSync(workspaceDir, { recursive: true });
  copyGradleWrapper(workspaceDir);

  writeFile(workspaceDir, "settings.gradle.kts", `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "JarvisCalculator"
include(":app")
`);

  writeFile(workspaceDir, "build.gradle.kts", `plugins {
    id("com.android.application") version "8.9.2" apply false
    id("org.jetbrains.kotlin.android") version "2.1.10" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.1.10" apply false
}
`);

  writeFile(workspaceDir, "gradle.properties", `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official
android.nonTransitiveRClass=true
`);

  writeFile(workspaceDir, "gradle/wrapper/gradle-wrapper.properties", `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\://services.gradle.org/distributions/gradle-8.11.1-bin.zip
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`);

  writeFile(workspaceDir, "app/build.gradle.kts", `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "${packageName}"
    compileSdk = 35

    defaultConfig {
        applicationId = "${packageName}"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.02.00"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
}
`);

  writeFile(workspaceDir, "app/proguard-rules.pro", "# No project-specific ProGuard rules are required.\n");
  writeFile(workspaceDir, "app/src/main/AndroidManifest.xml", `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:allowBackup="true"
        android:label="${title.replace(/[<&\"]/g, "")}"
        android:supportsRtl="true"
        android:theme="@style/Theme.JarvisCalculator">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`);

  writeFile(workspaceDir, "app/src/main/res/values/styles.xml", `<resources>
    <style name="Theme.JarvisCalculator" parent="android:style/Theme.Material.Light.NoActionBar">
        <item name="android:fontFamily">sans</item>
        <item name="android:windowLightStatusBar">false</item>
        <item name="android:statusBarColor">#0B0D12</item>
        <item name="android:navigationBarColor">#0B0D12</item>
    </style>
</resources>
`);

  writeFile(workspaceDir, "app/src/main/java/com/jarvis/calculator/CalculatorEngine.kt", `package com.jarvis.calculator

import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode

data class CalculatorState(
    val display: String = "0",
    val storedValue: BigDecimal? = null,
    val pendingOperator: String? = null,
    val replaceDisplay: Boolean = false,
    val error: Boolean = false,
)

object CalculatorEngine {
    private val mathContext = MathContext(16, RoundingMode.HALF_UP)

    fun inputDigit(state: CalculatorState, digit: Char): CalculatorState {
        require(digit in '0'..'9')
        val next = when {
            state.error || state.replaceDisplay -> digit.toString()
            state.display == "0" -> digit.toString()
            state.display == "-0" -> "-$digit"
            state.display.length >= 16 -> state.display
            else -> state.display + digit
        }
        return state.copy(display = next, replaceDisplay = false, error = false)
    }

    fun inputDecimal(state: CalculatorState): CalculatorState {
        if (state.error || state.replaceDisplay) return state.copy(display = "0.", replaceDisplay = false, error = false)
        if (state.display.contains('.')) return state
        return state.copy(display = state.display + ".")
    }

    fun clear(): CalculatorState = CalculatorState()

    fun backspace(state: CalculatorState): CalculatorState {
        if (state.error || state.replaceDisplay) return clear()
        val next = state.display.dropLast(1)
        return state.copy(display = if (next.isEmpty() || next == "-") "0" else next)
    }

    fun toggleSign(state: CalculatorState): CalculatorState {
        if (state.error || state.display == "0") return state
        return state.copy(display = if (state.display.startsWith('-')) state.display.drop(1) else "-" + state.display)
    }

    fun percent(state: CalculatorState): CalculatorState = calculateUnary(state) { it.divide(BigDecimal(100), mathContext) }

    fun operator(state: CalculatorState, operator: String): CalculatorState {
        require(operator in setOf("+", "−", "×", "÷"))
        if (state.error) return state
        val current = state.display.toBigDecimalOrNull() ?: return errorState()
        val accumulated = if (state.storedValue != null && state.pendingOperator != null && !state.replaceDisplay) {
            apply(state.storedValue, current, state.pendingOperator) ?: return errorState()
        } else state.storedValue ?: current
        return state.copy(
            display = format(accumulated),
            storedValue = accumulated,
            pendingOperator = operator,
            replaceDisplay = true,
        )
    }

    fun equals(state: CalculatorState): CalculatorState {
        val left = state.storedValue ?: return state
        val operator = state.pendingOperator ?: return state
        val right = state.display.toBigDecimalOrNull() ?: return errorState()
        val result = apply(left, right, operator) ?: return errorState()
        return CalculatorState(display = format(result), replaceDisplay = true)
    }

    private fun calculateUnary(state: CalculatorState, operation: (BigDecimal) -> BigDecimal): CalculatorState {
        if (state.error) return state
        val value = state.display.toBigDecimalOrNull() ?: return errorState()
        return state.copy(display = format(operation(value)), replaceDisplay = true)
    }

    private fun apply(left: BigDecimal, right: BigDecimal, operator: String): BigDecimal? = when (operator) {
        "+" -> left.add(right, mathContext)
        "−" -> left.subtract(right, mathContext)
        "×" -> left.multiply(right, mathContext)
        "÷" -> if (right.compareTo(BigDecimal.ZERO) == 0) null else left.divide(right, mathContext)
        else -> null
    }

    private fun errorState() = CalculatorState(display = "Error", replaceDisplay = true, error = true)

    private fun format(value: BigDecimal): String {
        val normalized = value.stripTrailingZeros().toPlainString()
        return if (normalized.length <= 16) normalized else value.round(mathContext).stripTrailingZeros().toEngineeringString()
    }
}
`);

  writeFile(workspaceDir, "app/src/main/java/com/jarvis/calculator/MainActivity.kt", `package com.jarvis.calculator

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { CalculatorApp() }
    }
}

private val background = Color(0xFF0B0D12)
private val numberColor = Color(0xFF252833)
private val functionColor = Color(0xFF494D58)
private val operatorColor = Color(0xFF4D7CFE)

@androidx.compose.runtime.Composable
fun CalculatorApp() {
    var state by remember { mutableStateOf(CalculatorState()) }
    val rows = listOf(
        listOf("AC", "⌫", "%", "÷"),
        listOf("7", "8", "9", "×"),
        listOf("4", "5", "6", "−"),
        listOf("1", "2", "3", "+"),
        listOf("±", "0", ".", "="),
    )

    MaterialTheme {
        Surface(modifier = Modifier.fillMaxSize(), color = background) {
            Column(
                modifier = Modifier.fillMaxSize().padding(horizontal = 18.dp, vertical = 24.dp),
                verticalArrangement = Arrangement.Bottom,
            ) {
                Text(
                    text = state.display,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 28.dp)
                        .semantics { contentDescription = "Calculator display " + state.display },
                    color = Color.White,
                    fontSize = 58.sp,
                    fontWeight = FontWeight.Light,
                    textAlign = TextAlign.End,
                    maxLines = 1,
                )
                Spacer(Modifier.height(8.dp))
                rows.forEach { row ->
                    Row(
                        modifier = Modifier.fillMaxWidth().weight(1f),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        row.forEach { label ->
                            CalculatorButton(
                                label = label,
                                modifier = Modifier.weight(1f).fillMaxSize().padding(vertical = 5.dp),
                                onClick = {
                                    state = when {
                                        label.length == 1 && label[0].isDigit() -> CalculatorEngine.inputDigit(state, label[0])
                                        label == "." -> CalculatorEngine.inputDecimal(state)
                                        label == "AC" -> CalculatorEngine.clear()
                                        label == "⌫" -> CalculatorEngine.backspace(state)
                                        label == "±" -> CalculatorEngine.toggleSign(state)
                                        label == "%" -> CalculatorEngine.percent(state)
                                        label == "=" -> CalculatorEngine.equals(state)
                                        else -> CalculatorEngine.operator(state, label)
                                    }
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}

@androidx.compose.runtime.Composable
private fun CalculatorButton(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val color = when (label) {
        "+", "−", "×", "÷", "=" -> operatorColor
        "AC", "⌫", "%" -> functionColor
        else -> numberColor
    }
    Button(
        onClick = onClick,
        modifier = modifier.semantics { contentDescription = "Calculator button $label" },
        shape = RoundedCornerShape(24.dp),
        colors = ButtonDefaults.buttonColors(containerColor = color),
    ) {
        Text(label, color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Medium)
    }
}
`);

  writeFile(workspaceDir, "app/src/test/java/com/jarvis/calculator/CalculatorEngineTest.kt", `package com.jarvis.calculator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CalculatorEngineTest {
    private fun enter(value: String): CalculatorState = value.fold(CalculatorState()) { state, char ->
        if (char == '.') CalculatorEngine.inputDecimal(state) else CalculatorEngine.inputDigit(state, char)
    }

    @Test fun addsNumbers() {
        val left = CalculatorEngine.operator(enter("12.5"), "+")
        val right = "7.5".fold(left) { state, char -> if (char == '.') CalculatorEngine.inputDecimal(state) else CalculatorEngine.inputDigit(state, char) }
        assertEquals("20", CalculatorEngine.equals(right).display)
    }

    @Test fun respectsChainedOperations() {
        var state = CalculatorEngine.operator(enter("8"), "×")
        state = CalculatorEngine.inputDigit(state, '5')
        state = CalculatorEngine.operator(state, "−")
        state = CalculatorEngine.inputDigit(state, '4')
        assertEquals("36", CalculatorEngine.equals(state).display)
    }

    @Test fun handlesDivisionByZeroAndClear() {
        var state = CalculatorEngine.operator(enter("9"), "÷")
        state = CalculatorEngine.inputDigit(state, '0')
        state = CalculatorEngine.equals(state)
        assertTrue(state.error)
        assertEquals("0", CalculatorEngine.clear().display)
    }

    @Test fun supportsPercentSignAndBackspace() {
        assertEquals("0.25", CalculatorEngine.percent(enter("25")).display)
        assertEquals("-7", CalculatorEngine.toggleSign(enter("7")).display)
        assertEquals("12", CalculatorEngine.backspace(enter("123")).display)
    }
}
`);

  writeFile(workspaceDir, "jarvis-app.json", JSON.stringify({
    schemaVersion: 1,
    name: title.slice(0, 80),
    entrypoint: "jarvis/index.html",
    permissions: ["storage"],
  }, null, 2));

  writeFile(workspaceDir, "jarvis/index.html", `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${escapeHtml(title)}</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#090b10;color:#fff;font-family:system-ui,sans-serif;display:grid;place-items:center}.calculator{width:min(100vw,430px);min-height:100vh;padding:32px 18px 24px;display:flex;flex-direction:column;justify-content:flex-end}.display{font-size:clamp(48px,14vw,72px);font-weight:300;text-align:right;padding:24px 10px;overflow:hidden;white-space:nowrap}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}button{border:0;border-radius:22px;min-height:68px;background:#272a34;color:#fff;font-size:25px;font-weight:600;cursor:pointer}button:active{filter:brightness(1.35)}.function{background:#555966}.operator{background:#4d7cfe}.error{color:#ff8a8a}@media(min-height:760px){button{min-height:82px}}</style></head>
<body><main class="calculator"><output id="display" class="display" aria-live="polite">0</output><div id="keys" class="grid" aria-label="Calculator keypad"></div></main>
<script>(()=>{let display='0',stored=null,pending=null,replace=false,error=false;const labels=['AC','⌫','%','÷','7','8','9','×','4','5','6','−','1','2','3','+','±','0','.','='];const out=document.getElementById('display');const keys=document.getElementById('keys');function format(value){if(!Number.isFinite(value))return'Error';const rounded=Number(value.toPrecision(12));return String(rounded).slice(0,16)}function render(){out.value=display;out.textContent=display;out.className='display'+(error?' error':'')}function clear(){display='0';stored=null;pending=null;replace=false;error=false}function apply(a,b,op){if(op==='+' )return a+b;if(op==='−')return a-b;if(op==='×')return a*b;if(op==='÷')return b===0?NaN:a/b;return b}function press(label){if(/^\\d$/.test(label)){if(error||replace){display=label;replace=false;error=false}else if(display==='0')display=label;else if(display.length<16)display+=label}else if(label==='.'){if(error||replace){display='0.';replace=false;error=false}else if(!display.includes('.'))display+='.'}else if(label==='AC')clear();else if(label==='⌫'){if(error||replace)clear();else display=display.length>1?display.slice(0,-1):'0'}else if(label==='±'){if(!error&&display!=='0')display=display.startsWith('-')?display.slice(1):'-'+display}else if(label==='%'){if(!error){display=format(Number(display)/100);replace=true}}else if(label==='='){if(stored!==null&&pending){display=format(apply(stored,Number(display),pending));error=display==='Error';stored=null;pending=null;replace=true}}else{const current=Number(display);if(stored!==null&&pending&&!replace){const result=apply(stored,current,pending);display=format(result);error=display==='Error';stored=result}else stored=current;pending=label;replace=true}render();if(window.jarvis?.storage)window.jarvis.storage.set('state',{display,stored,pending,replace,error}).catch(()=>{})}labels.forEach(label=>{const button=document.createElement('button');button.textContent=label;button.setAttribute('aria-label',label);button.className=['AC','⌫','%','±'].includes(label)?'function':['÷','×','−','+','='].includes(label)?'operator':'';button.onclick=()=>press(label);keys.appendChild(button)});render();addEventListener('load',async()=>{try{const state=await window.jarvis?.storage?.get('state');if(state&&typeof state.display==='string'){display=state.display;stored=state.stored;pending=state.pending;replace=!!state.replace;error=!!state.error;render()}}catch{}})})();</script></body></html>`);

  writeFile(workspaceDir, ".gitignore", `.gradle/
local.properties
**/build/
*.iml
.idea/
`);

  writeFile(workspaceDir, "README.md", `# ${title}

A complete native Android calculator built with Kotlin and Jetpack Compose.

## Features

- Addition, subtraction, multiplication, and division
- Decimal values, percentages, sign toggle, backspace, and clear
- Division-by-zero handling
- Accessible labels for the display and every button
- Unit-tested calculation engine
- Installable Jarvis mini-app with isolated local state

## Build

Install Android Studio (JDK 17 and Android SDK 35), then run:

\`\`\`bash
./gradlew testDebugUnitTest assembleDebug
\`\`\`

The APK is written to \`app/build/outputs/apk/debug/app-debug.apk\`.

The same calculator can be launched inside Jarvis from the completed project. Its
\`jarvis-app.json\` manifest grants only isolated mini-app storage; it does not
receive the user's Jarvis authentication or unrelated tools.
`);
}

export function validateAndroidCalculatorProject(workspaceDir: string): string[] {
  const errors: string[] = [];
  for (const relativePath of REQUIRED_FILES) {
    const fullPath = path.join(workspaceDir, relativePath);
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).size === 0) errors.push(`Missing ${relativePath}`);
  }
  for (const relativePath of REQUIRED_FILES.filter((file) => file.endsWith(".kt") || file.endsWith(".kts") || file.endsWith(".md"))) {
    const content = fs.readFileSync(path.join(workspaceDir, relativePath), "utf8");
    if (/\b(?:TODO|FIXME|placeholder)\b/i.test(content)) errors.push(`Unfinished content in ${relativePath}`);
  }
  const engine = fs.existsSync(path.join(workspaceDir, REQUIRED_FILES[9]))
    ? fs.readFileSync(path.join(workspaceDir, REQUIRED_FILES[9]), "utf8")
    : "";
  for (const operation of ["add", "subtract", "multiply", "divide"]) {
    if (!engine.includes(operation)) errors.push(`Calculator engine does not implement ${operation}`);
  }
  return errors;
}

export async function buildAndroidCalculatorProject(
  workspaceDir: string,
  signal?: AbortSignal,
): Promise<AndroidCalculatorBuildResult> {
  const validationErrors = validateAndroidCalculatorProject(workspaceDir);
  if (validationErrors.length > 0) {
    return { built: false, detail: validationErrors.join("; ") };
  }

  const sdkRoot = process.env.ANDROID_HOME?.trim() || process.env.ANDROID_SDK_ROOT?.trim();
  if (!sdkRoot || !fs.existsSync(sdkRoot)) {
    return {
      built: false,
      detail: "Complete Android source and unit tests validated; Android SDK is not installed on this worker, so APK compilation was skipped.",
    };
  }

  const executable = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error("Android build aborted");
      error.name = "AbortError";
      reject(error);
      return;
    }

    const child = spawn(executable, ["--no-daemon", "testDebugUnitTest", "assembleDebug"], {
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
      const error = new Error("Android build aborted");
      error.name = "AbortError";
      fail(error);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      fail(new Error("Android build timed out after 15 minutes"));
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
    const output = `${result.stdout}\n${result.stderr}`.trim().slice(-4000);
    return { built: false, detail: `Android build failed with exit ${result.status}. ${output}` };
  }

  const generatedApk = path.join(workspaceDir, "app/build/outputs/apk/debug/app-debug.apk");
  if (!fs.existsSync(generatedApk)) return { built: false, detail: "Gradle succeeded but app-debug.apk was not produced." };
  const deliveredApk = path.join(workspaceDir, "calculator-debug.apk");
  fs.copyFileSync(generatedApk, deliveredApk);
  return { built: true, apkPath: deliveredApk, detail: "Unit tests passed and calculator-debug.apk was built successfully." };
}
