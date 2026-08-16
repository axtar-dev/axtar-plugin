---
description: Show which Axtar project governs this repo and check platform connectivity.
allowed-tools: Bash(curl:*), Read
---

Report the Axtar status for this repository — the two things a check needs:
**which project governs it** and **whether the platform is reachable**.

Do this:

1. Read `.axtar/config.yml` at the repo root and report its top-level `project:`
   value — that is the project whose rules every check runs against. If the file
   is absent, say so plainly: no project governs this repo, the checks will
   refuse, and the fix is to create the project in the Axtar portal and commit
   the config it generates (`/axtar:setup` walks through it).

2. Check connectivity and auth with the configured credentials:

   ```
   curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $AXTAR_API_KEY" "$AXTAR_ENGINE_URL/projects"
   ```

   If `AXTAR_ENGINE_URL` or `AXTAR_API_KEY` is unset, report that instead of
   running the probe and point at `/axtar:setup`. `200` = reachable and the key
   is accepted; `401` = bad or revoked key; `404` = the URL is probably missing
   its `/mentor` suffix; a curl failure = unreachable host.

Summarize in a couple of lines. Never print the API key. Do not edit any files.
