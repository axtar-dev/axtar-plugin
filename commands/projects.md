---
description: Choose which Axtar project (and its rules) governs this repository and persist the choice.
argument-hint: "[project id or name]  (optional — omit to pick interactively)"
allowed-tools: Bash(node:*)
---

You are helping the user bind this repository to one of their organization's
Axtar projects. A project owns a pool of rules; binding the repo to a project
is what scopes evaluation to exactly those rules. The choice is persisted in
`.axtar/config.json` (committed to the repo); afterwards the PreToolUse /
PostToolUse hooks scope evaluation to that project's rules.

The CLI lives at `${CLAUDE_PLUGIN_ROOT}/dist/cli/projects.js` and reads its
connection settings from `AXTAR_ENGINE_URL` + `AXTAR_API_KEY`.

Do this:

1. Show the current binding and the available projects:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/dist/cli/projects.js status
   node ${CLAUDE_PLUGIN_ROOT}/dist/cli/projects.js list
   ```

   If `list` reports a 401 / unauthorized or a connection error, stop and tell
   the user to run `/axtar:setup` (or to set `AXTAR_ENGINE_URL` — the platform's
   `/mentor` URL — and `AXTAR_API_KEY` — an `axtar_pk_…` token from the
   platform's Settings → API keys), then re-run this command.

2. If the user passed an argument (`$ARGUMENTS`), treat it as the chosen
   project id or name. Otherwise, show the user the `list` output as a short
   numbered list (name — rule count — repo) and ask which project they want.
   Wait for their answer.

3. Bind the repo to the chosen project:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/dist/cli/projects.js select <id-or-name>
   ```

4. Report the result: the bound project, how many rules are in its pool, and
   that `.axtar/config.json` should be committed so the binding travels with
   the repo.

Keep it concise. Do not edit any files yourself — the CLI owns
`.axtar/config.json`.
