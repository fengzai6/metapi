import { describe, expect, it } from 'vitest';
import {
  parseSiteAllowedEndpointsInput,
  readSiteAllowedEndpoints,
} from './siteAllowedEndpoints.js';

describe('parseSiteAllowedEndpointsInput', () => {
  it('treats undefined as absent', () => {
    expect(parseSiteAllowedEndpointsInput(undefined)).toEqual({
      present: false,
      valid: true,
      allowedEndpoints: null,
      endpoints: null,
    });
  });

  it('treats null, empty string and empty array as unrestricted', () => {
    for (const input of [null, '', '   ', []]) {
      const parsed = parseSiteAllowedEndpointsInput(input);
      expect(parsed).toEqual({
        present: true,
        valid: true,
        allowedEndpoints: null,
        endpoints: null,
      });
    }
  });

  it('normalizes, dedupes and orders endpoints', () => {
    const parsed = parseSiteAllowedEndpointsInput(['Responses', 'chat', 'CHAT', 'messages']);
    expect(parsed.valid).toBe(true);
    expect(parsed.endpoints).toEqual(['chat', 'messages', 'responses']);
    expect(parsed.allowedEndpoints).toBe(JSON.stringify(['chat', 'messages', 'responses']));
  });

  it('accepts JSON string arrays', () => {
    const parsed = parseSiteAllowedEndpointsInput('["messages","chat"]');
    expect(parsed.valid).toBe(true);
    expect(parsed.endpoints).toEqual(['chat', 'messages']);
  });

  it('rejects invalid values', () => {
    for (const input of [['chat', 'foo'], 'not-json', { chat: true }, 1, [1]]) {
      const parsed = parseSiteAllowedEndpointsInput(input);
      expect(parsed.present).toBe(true);
      expect(parsed.valid).toBe(false);
      expect(parsed.error).toMatch(/allowedEndpoints/i);
    }
  });
});

describe('readSiteAllowedEndpoints', () => {
  it('returns null for unrestricted or invalid stored values', () => {
    expect(readSiteAllowedEndpoints(null)).toBeNull();
    expect(readSiteAllowedEndpoints('')).toBeNull();
    expect(readSiteAllowedEndpoints('[]')).toBeNull();
    expect(readSiteAllowedEndpoints('{"bad":true}')).toBeNull();
  });

  it('returns normalized endpoints for valid stored JSON', () => {
    expect(readSiteAllowedEndpoints('["responses","chat"]')).toEqual(['chat', 'responses']);
  });
});
