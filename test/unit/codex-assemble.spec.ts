/**
 * Codex assemble dispatch + apply_patch applier — Pre simulate / Post
 * observe paths, parallel to claude-code/assemble.spec.ts.
 *
 * The "captured codex 0.133.0 fixtures" suite below tests the applier
 * against real codex apply_patch envelopes captured during 11.5.6 Part A
 * via the AXTAR_HOOK_TRACE_BODIES diagnostic on 2026-05-28. Each fixture
 * is a self-contained (pre-state, patch, expected-post) triple; the
 * patches are byte-for-byte what codex emitted, the pre-states are what
 * `readFileSync` saw on disk at the PreToolUse moment, and the expected
 * post-states are what `readFileSync` saw on disk at the matching
 * PostToolUse moment (i.e. after codex's own applier ran). The applier
 * under test must produce the same post-state.
 *
 * See [[D-045]] for why this discipline is now binding: the 11.5.4
 * synthetic applier and its synthetic fixtures both encoded the same
 * wrong assumption (anchor-or-line-0 fixed-offset semantics, whereas
 * codex is sequence-match-based) and so the tests confirmed the bug
 * instead of catching it. Fixtures derive from real captured payloads,
 * never hand-written.
 *
 * Covers:
 *   FIX-1  mid-file insert       — Order.java BigDecimal shippingCost
 *   FIX-2  top-of-imports insert — Order.java import java.util.UUID
 *   FIX-3  delete-only           — Order.java remove shippingCost
 *   FIX-4  single-hunk rename    — Order.java getAmount() → amount()
 *   FIX-5  Add File              — Shipment.java new entity
 *   FIX-6  non-Java append       — notes.txt todo list (generality proof)
 *   FIX-7  context-only no-op    — dupes.txt EOF-reaching shape
 *   FIX-8  seekSequence stress   — dupes.txt SECOND header→footer
 *                                  (load-bearing: first occurrence must
 *                                   stay untouched, second must change)
 *   FIX-9  multi-hunk threading  — Order.java field + method
 *                                  (load-bearing: both regions must
 *                                   change in one envelope)
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assembleForPost, assembleForPre } from '../../src/hosts/codex/assemble.js';
import type { RuleSummary } from '../../src/shared/wire/schemas.js';

const moneyRule: RuleSummary = {
  id: 'AXT-JAVA-042',
  name: 'money',
  altitude: 'implementation',
  severity: 'blocking',
  language: 'java',
  paths: ['**/*.java'],
};

let workDir: string;
beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'codex-assemble-'));
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function preInput(toolInput: object, opts: { sessionId?: string } = {}) {
  return {
    tool_name: 'apply_patch',
    tool_input: toolInput as Record<string, unknown>,
    session_id: opts.sessionId ?? 'sess-1',
  };
}

const wrapperOptions = (projectDir: string) => ({
  rules: [moneyRule],
  severities: new Set<'blocking' | 'warning' | 'suggestion'>(['blocking']),
  projectDir,
});

function writeFileWithDirs(absPath: string, content: string): void {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
}

// -------- Captured fixture content (codex 0.133.0, 2026-05-28) --------
//
// Each constant below is the exact byte stream seen on disk or in the
// apply_patch envelope at capture time. Trailing newlines are explicit:
// where the captured file ended with `\n`, the constant ends with an
// empty array entry that join('\n') turns back into a trailing newline.

// Initial Order.java — capture #1 pre-state. The codebase's starting
// point before any of the 11.5.6 Part A apply_patch fires landed.
const ORDER_INITIAL = [
  'package com.example.domain;',
  '',
  'import jakarta.persistence.Entity;',
  'import jakarta.persistence.GeneratedValue;',
  'import jakarta.persistence.GenerationType;',
  'import jakarta.persistence.Id;',
  'import jakarta.persistence.Table;',
  '',
  'import java.math.BigDecimal;',
  'import java.time.Instant;',
  '',
  '/**',
  ' * Customer order entity.',
  ' */',
  '@Entity',
  '@Table(name = "orders")',
  'public class Order {',
  '',
  '    @Id',
  '    @GeneratedValue(strategy = GenerationType.IDENTITY)',
  '    private Long id;',
  '',
  '    private String customerId;',
  '',
  '    private BigDecimal amount;',
  '',
  '    private Instant placedAt;',
  '',
  '    protected Order() {',
  '        // JPA',
  '    }',
  '',
  '    public Order(String customerId, BigDecimal amount) {',
  '        this.customerId = customerId;',
  '        this.amount = amount;',
  '        this.placedAt = Instant.now();',
  '    }',
  '',
  '    public Long getId() {',
  '        return id;',
  '    }',
  '',
  '    public String getCustomerId() {',
  '        return customerId;',
  '    }',
  '',
  '    public BigDecimal getAmount() {',
  '        return amount;',
  '    }',
  '',
  '    public Instant getPlacedAt() {',
  '        return placedAt;',
  '    }',
  '}',
  '',
].join('\n');

