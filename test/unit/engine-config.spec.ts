import { describe, expect, it } from 'vitest';

import {
  API_KEY_ENV,
  DEFAULT_TIMEOUT_MS,
  ENGINE_URL_ENV,
  TIMEOUT_ENV,
  loadEngineConfig,
  setupInstructions,
} from '../../src/shared/engine/config.js';

const BOTH = {
  [ENGINE_URL_ENV]: 'https://app.axtar.dev/mentor',
  [API_KEY_ENV]: 'axtar_pk_test',
};

describe('loadEngineConfig', () => {
  it('reads both variables and strips trailing slashes off the base URL', () => {
    const result = loadEngineConfig({
      ...BOTH,
      [ENGINE_URL_ENV]: 'https://app.axtar.dev/mentor//',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.baseUrl).toBe('https://app.axtar.dev/mentor');
    expect(result.config.apiKey).toBe('axtar_pk_test');
  });

  it('reports every missing variable rather than defaulting to localhost', () => {
    const result = loadEngineConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual([ENGINE_URL_ENV, API_KEY_ENV]);
  });

  it('treats a blank value as missing', () => {
    const result = loadEngineConfig({ ...BOTH, [API_KEY_ENV]: '   ' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual([API_KEY_ENV]);
  });

  it('budgets above the platform 300s check cap by default', () => {
    const result = loadEngineConfig(BOTH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(result.config.timeoutMs).toBeGreaterThan(300_000);
  });

  it('honours a positive AXTAR_CHECK_TIMEOUT_MS and ignores nonsense', () => {
    const at = (raw: string): number => {
      const result = loadEngineConfig({ ...BOTH, [TIMEOUT_ENV]: raw });
      if (!result.ok) throw new Error('expected a config');
      return result.config.timeoutMs;
    };
    expect(at('120000')).toBe(120_000);
    expect(at('0')).toBe(DEFAULT_TIMEOUT_MS);
    expect(at('-5')).toBe(DEFAULT_TIMEOUT_MS);
    expect(at('soon')).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('names the missing variables in the setup instructions', () => {
    const text = setupInstructions([ENGINE_URL_ENV, API_KEY_ENV]);
    expect(text).toContain(ENGINE_URL_ENV);
    expect(text).toContain(API_KEY_ENV);
    expect(text).toContain('/axtar:setup');
  });
});
