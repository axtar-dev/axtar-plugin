---
description: Configure and verify the Axtar platform connection (engine URL + API key) for this repo.
argument-hint: "(optional) <engine-url> <axtar_pk_…-key>"
allowed-tools: Bash(node:*), Read, Write, Edit
---

You are helping the user connect this repo to their Axtar platform so the hooks
and the `/axtar:*` commands can talk to it. Two settings are needed:

- `AXTAR_ENGINE_URL` — the platform's `/mentor` base URL (e.g.
  `https://app.example.com/mentor`).
- `AXTAR_API_KEY` — an `axtar_pk_…` token from the platform's Settings → API keys.

Do this:

1. Determine the two values. If the user passed them in `$ARGUMENTS`, use those.
   Otherwise ask the user for the engine URL and the API key. The key is a
   secret — tell the user it will be written to a gitignored local settings file,
   never committed, and do not echo it back in full.

2. Persist them to `.claude/settings.local.json` at the repo root (this file is
   per-user and gitignored — never put an API key in the committed
   `settings.json`). Read the file first if it exists, merge an `env` block, and
   write it back, preserving any keys already present:

   ```json
   {
     "env": {
       "AXTAR_ENGINE_URL": "<url>",
       "AXTAR_API_KEY": "<key>"
     }
   }
   ```

3. Verify the connection by running `doctor` with the values applied to the
   environment for that one command (this may prompt for permission since it is
   not a bare `node` command):

   ```
   AXTAR_ENGINE_URL="<url>" AXTAR_API_KEY="<key>" node ${CLAUDE_PLUGIN_ROOT}/dist/cli/projects.js doctor
   ```

4. Report the result:
   - On success: confirm the platform is reachable, how many projects are
     available, and that the settings were written to `.claude/settings.local.json`.
     Note that Claude Code loads `env` at session start, so the user may need to
     restart the session for the hooks to pick up the new values. Then suggest
     `/axtar:projects` to bind a project.
   - On failure: surface the `doctor` error (bad URL / 401 / unreachable) and ask
     the user to double-check the values before retrying.

Keep it concise. Treat the API key as a secret throughout.