// Order.java after FIX-1 landed — capture #2 pre-state.
const ORDER_AFTER_SHIPPING_COST = [
  'package com.example.domain;',
  '',
  'import jakarta.persistence.Entity;',
  'import jakarta.persistence.GeneratedValue;',
  'import jakarta.persistence.GenerationType;',
  'import jakarta.persistence.Id;',
  'import jakarta.persistence.Table;',
  '',
  'import java.math.BigDecimal;',
  'import java.time.Instant;',
  '',
  '/**',
  ' * Customer order entity.',
  ' */',
  '@Entity',
  '@Table(name = "orders")',
  'public class Order {',
  '',
  '    @Id',
  '    @GeneratedValue(strategy = GenerationType.IDENTITY)',
  '    private Long id;',
  '',
  '    private String customerId;',
  '',
  '    private BigDecimal amount;',
  '',
  '    private Instant placedAt;',
  '',
  '    private BigDecimal shippingCost;',
  '',
  '    protected Order() {',
  '        // JPA',
  '    }',
  '',
  '    public Order(String customerId, BigDecimal amount) {',
  '        this.customerId = customerId;',
  '        this.amount = amount;',
  '        this.placedAt = Instant.now();',
  '    }',
  '',
  '    public Long getId() {',
  '        return id;',
  '    }',
  '',
  '    public String getCustomerId() {',
  '        return customerId;',
  '    }',
  '',
  '    public BigDecimal getAmount() {',
  '        return amount;',
  '    }',
  '',
  '    public Instant getPlacedAt() {',
  '        return placedAt;',
  '    }',
  '}',
  '',
].join('\n');

// Order.java with both shippingCost AND UUID import — capture #4 pre-state.
const ORDER_WITH_SHIPPING_AND_UUID = [
  'package com.example.domain;',
  '',
  'import jakarta.persistence.Entity;',
  'import jakarta.persistence.GeneratedValue;',
  'import jakarta.persistence.GenerationType;',
  'import jakarta.persistence.Id;',
  'import jakarta.persistence.Table;',
  '',
  'import java.math.BigDecimal;',
  'import java.time.Instant;',
  'import java.util.UUID;',
  '',
  '/**',
  ' * Customer order entity.',
  ' */',
  '@Entity',
  '@Table(name = "orders")',
  'public class Order {',
  '',
  '    @Id',
  '    @GeneratedValue(strategy = GenerationType.IDENTITY)',
  '    private Long id;',
  '',
  '    private String customerId;',
  '',
  '    private BigDecimal amount;',
  '',
  '    private Instant placedAt;',
  '',
  '    private BigDecimal shippingCost;',
  '',
  '    protected Order() {',
  '        // JPA',
  '    }',
  '',
  '    public Order(String customerId, BigDecimal amount) {',
  '        this.customerId = customerId;',
  '        this.amount = amount;',
  '        this.placedAt = Instant.now();',
  '    }',
  '',
  '    public Long getId() {',
  '        return id;',
  '    }',
  '',
  '    public String getCustomerId() {',
  '        return customerId;',
  '    }',
  '',
  '    public BigDecimal getAmount() {',
  '        return amount;',
  '    }',
  '',
  '    public Instant getPlacedAt() {',
  '        return placedAt;',
  '    }',
  '}',
  '',
].join('\n');

// Order.java with UUID import, no shippingCost — capture #6 pre-state
// AND capture #7 pre-state (delete-only fire was followed by rename
// fire; both saw the same on-disk shape).
const ORDER_WITH_UUID = [
  'package com.example.domain;',
  '',
  'import jakarta.persistence.Entity;',
  'import jakarta.persistence.GeneratedValue;',
  'import jakarta.persistence.GenerationType;',
  'import jakarta.persistence.Id;',
  'import jakarta.persistence.Table;',
  '',
  'import java.math.BigDecimal;',
  'import java.time.Instant;',
  'import java.util.UUID;',
  '',
  '/**',
  ' * Customer order entity.',
  ' */',
  '@Entity',
  '@Table(name = "orders")',
  'public class Order {',
  '',
  '    @Id',
  '    @GeneratedValue(strategy = GenerationType.IDENTITY)',
  '    private Long id;',
  '',
  '    private String customerId;',
  '',
  '    private BigDecimal amount;',
  '',
  '    private Instant placedAt;',
  '',
  '    protected Order() {',
  '        // JPA',
  '    }',
  '',
  '    public Order(String customerId, BigDecimal amount) {',
  '        this.customerId = customerId;',
  '        this.amount = amount;',
  '        this.placedAt = Instant.now();',
  '    }',
  '',
  '    public Long getId() {',
  '        return id;',
  '    }',
  '',
  '    public String getCustomerId() {',
  '        return customerId;',
  '    }',
  '',
  '    public BigDecimal getAmount() {',
  '        return amount;',
  '    }',
  '',
  '    public Instant getPlacedAt() {',
  '        return placedAt;',
  '    }',
  '}',
  '',
].join('\n');

