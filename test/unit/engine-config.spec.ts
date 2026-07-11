import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConsultConfig, loadEngineConfig } from '../../src/shared/engine/config.js';

/**
 * The consult path is quality-first (mentor 45s + adversarial guard 45s),
 * NOT fast-budgeted like the gate/evaluate hook (10s). It therefore reads its
 * own timeout knob and must never inherit the hook's short budget.
 */
describe('loadConsultConfig', () => {
  const SAVED = { ...process.env };

  beforeEach(() => {
    delete process.env.AXTAR_CONSULT_TIMEOUT_MS;
    delete process.env.AXTAR_HOOK_TIMEOUT_MS;
    delete process.env.AXTAR_ENGINE_URL;
    delete process.env.AXTAR_API_KEY;
  });

  afterEach(() => {
    process.env = { ...SAVED };
  });

  it('defaults to a 90s budget — well above the 10s hook timeout', () => {
    expect(loadConsultConfig().timeoutMs).toBe(90000);
    expect(loadConsultConfig().timeoutMs).toBeGreaterThan(loadEngineConfig().timeoutMs);
  });

  it('honours AXTAR_CONSULT_TIMEOUT_MS when set', () => {
    process.env.AXTAR_CONSULT_TIMEOUT_MS = '120000';
    expect(loadConsultConfig().timeoutMs).toBe(120000);
  });

  it('ignores invalid AXTAR_CONSULT_TIMEOUT_MS, keeping the 90s default', () => {
    process.env.AXTAR_CONSULT_TIMEOUT_MS = 'not-a-number';
    expect(loadConsultConfig().timeoutMs).toBe(90000);
    process.env.AXTAR_CONSULT_TIMEOUT_MS = '0';
    expect(loadConsultConfig().timeoutMs).toBe(90000);
  });

  it('does NOT fall back to AXTAR_HOOK_TIMEOUT_MS (the gate budget)', () => {
    // Mutation guard: if consult inherits the hook timeout, this is 10000 → fail.
    process.env.AXTAR_HOOK_TIMEOUT_MS = '10000';
    expect(loadConsultConfig().timeoutMs).toBe(90000);
  });

  it('shares baseUrl and apiKey with the gate config — only the timeout differs', () => {
    process.env.AXTAR_ENGINE_URL = 'http://example.test:9000';
    process.env.AXTAR_API_KEY = 'axtar_pk_test';
    const consult = loadConsultConfig();
    expect(consult.baseUrl).toBe('http://example.test:9000');
    expect(consult.apiKey).toBe('axtar_pk_test');
    expect(consult.timeoutMs).toBe(90000);
  });
});
