/**
 * Drift detector for the wire-format contract (D-019).
 *
 * Reads each JSON Schema committed under `contracts/wire/`, runs the same
 * canonical fixture through both Ajv (against JSON Schema) and Zod, and
 * asserts both decide the same way. If Pydantic and Zod disagree on what
 * counts as a valid wire payload, this test fails.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  ConsultRequestSchema,
  ConsultResponseSchema,
  EvaluateResponseSchema,
  GateRequestSchema,
  GateResponseSchema,
  PolicyResponseSchema,
  PreToolUseRequestSchema,
  ProjectSummarySchema,
  RuleSummarySchema,
  VerdictSchema,
  ViolationSchema,
} from '../../src/shared/wire/schemas.js';

const here = fileURLToPath(new URL('.', import.meta.url));
// `contracts/` lives inside the plugin (platform/plugin/contracts/wire) so the
// plugin is self-contained: test/unit -> test -> plugin/contracts/wire.
const contractsDir = resolve(here, '..', '..', 'contracts', 'wire');

function loadSchema(name: string): object {
  const text = readFileSync(resolve(contractsDir, name), 'utf-8');
  return JSON.parse(text) as object;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);

const cases: ReadonlyArray<{
  name: string;
  schemaFile: string;
  zod: { safeParse: (data: unknown) => { success: boolean } };
  validFixture: unknown;
  invalidFixture: unknown;
}> = [
  {
    name: 'PreToolUseRequest',
    schemaFile: 'PreToolUseRequest.schema.json',
    zod: PreToolUseRequestSchema,
    validFixture: {
      session_id: 's',
      tool: 'Edit',
      file_path: '/x.java',
      diff: '',
      file_after: 'class A {}',
      rule_set: ['AXT-JAVA-042'],
      // Additive Pre-path gate-check flag (mirrors the EvaluateResponse
      // `consult_required` boolean): defaulted, optional, accepted by both
      // Ajv (JSON Schema) and Zod.
      gate_check: true,
      // Bound project id — additive + optional; both validators must accept it.
      project_id: '2267f93e-8166-4480-a669-02de999c6ae9',
    },
    invalidFixture: {
      session_id: 's',
      tool: 'Edit',
      file_path: '/x.java',
      diff: '',
      file_after: 'class A {}',
      surprise: true,
    },
  },
  {
    name: 'Violation',
    schemaFile: 'Violation.schema.json',
    zod: ViolationSchema,
    validFixture: {
      rule_id: 'AXT-JAVA-042',
      severity: 'blocking',
      message: 'm',
    },
    invalidFixture: {
      rule_id: 'AXT-JAVA-042',
      severity: 'kaboom',
      message: 'm',
    },
  },
  {
    name: 'EvaluateResponse',
    schemaFile: 'EvaluateResponse.schema.json',
    zod: EvaluateResponseSchema,
    validFixture: {
      verdict: 'pass',
      violations: [],
    },
    invalidFixture: {
      verdict: 'pass',
      violations: 'oops',
    },
  },
  {
    name: 'RuleSummary',
    schemaFile: 'RuleSummary.schema.json',
    zod: RuleSummarySchema,
    validFixture: {
      id: 'AXT-JAVA-042',
      name: 'money',
      altitude: 'implementation',
      severity: 'blocking',
      language: 'java',
      paths: ['**/domain/**/*.java'],
    },
    // `paths` is required on both surfaces; omitting it must be rejected by both
    // Ajv (JSON Schema) and Zod. This is the wire-drift guard — if either surface
    // disagrees on the required set, the two fixtures diverge and the test fails.
    invalidFixture: {
      id: 'AXT-JAVA-042',
      name: 'money',
      altitude: 'implementation',
      severity: 'blocking',
      language: 'java',
    },
  },
  {
    name: 'ProjectSummary',
    schemaFile: 'ProjectSummary.schema.json',
    zod: ProjectSummarySchema,
    validFixture: {
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Demo',
      repo_full_name: 'octocat/demo',
      rule_count: 3,
    },
    invalidFixture: {
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Demo',
      repo_full_name: 'octocat/demo',
    },
  },
  {
    name: 'Verdict',
    schemaFile: 'Verdict.schema.json',
    zod: VerdictSchema,
    validFixture: 'block',
    invalidFixture: 'oops',
  },
  {
    name: 'GateRequest',
    schemaFile: 'GateRequest.schema.json',
    zod: GateRequestSchema,
    validFixture: {
      session_id: 's',
      file_path: '/x.java',
      rule_set: ['AXT-ARC-1'],
      // Bound project id — additive + optional; accepted by Ajv and Zod.
      project_id: '2267f93e-8166-4480-a669-02de999c6ae9',
    },
    invalidFixture: {
      session_id: 's',
      file_path: '/x.java',
      rule_set: ['AXT-ARC-1'],
      surprise: true,
    },
  },
  {
    name: 'GateResponse',
    schemaFile: 'GateResponse.schema.json',
    zod: GateResponseSchema,
    validFixture: {
      cleared: false,
      triggered_rule_ids: ['AXT-ARC-1'],
      reason: 'consult_required',
    },
    invalidFixture: {
      cleared: false,
      triggered_rule_ids: ['AXT-ARC-1'],
    },
  },
  {
    // Director fields (D-052) are additive + optional: a new server may emit
    // them, an old one omits them. Both Ajv and Zod must accept the populated
    // shape so the plugin tolerates either server.
    name: 'GateResponse (director fields)',
    schemaFile: 'GateResponse.schema.json',
    zod: GateResponseSchema,
    validFixture: {
      cleared: false,
      triggered_rule_ids: ['AXT-ARC-1'],
      reason: 'consult_required',
      guidance: 'You attempted this edit before; it still triggers AXT-ARC-1 (attempt 2).',
      escalate: false,
      attempt: 2,
    },
    invalidFixture: {
      cleared: false,
      triggered_rule_ids: ['AXT-ARC-1'],
      reason: 'consult_required',
      escalate: 'yes', // wrong type — must be boolean
    },
  },
  {
    name: 'ConsultRequest',
    schemaFile: 'ConsultRequest.schema.json',
    zod: ConsultRequestSchema,
    validFixture: {
      session_id: 's',
      files: ['/x.java'],
      // Bound project id — additive + optional; accepted by Ajv and Zod.
      project_id: '2267f93e-8166-4480-a669-02de999c6ae9',
    },
    invalidFixture: {
      session_id: 's',
      files: [],
    },
  },
  {
    name: 'ConsultResponse',
    schemaFile: 'ConsultResponse.schema.json',
    zod: ConsultResponseSchema,
    validFixture: {
      answer: 'a',
      verdict: 'approve',
      rationale: 'r',
      approved_files: [],
      follow_up_questions: [],
    },
    invalidFixture: {
      answer: 'a',
      verdict: 'kaboom',
      rationale: 'r',
      approved_files: [],
      follow_up_questions: [],
    },
  },
  {
    // Determinacy fields (D-060/D-062) are additive + optional: a new server
    // emits them, an old one omits them. Both Ajv and Zod must accept the
    // populated shape and reject a malformed choice (missing required field).
    name: 'ConsultResponse (determinacy fields)',
    schemaFile: 'ConsultResponse.schema.json',
    zod: ConsultResponseSchema,
    validFixture: {
      answer: 'a',
      verdict: 'approve',
      rationale: 'r',
      approved_files: ['/x.java'],
      follow_up_questions: [],
      determinacy: 'underdetermined',
      underdetermined_choices: [
        {
          decision: 'wrap-and-rethrow',
          alternatives: 'result-type or log-and-continue',
          why_unconstrained: 'no rule constrains the error-handling strategy',
        },
      ],
    },
    invalidFixture: {
      answer: 'a',
      verdict: 'approve',
      rationale: 'r',
      approved_files: [],
      follow_up_questions: [],
      underdetermined_choices: [{ decision: 'x', alternatives: 'y' }], // missing why_unconstrained
    },
  },
  {
    // Resolved autonomy policy (D-063): a new behavior-driving wire type, so —
    // unlike the read-only summary — it gets full Ajv-vs-Zod lockstep.
    name: 'PolicyResponse',
    schemaFile: 'PolicyResponse.schema.json',
    zod: PolicyResponseSchema,
    validFixture: { autonomy_rung: 'rung2_gate_certified' },
    invalidFixture: {}, // autonomy_rung is required → both Ajv and Zod reject
  },
];

describe('contract drift', () => {
  for (const c of cases) {
    it(`${c.name}: Ajv and Zod agree on a valid fixture`, () => {
      const validate = ajv.compile(loadSchema(c.schemaFile));
      const ajvOk = validate(c.validFixture);
      const zodOk = c.zod.safeParse(c.validFixture).success;
      expect(ajvOk, `Ajv errors: ${JSON.stringify(validate.errors)}`).toBe(true);
      expect(zodOk).toBe(true);
    });

    it(`${c.name}: Ajv and Zod agree on an invalid fixture`, () => {
      const validate = ajv.compile(loadSchema(c.schemaFile));
      const ajvOk = validate(c.invalidFixture);
      const zodOk = c.zod.safeParse(c.invalidFixture).success;
      expect(ajvOk).toBe(false);
      expect(zodOk).toBe(false);
    });
  }
});