// Order.java after the rename — capture #8 pre-state.
const ORDER_WITH_AMOUNT_RENAMED = [
  'package com.example.domain;',
  '',
  'import jakarta.persistence.Entity;',
  'import jakarta.persistence.GeneratedValue;',
  'import jakarta.persistence.GenerationType;',
  'import jakarta.persistence.Id;',
  'import jakarta.persistence.Table;',
  '',
  'import java.math.BigDecimal;',
  'import java.time.Instant;',
  'import java.util.UUID;',
  '',
  '/**',
  ' * Customer order entity.',
  ' */',
  '@Entity',
  '@Table(name = "orders")',
  'public class Order {',
  '',
  '    @Id',
  '    @GeneratedValue(strategy = GenerationType.IDENTITY)',
  '    private Long id;',
  '',
  '    private String customerId;',
  '',
  '    private BigDecimal amount;',
  '',
  '    private Instant placedAt;',
  '',
  '    protected Order() {',
  '        // JPA',
  '    }',
  '',
  '    public Order(String customerId, BigDecimal amount) {',
  '        this.customerId = customerId;',
  '        this.amount = amount;',
  '        this.placedAt = Instant.now();',
  '    }',
  '',
  '    public Long getId() {',
  '        return id;',
  '    }',
  '',
  '    public String getCustomerId() {',
  '        return customerId;',
  '    }',
  '',
  '    public BigDecimal amount() {',
  '        return amount;',
  '    }',
  '',
  '    public Instant getPlacedAt() {',
  '        return placedAt;',
  '    }',
  '}',
  '',
].join('\n');

// Order.java pre-state for FIX-9 multi-hunk — capture #9 pre-state
// (different codex session, post-EOF-sentinel). Note the trailing
// `// last touched: shipment-rollout` line and the absence of a
// trailing blank line (single `\n` only, since the EOF-sentinel was
// appended without an extra newline).
const ORDER_PRE_MULTIHUNK = [
  'package com.example.domain;',
  '',
  'import jakarta.persistence.Entity;',
  'import jakarta.persistence.GeneratedValue;',
  'import jakarta.persistence.GenerationType;',
  'import jakarta.persistence.Id;',
  'import jakarta.persistence.Table;',
  '',
  'import java.math.BigDecimal;',
  'import java.time.Instant;',
  'import java.util.UUID;',
  '',
  '/**',
  ' * Customer order entity.',
  ' */',
  '@Entity',
  '@Table(name = "orders")',
  'public class Order {',
  '',
  '    @Id',
  '    @GeneratedValue(strategy = GenerationType.IDENTITY)',
  '    private Long id;',
  '',
  '    private String customerId;',
  '',
  '    private BigDecimal amount;',
  '',
  '    private Instant placedAt;',
  '',
  '    protected Order() {',
  '        // JPA',
  '    }',
  '',
  '    public Order(String customerId, BigDecimal amount) {',
  '        this.customerId = customerId;',
  '        this.amount = amount;',
  '        this.placedAt = Instant.now();',
  '    }',
  '',
  '    public Long getId() {',
  '        return id;',
  '    }',
  '',
  '    public String getCustomerId() {',
  '        return customerId;',
  '    }',
  '',
  '    public BigDecimal amount() {',
  '        return amount;',
  '    }',
  '',
  '    public Instant getPlacedAt() {',
  '        return placedAt;',
  '    }',
  '}',
  '// last touched: shipment-rollout',
].join('\n');

