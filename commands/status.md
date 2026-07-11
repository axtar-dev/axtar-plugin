---
description: Show which Axtar project governs this repo and check platform connectivity.
allowed-tools: Bash(node:*)
---

Report the Axtar status for this repository: which project it's bound to, and
whether the platform is reachable with the configured credentials.

The CLI lives at `${CLAUDE_PLUGIN_ROOT}/dist/cli/projects.js`.

Do this:

1. Show the repo's current binding and run a connectivity / auth check:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/dist/cli/projects.js status
   node ${CLAUDE_PLUGIN_ROOT}/dist/cli/projects.js doctor
   ```

2. Summarize for the user in a couple of lines:
   - the bound project, or that none is bound yet (then suggest `/axtar:projects`
     to bind one);
   - whether the platform is reachable and the API key is accepted (from
     `doctor`). If `doctor` failed, surface its error and suggest `/axtar:setup`.

Keep it concise; do not edit any files.
