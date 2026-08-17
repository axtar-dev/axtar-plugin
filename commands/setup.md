---
description: Configure and verify the Axtar platform connection (engine URL + API key) for this repo.
argument-hint: '(optional) <engine-url> <axtar_pk_…-key>'
allowed-tools: Bash(curl:*), Read, Write, Edit
---

You are connecting this repo to the user's Axtar platform so the `axtar_check_spec`
and `axtar_check_diff` MCP tools can reach it. Setup is two things: **the two
environment variables** (how to reach the platform) and **a committed
`.axtar/config.yml`** (which project's rules govern this repo).

## 1. The two environment variables

- `AXTAR_ENGINE_URL` — the platform's `/mentor` base URL, e.g.
  `https://app.axtar.dev/mentor`.
- `AXTAR_API_KEY` — an `axtar_pk_…` token from the portal's Settings → API keys.

If the user passed them in `$ARGUMENTS`, use those. Otherwise ask for them. The
key is a secret: tell the user it goes into a gitignored local settings file,
never a committed one, and never echo it back in full.

Persist them to `.claude/settings.local.json` at the repo root (per-user and
gitignored — never the committed `settings.json`). Read the file first if it
exists, merge an `env` block, and write it back preserving every key already
present:

```json
{
  "env": {
    "AXTAR_ENGINE_URL": "<url>",
    "AXTAR_API_KEY": "<key>"
  }
}
```

## 2. Verify the connection

Probe the platform with the values applied to that one command:

```
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer <key>" "<url>/projects"
```

`200` means the URL is right and the key is accepted. `401` is a bad or revoked
key; `404` usually means the URL is missing the `/mentor` suffix; a curl error
means the host is unreachable. Report which one it was and stop — do not write a
config against a platform you could not reach.

## 3. The project config

Checks run against the project named by `.axtar/config.yml` at the repo root:

```yaml
version: 1
project: prj_8f3a2c # issued by the portal when you create the project
```

Read the file if it exists and report which project it binds to. If it is
absent, point the user at `/axtar:projects`, which lists the org's projects and
writes the config for the one they pick. The portal issues the project id, so
never invent one — and the file only counts once it is committed.

## 4. Offer the repo a standing instruction

Offer (do not impose) to add two lines to the repo's `CLAUDE.md`, so every future
session reaches for the checks without being asked: **"Before implementing a
spec, run `axtar_check_spec`. After completing a code change, run
`axtar_check_diff` before presenting."** Only write it if the user says yes.

## 5. Report

Confirm: the platform is reachable and the key was accepted; the settings were
written to `.claude/settings.local.json`; and either which project governs this
repo or that a config is still needed. Note that Claude Code loads `env` at
session start, so the user must restart the session before the MCP tools pick up
the new values. Keep it to a few lines, and treat the API key as a secret
throughout.