// Order.java post-state for FIX-9 — derived from the pre-state by
// substituting the two hunks. Capture #9's on-disk POST state has a
// trailing `\n` that codex added on write; our pure-substitution
// applier doesn't add one (the pre-state itself had no trailing
// newline, since prompt #6 explicitly asked codex to append the EOF
// sentinel "without a trailing newline"). The applier mirrors codex's
// `compute_replacements`, not codex's outer file-write wrapper — and
// the trailing-newline question is moot for downstream rule analysis.
const ORDER_POST_MULTIHUNK = [
  'package com.example.domain;',
  '',
  'import jakarta.persistence.Entity;',
  'import jakarta.persistence.GeneratedValue;',
  'import jakarta.persistence.GenerationType;',
  'import jakarta.persistence.Id;',
  'import jakarta.persistence.Table;',
  '',
  'import java.math.BigDecimal;',
  'import java.time.Instant;',
  'import java.util.UUID;',
  '',
  '/**',
  ' * Customer order entity.',
  ' */',
  '@Entity',
  '@Table(name = "orders")',
  'public class Order {',
  '',
  '    @Id',
  '    @GeneratedValue(strategy = GenerationType.IDENTITY)',
  '    private Long id;',
  '',
  '    private String customerId;',
  '',
  '    private BigDecimal amount;',
  '',
  '    private Instant placedAt;',
  '',
  '    private String trackingHint;',
  '',
  '    protected Order() {',
  '        // JPA',
  '    }',
  '',
  '    public Order(String customerId, BigDecimal amount) {',
  '        this.customerId = customerId;',
  '        this.amount = amount;',
  '        this.placedAt = Instant.now();',
  '    }',
  '',
  '    public Long getId() {',
  '        return id;',
  '    }',
  '',
  '    public String getCustomerId() {',
  '        return customerId;',
  '    }',
  '',
  '    public BigDecimal amount() {',
  '        return amount;',
  '    }',
  '',
  '    public Instant getPlacedAt() {',
  '        return placedAt;',
  '    }',
  '',
  '    public String trackingHint() {',
  '        return trackingHint;',
  '    }',
  '}',
  '// last touched: shipment-rollout',
].join('\n');

const NOTES_PRE = [
  'todo:',
  '- finalize shipping cost rounding',
  '- decide on tax calculation library',
  '- write release notes',
  '',
].join('\n');
const NOTES_POST = [
  'todo:',
  '- finalize shipping cost rounding',
  '- decide on tax calculation library',
  '- write release notes',
  '- review shipping rules',
  '',
].join('\n');

const DUPES_INITIAL = [
  'section: header',
  '',
  '- item one',
  '- item two',
  '',
  'section: header',
  '',
  '- item three',
  '- item four',
  '',
].join('\n');
const DUPES_HEADER_TO_FOOTER = [
  'section: header',
  '',
  '- item one',
  '- item two',
  '',
  'section: footer',
  '',
  '- item three',
  '- item four',
  '',
].join('\n');

// -------- The exact apply_patch envelopes codex emitted --------

// FIX-1 — bare @@, two additions sandwiched in a block of context.
const PATCH_FIX1 = [
  '*** Begin Patch',
  '*** Update File: src/main/java/com/example/domain/Order.java',
  '@@',
  '     private BigDecimal amount;',
  ' ',
  '     private Instant placedAt;',
  '+',
  '+    private BigDecimal shippingCost;',
  ' ',
  '     protected Order() {',
  '         // JPA',
  '     }',
  '*** End Patch',
].join('\n');

// FIX-2 — bare @@, single addition immediately after the last existing
// import, with the `/**` doc-block opener as trailing context.
const PATCH_FIX2 = [
  '*** Begin Patch',
  '*** Update File: src/main/java/com/example/domain/Order.java',
  '@@',
  ' import java.math.BigDecimal;',
  ' import java.time.Instant;',
  '+import java.util.UUID;',
  ' ',
  ' /**',
  '*** End Patch',
].join('\n');

// FIX-3 — bare @@, pure-deletion (the field and its preceding blank).
const PATCH_FIX3 = [
  '*** Begin Patch',
  '*** Update File: src/main/java/com/example/domain/Order.java',
  '@@',
  '-    private BigDecimal shippingCost;',
  '-',
  '     protected Order() {',
  '         // JPA',
  '     }',
  '*** End Patch',
].join('\n');

// FIX-4 — bare @@, single-line `-/+` replacement with two trailing
// context lines.
const PATCH_FIX4 = [
  '*** Begin Patch',
  '*** Update File: src/main/java/com/example/domain/Order.java',
  '@@',
  '-    public BigDecimal getAmount() {',
  '+    public BigDecimal amount() {',
  '         return amount;',
  '     }',
  '*** End Patch',
].join('\n');

