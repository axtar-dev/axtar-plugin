---
description: Choose which Axtar project (and its rules) governs this repository and persist the choice.
argument-hint: '(optional) <project id or name>'
---

<!--
No `allowed-tools:` on purpose, unlike setup.md / status.md: this command has to
call the plugin's own `axtar_projects` MCP tool, whose fully qualified name
depends on how the plugin was installed. Pinning a list here would silently lock
the command out of the one tool it exists to use.
-->


You are helping the user bind this repository to one of their organization's
Axtar projects. A project owns a pool of rules; binding the repo to a project is
what scopes every check to exactly those rules.

**The committed `.axtar/config.yml` at the repo root is the only binding
mechanism.** There is no server-side selection: the platform stores no per-repo
choice, and the MCP server writes nothing. "Switching project" therefore means
**editing that one file and committing it** — which is what you are here to do.

## 1. See what exists

Call the `axtar_projects` MCP tool (no arguments). It returns every project this
API key can see, which one this repo is currently bound to, and the config
snippet to write.

If it refuses because `AXTAR_ENGINE_URL` / `AXTAR_API_KEY` are unset, stop and
point the user at `/axtar:setup`. If it fails open (the platform is unreachable),
say so — you can still author the config by hand if the user knows the project
id, but do not guess an id.

## 2. Ask

If the user passed `$ARGUMENTS`, treat it as the project they want and match it
against the list by id or name. Otherwise present the list conversationally — a
short numbered list of **name — rules enforced — linked repo** — say which one
governs the repo today (or that none does), and ask which project should govern
it. Wait for the answer; do not pick for them.

## 3. Write `.axtar/config.yml`

Create the `.axtar/` directory if it is missing, then write the file yourself
with the chosen project id. If a config already exists, **edit only what has to
change** — keep any `knowledge:` block the team already wrote.

Pick the shape from what the user says they want Axtar to read. All three are
valid and complete; start at the top unless the user asks for more.

**Binding-only** — checks run against the project's rules; ingest reads nothing
from this repo. The fastest path, and the right one when the rules already live
in the portal:

```yaml
version: 1 # config format version — always 1
project: 3f6a2c18-9b1e-4c5a-9a2f-1d0e7b4c8a55 # the id the portal issued; the whole binding
```

**Docs-only** — Axtar also reads what the team already wrote down:

```yaml
version: 1
project: 3f6a2c18-9b1e-4c5a-9a2f-1d0e7b4c8a55
knowledge: # optional — omit entirely for a binding-only config
  docs: # "stated" knowledge: what a human already wrote
    - path: docs/adr/**/*.md # repo-relative glob, any text format
    - path: docs/guidelines/**/*.md
    - path: CONTRIBUTING.md
    - path: docs/architecture.md
      kind: reference # context only — never becomes a rule (use it on overviews)
```

**Docs + code** — Axtar also induces the conventions nobody wrote down:

```yaml
version: 1
project: 3f6a2c18-9b1e-4c5a-9a2f-1d0e7b4c8a55
knowledge:
  docs:
    - path: docs/adr/**/*.md
    - path: CONTRIBUTING.md
  code: # "induced" knowledge: conventions the code carries
    enabled: true # the flag — false or absent means docs-only
    include: ['src/**', 'packages/*/src/**'] # repo-relative globs; no language list
    exclude: ['**/generated/**', '**/vendor/**'] # keep generated and vendored code out
```

Validation is **strict on the platform side**: an unknown key is an error, so do
not invent fields (no model choice, no thresholds, no schedules — those are
portal-side settings, never this file). Only `project:` is read locally; the
`knowledge:` block is the ingest contract and the platform is what parses it.

## 4. Close

Tell the user, in a couple of lines:

- which project now governs the repo, and how many rules are in its pool;
- **commit `.axtar/config.yml`** — the binding travels with the repo, not with a
  machine, so an uncommitted file binds nobody but them;
- **push it before running ingest** — the platform reads the committed file from
  the remote, so an unpushed change is a change ingest cannot see;
- run `/axtar:status` to verify the binding and the connection.

Never print the API key. Do not touch any file other than `.axtar/config.yml`.
