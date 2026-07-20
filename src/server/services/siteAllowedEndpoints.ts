export const SITE_ALLOWED_ENDPOINT_ORDER = ['chat', 'messages', 'responses'] as const;
export type SiteAllowedEndpoint = (typeof SITE_ALLOWED_ENDPOINT_ORDER)[number];

const ALLOWED_SET = new Set<string>(SITE_ALLOWED_ENDPOINT_ORDER);

export type ParsedSiteAllowedEndpointsInput = {
  present: boolean;
  valid: boolean;
  allowedEndpoints: string | null;
  endpoints: SiteAllowedEndpoint[] | null;
  error?: string;
};

function normalizeEndpointList(raw: unknown[]): SiteAllowedEndpoint[] | null {
  const seen = new Set<SiteAllowedEndpoint>();
  for (const item of raw) {
    if (typeof item !== 'string') return null;
    const normalized = item.trim().toLowerCase();
    if (!ALLOWED_SET.has(normalized)) return null;
    seen.add(normalized as SiteAllowedEndpoint);
  }
  return SITE_ALLOWED_ENDPOINT_ORDER.filter((endpoint) => seen.has(endpoint));
}

export function parseSiteAllowedEndpointsInput(input: unknown): ParsedSiteAllowedEndpointsInput {
  if (input === undefined) {
    return { present: false, valid: true, allowedEndpoints: null, endpoints: null };
  }
  if (input === null) {
    return { present: true, valid: true, allowedEndpoints: null, endpoints: null };
  }

  let list: unknown = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      return { present: true, valid: true, allowedEndpoints: null, endpoints: null };
    }
    try {
      list = JSON.parse(trimmed);
    } catch {
      return {
        present: true,
        valid: false,
        allowedEndpoints: null,
        endpoints: null,
        error: 'Invalid allowedEndpoints. Expected an array of chat, messages, responses.',
      };
    }
  }

  if (!Array.isArray(list)) {
    return {
      present: true,
      valid: false,
      allowedEndpoints: null,
      endpoints: null,
      error: 'Invalid allowedEndpoints. Expected an array of chat, messages, responses.',
    };
  }

  if (list.length === 0) {
    return { present: true, valid: true, allowedEndpoints: null, endpoints: null };
  }

  const endpoints = normalizeEndpointList(list);
  if (!endpoints) {
    return {
      present: true,
      valid: false,
      allowedEndpoints: null,
      endpoints: null,
      error: 'Invalid allowedEndpoints. Expected an array of chat, messages, responses.',
    };
  }

  if (endpoints.length === 0) {
    return { present: true, valid: true, allowedEndpoints: null, endpoints: null };
  }

  return {
    present: true,
    valid: true,
    allowedEndpoints: JSON.stringify(endpoints),
    endpoints,
  };
}

export function readSiteAllowedEndpoints(input: unknown): SiteAllowedEndpoint[] | null {
  const parsed = parseSiteAllowedEndpointsInput(input);
  if (!parsed.valid) return null;
  return parsed.endpoints;
}
