# `contracts/` — wire-format JSON Schemas

The plugin (TypeScript) and the engine (Python) talk over HTTP/JSON. This
directory holds the JSON Schemas that define the wire format.

## Source of truth

**Pydantic owns the wire-format truth (D-009, D-019).** The schemas here
are **exported from** `engine/src/axtar_engine/schema/wire.py` (and
`api/rules_introspect.py::RuleSummary`) — never hand-edited.

To regenerate after a wire-model change:

```bash
cd engine
uv run python scripts/export_contracts.py
```

Or use the make target:

```bash
make export-contracts
```

A pre-merge CI gate (added in Phase 3) re-runs the export and fails if
the committed files diverge from the regenerated output.

## Files

| File | Source model | Consumed by |
|---|---|---|
| `wire/PreToolUseRequest.schema.json` | `wire.PreToolUseRequest` | plugin POST body to `/evaluate` |
| `wire/EvaluateResponse.schema.json` | `wire.EvaluateResponse` | plugin parses response from `/evaluate` |
| `wire/Violation.schema.json` | `wire.Violation` | nested in EvaluateResponse |
| `wire/Verdict.schema.json` | `wire.Verdict` (StrEnum) | nested in EvaluateResponse |
| `wire/RuleSummary.schema.json` | `api.rules_introspect.RuleSummary` | plugin parses `GET /rules` |

## Drift detection

The plugin hand-writes Zod schemas in `src/shared/wire/schemas.ts`. A
vitest contract test (`test/unit/contract.spec.ts`) reads each
JSON Schema in this directory, validates a canonical fixture through
both Ajv (against the JSON Schema) and Zod, and asserts both accept the
same shape. Drift between Pydantic and Zod surfaces as a unit-test
failure.

## Why not codegen TypeScript directly

Three options were weighed (see Phase 3 plan):

1. Hand-write TS types — no machine-checkable link to Pydantic.
2. JSON Schema → TS codegen (`json-schema-to-typescript`) — output is
   often awkward for our small surface (5 models).
3. Hand-written Zod with the contract drift test — chosen, because Zod
   is mandated by `CLAUDE.md` for runtime validation regardless and
   the surface is tiny.
