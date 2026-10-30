// Gateway-level policy for Codex service tiers.
// `client` keeps the caller's choice, `fast` requests priority routing, and
// `standard` explicitly clears priority routing.

export const SERVICE_TIER_MODES = ['client', 'fast', 'standard'];
export const DEFAULT_SERVICE_TIER_MODE = 'client';

export function normalizeServiceTierMode(value) {
  return SERVICE_TIER_MODES.includes(value) ? value : DEFAULT_SERVICE_TIER_MODE;
}

export function forcedServiceTier(mode) {
  switch (normalizeServiceTierMode(mode)) {
    case 'fast': return 'priority';
    case 'standard': return 'default';
    default: return undefined;
  }
}

export function applyServiceTierPolicy(body, mode) {
  const normalized = normalizeServiceTierMode(mode);
  if (normalized === 'client') {
    if (body.service_tier === 'fast') return { ...body, service_tier: 'priority' };
    return body;
  }
  const payload = { ...body, service_tier: forcedServiceTier(normalized) };
  if (normalized === 'standard') delete payload.service_tier;
  return payload;
}

// app-server's turn/start uses camelCase and accepts "default" as the
// explicit standard-speed sentinel.
export function turnServiceTier(body, mode) {
  const normalized = normalizeServiceTierMode(mode);
  if (normalized === 'fast') return 'priority';
  if (normalized === 'standard') return 'default';
  if (body?.service_tier === 'fast' || body?.service_tier === 'priority') return 'priority';
  if (body?.service_tier === 'default') return 'default';
  return undefined;
}

export function configServiceTier(mode) {
  const normalized = normalizeServiceTierMode(mode);
  return normalized === 'fast' ? 'fast' : normalized === 'standard' ? 'default' : null;
}