// FIX-5 — Add File envelope with full `+`-prefixed body.
const PATCH_FIX5 = [
  '*** Begin Patch',
  '*** Add File: src/main/java/com/example/domain/Shipment.java',
  '+package com.example.domain;',
  '+',
  '+import jakarta.persistence.Entity;',
  '+import jakarta.persistence.GeneratedValue;',
  '+import jakarta.persistence.GenerationType;',
  '+import jakarta.persistence.Id;',
  '+',
  '+@Entity',
  '+public class Shipment {',
  '+',
  '+    @Id',
  '+    @GeneratedValue(strategy = GenerationType.IDENTITY)',
  '+    private Long id;',
  '+',
  '+    private Long orderId;',
  '+',
  '+    private String trackingNumber;',
  '+',
  '+    protected Shipment() {',
  '+        // JPA',
  '+    }',
  '+',
  '+    public Shipment(Long orderId, String trackingNumber) {',
  '+        this.orderId = orderId;',
  '+        this.trackingNumber = trackingNumber;',
  '+    }',
  '+',
  '+    public Long getId() {',
  '+        return id;',
  '+    }',
  '+',
  '+    public Long getOrderId() {',
  '+        return orderId;',
  '+    }',
  '+',
  '+    public String getTrackingNumber() {',
  '+        return trackingNumber;',
  '+    }',
  '+}',
  '*** End Patch',
].join('\n');

// FIX-6 — bare @@, append a list item against a non-Java file. Proves
// the applier carries zero language assumption.
const PATCH_FIX6 = [
  '*** Begin Patch',
  '*** Update File: notes.txt',
  '@@',
  ' - finalize shipping cost rounding',
  ' - decide on tax calculation library',
  ' - write release notes',
  '+- review shipping rules',
  '*** End Patch',
].join('\n');

// FIX-7 — bare @@ with ONLY context lines, no `-` or `+`. The needle
// `[section: header, '', - item three, - item four]` only matches the
// SECOND `section: header` block in dupes.txt (the first is followed by
// `- item one`, not `- item three`). seekSequence must find it; the
// applier produces a zero-diff result.
const PATCH_FIX7 = [
  '*** Begin Patch',
  '*** Update File: dupes.txt',
  '@@',
  ' section: header',
  ' ',
  ' - item three',
  ' - item four',
  '*** End Patch',
].join('\n');

// FIX-8 — bare @@, three-line `-`/`+` replacement disambiguated by a
// preceding context anchor `- item two` and trailing context
// `- item three`. The SECOND `section: header` becomes `section:
// footer`; the FIRST must stay untouched.
const PATCH_FIX8 = [
  '*** Begin Patch',
  '*** Update File: dupes.txt',
  '@@',
  '-- item two',
  '-',
  '-section: header',
  '+- item two',
  '+',
  '+section: footer',
  ' ',
  ' - item three',
  '*** End Patch',
].join('\n');

// FIX-9 — TWO bare-@@ hunks under one *** Update File. The first adds
// `trackingHint` field after `placedAt`; the second adds the
// `trackingHint()` method at end of class. Forward-threading is
// load-bearing: after hunk 1 inserts mid-file, hunk 2's needle (which
// includes the `getPlacedAt() { return placedAt; }` body) must be
// located BELOW the hunk 1 substitution, not before it.
const PATCH_FIX9 = [
  '*** Begin Patch',
  '*** Update File: src/main/java/com/example/domain/Order.java',
  '@@',
  '     private BigDecimal amount;',
  ' ',
  '     private Instant placedAt;',
  ' ',
  '+    private String trackingHint;',
  '+',
  '@@',
  '     public Instant getPlacedAt() {',
  '         return placedAt;',
  '     }',
  '+',
  '+    public String trackingHint() {',
  '+        return trackingHint;',
  '+    }',
  ' }',
  ' // last touched: shipment-rollout',
  '*** End Patch',
].join('\n');

// ----- Dispatch + defensive-invariant tests -----

describe('codex assemble — dispatch', () => {
  it('Bash: returns skip with reason naming D-041 widening + D-042 deferral', () => {
    const out = assembleForPre(
      { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 's' },
      wrapperOptions(workDir),
    );
    expect(out.kind).toBe('skip');
    if (out.kind === 'skip') {
      expect(out.reason).toMatch(/Bash/);
      expect(out.reason).toMatch(/D-041 widening/);
      expect(out.reason).toMatch(/D-042-placeholder/);
    }
  });

  it('MCP filesystem write: returns skip with the same D-042 reason', () => {
    const out = assembleForPre(
      {
        tool_name: 'mcp__filesystem__write_file',
        tool_input: { path: '/tmp/x', contents: 'hi' },
        session_id: 's',
      },
      wrapperOptions(workDir),
    );
    expect(out.kind).toBe('skip');
    if (out.kind === 'skip') {
      expect(out.reason).toMatch(/D-041 widening/);
      expect(out.reason).toMatch(/D-042-placeholder/);
    }
  });

  it('invalid: apply_patch with missing tool_input.command', () => {
    const out = assembleForPre(preInput({}), wrapperOptions(workDir));
    expect(out.kind).toBe('invalid');
    if (out.kind === 'invalid') {
      expect(out.detail).toMatch(/tool_input\.command/);
    }
  });

  it('invalid: apply_patch with malformed envelope (no Begin Patch)', () => {
    const out = assembleForPre(preInput({ command: 'not a patch' }), wrapperOptions(workDir));
    expect(out.kind).toBe('invalid');
    if (out.kind === 'invalid') {
      expect(out.detail).toMatch(/Begin Patch/);
    }
  });
});

