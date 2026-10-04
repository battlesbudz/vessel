# Jarvis Mini-App Runtime

Completed user-facing app projects are installable extensions, not only source archives. A project opts into the runtime with a `jarvis-app.json` manifest and one self-contained HTML entrypoint.

## Manifest contract

```json
{
  "schemaVersion": 1,
  "name": "Pong",
  "entrypoint": "jarvis/index.html",
  "permissions": ["storage", "agent.turn"],
  "agentInstructions": "Return one legal paddle move: up, down, or stay."
}
```

The entrypoint must be relative, end in `.html`, remain under the project workspace, be no larger than 2 MB, and contain all CSS and JavaScript inline. The only version-one permissions are:

- `storage`: namespaced local state through `window.jarvis.storage.get(key)` and `window.jarvis.storage.set(key, value)`.
- `agent.turn`: a bounded JSON interaction through `window.jarvis.agentTurn(state)`. Jarvis returns one JSON value according to the manifest's interaction instructions.

Projects must request the smallest permission set. A calculator needs storage but no agent access; a turn-based or real-time game against Jarvis needs `agent.turn`.

## Isolation and launch

The authenticated Projects screen requests a short-lived, user/project-bound launch credential. The public launch shell validates it, loads the completed project's manifest and entrypoint, and places the app in a sandboxed iframe without `allow-same-origin`. Generated code therefore cannot read Jarvis cookies, bearer tokens, the host page's storage, or arbitrary Jarvis APIs.

The host injects a bridge into the isolated document. Both sides enforce manifest permissions. Agent turns are limited to 12 KB of input, 500 completion tokens, 20 requests per minute, no tools, and JSON-only output. Mini-app storage is namespaced by project and values are capped at 50 KB.

## Builder requirements

App-project planning and execution prompts require the manifest and self-contained entrypoint before PACKAGE completes. Interactive apps pass only the current state needed for one decision and validate Jarvis's returned action before applying it. Source archives and platform-native artifacts remain available in parallel; for example, the Android calculator delivers a Kotlin/Jetpack Compose project and an embedded Jarvis calculator from the same project.