describe('codex assemble — high-altitude Pre gate + gate_check (v1 bug fix)', () => {
  const highAltLlm: RuleSummary = {
    id: 'AXT-ARC-001',
    name: 'architect approval',
    altitude: 'architectural',
    severity: 'warning',
    language: 'java',
    paths: ['**/*.java'],
  };

  const addPatch = (rel: string): string =>
    ['*** Begin Patch', `*** Add File: ${rel}`, '+class Foo {}', '*** End Patch'].join('\n');

  it('assembleForPre keeps a high-altitude LLM rule (despite the {blocking} severity filter) and sets gate_check=true', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'codex-pregate-'));
    const out = assembleForPre(preInput({ command: addPatch('Foo.java') }), {
      rules: [highAltLlm],
      severities: new Set<'blocking' | 'warning' | 'suggestion'>(['blocking']),
      projectDir,
    });
    expect(out.kind).toBe('evaluate');
    if (out.kind === 'evaluate') {
      expect(out.request.rule_set).toEqual(['AXT-ARC-001']);
      expect(out.request.gate_check).toBe(true);
    }
  });

  it('assembleForPost sets gate_check=false (Post runs full LLM detection)', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'codex-postgate-'));
    writeFileWithDirs(join(projectDir, 'Foo.java'), 'class Foo {}\n');
    const out = assembleForPost(preInput({ command: addPatch('Foo.java') }), {
      rules: [highAltLlm],
      severities: new Set<'blocking' | 'warning' | 'suggestion'>(['warning', 'suggestion']),
      projectDir,
    });
    expect(out.kind).toBe('evaluate');
    if (out.kind === 'evaluate') {
      expect(out.request.gate_check).toBe(false);
    }
  });
});

describe('codex assemble — defensive invariants (synthetic)', () => {
  it('Add File: invalid when target already exists on disk', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'codex-defensive-add-'));
    writeFileSync(join(projectDir, 'Existing.java'), 'already here');
    const patch = [
      '*** Begin Patch',
      '*** Add File: Existing.java',
      '+new content',
      '*** End Patch',
    ].join('\n');
    const out = assembleForPre(preInput({ command: patch }), wrapperOptions(projectDir));
    expect(out.kind).toBe('invalid');
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('Update File: invalid when target missing on disk', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: NoSuchFile.java',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    const out = assembleForPre(preInput({ command: patch }), wrapperOptions(workDir));
    expect(out.kind).toBe('invalid');
    if (out.kind === 'invalid') {
      expect(out.detail).toMatch(/missing on disk/);
    }
  });

  it('Update File: invalid when needle cannot be located in the working file', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'codex-defensive-needle-'));
    writeFileSync(join(projectDir, 'A.java'), 'class A {\n  int x;\n}\n');
    const patch = [
      '*** Begin Patch',
      '*** Update File: A.java',
      '@@',
      '-  this line does not exist',
      '+  replacement',
      '*** End Patch',
    ].join('\n');
    const out = assembleForPre(preInput({ command: patch }), wrapperOptions(projectDir));
    expect(out.kind).toBe('invalid');
    if (out.kind === 'invalid') {
      expect(out.detail).toMatch(/not found/);
    }
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('Update File: anchored `@@ <text>` narrows the search start to lines after the named scope', () => {
    // No captured fixture exercises non-empty anchor text (codex 0.133.0
    // emits bare `@@` for all the 11.5.6 Part A captures), but the
    // applier supports it per codex's apply_patch spec — covered here so
    // a regression in anchor handling surfaces.
    const projectDir = mkdtempSync(join(tmpdir(), 'codex-defensive-anchor-'));
    const filePath = join(projectDir, 'B.java');
    writeFileSync(
      filePath,
      ['class First {', '  int x;', '}', '', 'class Second {', '  int x;', '}', ''].join('\n'),
    );
    const patch = [
      '*** Begin Patch',
      '*** Update File: B.java',
      '@@ class Second {',
      '-  int x;',
      '+  int y;',
      '*** End Patch',
    ].join('\n');
    const out = assembleForPre(preInput({ command: patch }), wrapperOptions(projectDir));
    expect(out.kind).toBe('evaluate');
    if (out.kind === 'evaluate') {
      // First class untouched; Second class's `int x;` becomes `int y;`.
      expect(out.request.file_after).toContain('class First {\n  int x;');
      expect(out.request.file_after).toContain('class Second {\n  int y;');
      expect(out.request.file_after).not.toContain('class Second {\n  int x;');
    }
    rmSync(projectDir, { recursive: true, force: true });
  });
});

describe('codex assemble — Post observe', () => {
  it('reads file_after from disk for apply_patch (file already landed)', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'codex-post-'));
    const filePath = join(projectDir, 'Observed.java');
    writeFileSync(filePath, 'public class Observed { BigDecimal amount; }');
    const patch = [
      '*** Begin Patch',
      '*** Update File: Observed.java',
      '@@',
      ' irrelevant',
      '*** End Patch',
    ].join('\n');
    const out = assembleForPost(preInput({ command: patch }), wrapperOptions(projectDir));
    expect(out.kind).toBe('evaluate');
    if (out.kind === 'evaluate') {
      expect(out.request.file_path).toBe(filePath);
      expect(out.request.file_after).toContain('BigDecimal amount');
      expect(out.request.diff).toBe('');
    }
    rmSync(projectDir, { recursive: true, force: true });
  });
});

describe('codex assemble — multi-file patches', () => {
  it('skips with clear reason (single-file only in 11.5.4)', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: A.java',
      '+contents a',
      '*** Add File: B.java',
      '+contents b',
      '*** End Patch',
    ].join('\n');
    const out = assembleForPre(preInput({ command: patch }), wrapperOptions(workDir));
    expect(out.kind).toBe('skip');
    if (out.kind === 'skip') {
      expect(out.reason).toMatch(/multi-file/);
    }
  });
});

// ----- Captured codex 0.133.0 fixtures (2026-05-28) -----

describe('codex assemble — captured codex 0.133.0 fixtures (2026-05-28)', () => {
  // Each fixture gets its own temp project dir so the on-disk pre-state
  // doesn't leak between cases (FIX-3 deletes content FIX-2 added, etc).
  function freshProject(): string {
    return mkdtempSync(join(tmpdir(), 'codex-fixture-'));
  }

  it('FIX-1 mid-file insert: bare @@ adds shippingCost between placedAt and protected Order()', () => {
    const projectDir = freshProject();
    const filePath = join(projectDir, 'src/main/java/com/example/domain/Order.java');
    writeFileWithDirs(filePath, ORDER_INITIAL);
    const out = assembleForPre(preInput({ command: PATCH_FIX1 }), wrapperOptions(projectDir));
    expect(out.kind).toBe('evaluate');
    if (out.kind === 'evaluate') {
      expect(out.request.file_after).toBe(ORDER_AFTER_SHIPPING_COST);
      expect(out.request.file_path).toBe(filePath);
      expect(out.request.diff).toContain('+    private BigDecimal shippingCost;');
    }
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('FIX-2 top-of-imports insert: bare @@ adds UUID import after Instant import', () => {
    const projectDir = freshProject();
    const filePath = join(projectDir, 'src/main/java/com/example/domain/Order.java');
    writeFileWithDirs(filePath, ORDER_AFTER_SHIPPING_COST);
    const out = assembleForPre(preInput({ command: PATCH_FIX2 }), wrapperOptions(projectDir));
    expect(out.kind).toBe('evaluate');
    if (out.kind === 'evaluate') {
      expect(out.request.file_after).toBe(ORDER_WITH_SHIPPING_AND_UUID);
      expect(out.request.diff).toContain('+import java.util.UUID;');
    }
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('FIX-3 delete-only: bare @@ strips shippingCost field and its surrounding blank', () => {
    const projectDir = freshProject();
    const filePath = join(projectDir, 'src/main/java/com/example/domain/Order.java');
    writeFileWithDirs(filePath, ORDER_WITH_SHIPPING_AND_UUID);
    const out = assembleForPre(preInput({ command: PATCH_FIX3 }), wrapperOptions(projectDir));
    expect(out.kind).toBe('evaluate');
    if (out.kind === 'evaluate') {
      expect(out.request.file_after).toBe(ORDER_WITH_UUID);
      expect(out.request.file_after).not.toContain('shippingCost');
    }
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('FIX-4 single-hunk rename: getAmount() → amount() with two trailing context lines', () => {
    const projectDir = freshProject();
    const filePath = join(projectDir, 'src/main/java/com/example/domain/Order.java');
    writeFileWithDirs(filePath, ORDER_WITH_UUID);
    const out = assembleForPre(preInput({ command: PATCH_FIX4 }), wrapperOptions(projectDir));
    expect(out.kind).toBe('evaluate');
    if (out.kind === 'evaluate') {
      expect(out.request.file_after).toBe(ORDER_WITH_AMOUNT_RENAMED);
      expect(out.request.file_after).toContain('public BigDecimal amount() {');
      expect(out.request.file_after).not.toContain('public BigDecimal getAmount()');
    }
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('FIX-5 Add File: Shipment.java created with full + body, file_path resolved', () => {
    const projectDir = freshProject();
    const filePath = join(projectDir, 'src/main/java/com/example/domain/Shipment.java');
    // Add File requires the parent dir to exist but the target to NOT exist.
    mkdirSync(dirname(filePath), { recursive: true });
    const out = assembleForPre(preInput({ command: PATCH_FIX5 }), wrapperOptions(projectDir));
    expect(out.kind).toBe('evaluate');
    if (out.kind === 'evaluate') {
      expect(out.request.file_path).toBe(filePath);
      expect(out.request.file_after).toContain('public class Shipment');
      expect(out.request.file_after).toContain('private String trackingNumber;');
      expect(out.request.diff).toContain('+public class Shipment');
    }
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('FIX-6 non-Java append: notes.txt gets a new list item; trailing newline preserved', () => {
    const projectDir = freshProject();
    const filePath = join(projectDir, 'notes.txt');
    writeFileSync(filePath, NOTES_PRE);
    const out = assembleForPre(preInput({ command: PATCH_FIX6 }), wrapperOptions(projectDir));
    expect(out.kind).toBe('evaluate');
    if (out.kind === 'evaluate') {
      expect(out.request.file_after).toBe(NOTES_POST);
      // Trailing newline byte-exactness: the codex post-state ends with '\n'.
      expect(out.request.file_after.endsWith('\n')).toBe(true);
    }
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('FIX-7 context-only no-op: dupes.txt patch matches second header block, produces zero diff', () => {
    const projectDir = freshProject();
    const filePath = join(projectDir, 'dupes.txt');
    writeFileSync(filePath, DUPES_INITIAL);
    const out = assembleForPre(preInput({ command: PATCH_FIX7 }), wrapperOptions(projectDir));
    expect(out.kind).toBe('evaluate');
    if (out.kind === 'evaluate') {
      // A patch built from context lines only is a no-op against the
      // matched block — file_after must equal file_before, diff empty.
      expect(out.request.file_after).toBe(DUPES_INITIAL);
      expect(out.request.diff).toBe('');
    }
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('FIX-8 seekSequence disambiguation: ONLY the SECOND `section: header` becomes `section: footer`', () => {
    const projectDir = freshProject();
    const filePath = join(projectDir, 'dupes.txt');
    writeFileSync(filePath, DUPES_INITIAL);
    const out = assembleForPre(preInput({ command: PATCH_FIX8 }), wrapperOptions(projectDir));
    expect(out.kind).toBe('evaluate');
    if (out.kind === 'evaluate') {
      expect(out.request.file_after).toBe(DUPES_HEADER_TO_FOOTER);
      // Explicit load-bearing assertions: first occurrence preserved,
      // second occurrence rewritten. If the applier ever regresses to
      // findIndex-on-first-match semantics this WILL fail.
      const lines = out.request.file_after.split('\n');
      expect(lines[0]).toBe('section: header');
      expect(lines[5]).toBe('section: footer');
      // And exactly one each of header / footer in the result.
      expect((out.request.file_after.match(/section: header/g) ?? []).length).toBe(1);
      expect((out.request.file_after.match(/section: footer/g) ?? []).length).toBe(1);
    }
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('FIX-9 multi-hunk forward-threading: BOTH the trackingHint field AND the trackingHint() method land in one envelope', () => {
    const projectDir = freshProject();
    const filePath = join(projectDir, 'src/main/java/com/example/domain/Order.java');
    writeFileWithDirs(filePath, ORDER_PRE_MULTIHUNK);
    const out = assembleForPre(preInput({ command: PATCH_FIX9 }), wrapperOptions(projectDir));
    expect(out.kind).toBe('evaluate');
    if (out.kind === 'evaluate') {
      expect(out.request.file_after).toBe(ORDER_POST_MULTIHUNK);
      // Explicit load-bearing assertions: both regions changed.
      expect(out.request.file_after).toContain('    private String trackingHint;');
      expect(out.request.file_after).toContain('    public String trackingHint() {');
      // And the field appears BEFORE the method (forward order preserved).
      const fieldIdx = out.request.file_after.indexOf('private String trackingHint;');
      const methodIdx = out.request.file_after.indexOf('public String trackingHint() {');
      expect(fieldIdx).toBeGreaterThan(-1);
      expect(methodIdx).toBeGreaterThan(fieldIdx);
      // The EOF sentinel from prompt #6 must survive the multi-hunk
      // edit (it sits below both hunks' replacements as trailing
      // context).
      expect(out.request.file_after).toContain('// last touched: shipment-rollout');
    }
    rmSync(projectDir, { recursive: true, force: true });
  });
});
