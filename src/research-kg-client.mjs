import { AppError, requireThat } from './errors.mjs';
import { RESEARCH_ROLES, validateResearchProfile } from './research-profiles.mjs';
import { hashPayload } from './runtime-helpers.mjs';

const workspaceId = value => {
  requireThat(typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value),
    'RESEARCH_WORKSPACE', 'Use an exact audience workspace UUID.', 422);
  return value;
};
const workspaceRoute = (id, resource) => `/api/research/workspaces/${workspaceId(id)}/${resource}`;

/** Role-scoped native ontology/data bridge. Authorization projections are discoverable evidence only. */
export function createResearchKGClient({ endpoints, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const workspaceNamespaces = new Map();
  const targets = Object.fromEntries(RESEARCH_ROLES.map(role => {
    const input = endpoints?.[role] ?? endpoints?.[role.toLowerCase()];
    const url = URL.parse(input?.url);
    requireThat(url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
      'RESEARCH_KG_CONFIGURATION', 'Each researcher requires a native KG endpoint.', 503);
    requireThat(typeof input.token === 'string' && input.token.length >= 16 && !/[\r\n]/.test(input.token),
      'RESEARCH_KG_CONFIGURATION', 'Each researcher requires a native KG service credential.', 503);
    return [role, { url: url.href.replace(/\/$/, ''), token: input.token }];
  }));
  requireThat(targets.Alice.url !== targets.Bob.url && targets.Alice.token !== targets.Bob.token,
    'RESEARCH_KG_ISOLATION', 'Researchers require independent native endpoints and credentials.', 503);

  async function request(role, route, { method = 'GET', body, requestTimeoutMs = timeoutMs } = {}) {
    const target = targets[role];
    requireThat(target, 'RESEARCH_ROLE', 'Choose Alice or Bob.', 422);
    let response;
    try {
      response = await fetchImpl(target.url + route, { method, redirect: 'error', signal: AbortSignal.timeout(requestTimeoutMs),
        headers: { Accept: 'application/json', Authorization: `Bearer ${target.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new AppError('RESEARCH_KG_UNAVAILABLE', `${role}'s native research KG is unavailable.`, 503); }
    if (!response.ok) throw new AppError(response.status === 409 ? 'RESEARCH_KG_CONFLICT' : 'RESEARCH_KG_UNAVAILABLE',
      response.status === 409 ? 'Native research knowledge changed; reload before retrying.' : 'The native research KG could not complete the request.', response.status === 409 ? 409 : 503);
    let value;
    try { value = await response.json(); } catch { throw new AppError('RESEARCH_KG_RESPONSE', 'The native research KG returned invalid data.', 502); }
    requireThat(value?.role === role, 'RESEARCH_KG_ROLE', 'The native response belongs to another researcher.', 502);
    return value;
  }
  function checkedProfile(role, result, expectedWorkspace, expectedSeed) {
    requireThat(result.profile?.role === role && result.provenance?.provider === 'kg' && typeof result.provenance?.namespace === 'string',
      'RESEARCH_KG_RESPONSE', 'A native role-scoped profile with source provenance is required.', 502);
    const validation = validateResearchProfile(result.profile);
    requireThat(validation.valid, 'RESEARCH_KG_PROFILE', 'The live native ontology and data are inconsistent.', 422, validation.errors);
    if (expectedWorkspace !== undefined) {
      requireThat(result.provenance.workspaceId === expectedWorkspace
        && result.provenance.namespace.includes(`:experience-${expectedWorkspace}:`)
        && /^[a-f0-9]{64}$/.test(result.provenance.seedHash ?? '')
        && (expectedSeed === undefined || result.provenance.seedHash === expectedSeed),
      'RESEARCH_KG_ISOLATION', 'The native profile is not bound to this audience and initial seed.', 502);
      const key = `${expectedWorkspace}:${role}`;
      const otherKey = `${expectedWorkspace}:${role === 'Alice' ? 'Bob' : 'Alice'}`;
      requireThat((!workspaceNamespaces.has(key) || workspaceNamespaces.get(key) === result.provenance.namespace)
        && workspaceNamespaces.get(otherKey) !== result.provenance.namespace,
      'RESEARCH_KG_ISOLATION', 'Each audience requires stable, independent role namespaces.', 502);
      workspaceNamespaces.set(key, result.provenance.namespace);
      return { ...result.profile, nativeWorkspace: { workspaceId: expectedWorkspace, namespace: result.provenance.namespace, seedHash: result.provenance.seedHash } };
    }
    return result.profile;
  }
  return {
    async initialize(profiles) {
      const results = await Promise.all(RESEARCH_ROLES.map(async role => {
        const value = await request(role, '/api/research/profile', { method: 'PUT', body: { profile: profiles[role], seedOnly: true } });
        return { role, value, profile: checkedProfile(role, value) };
      }));
      requireThat(results[0].value.provenance.namespace !== results[1].value.provenance.namespace,
        'RESEARCH_KG_ISOLATION', 'Researchers must use independent native namespaces.', 502);
      return Object.fromEntries(results.map(({ role, profile }) => [role, profile]));
    },
    async createWorkspace(role, { workspaceId: id, profile } = {}) {
      workspaceId(id);
      requireThat(profile?.role === role && validateResearchProfile(profile).valid, 'RESEARCH_KG_PROFILE', 'Provide this researcher’s complete initial seed.', 422);
      const result = await request(role, workspaceRoute(id, 'profile'), { method: 'PUT', body: { profile } });
      return checkedProfile(role, result, id, hashPayload(profile));
    },
    async profile(role, { workspaceId: id } = {}) {
      return checkedProfile(role, await request(role, id === undefined ? '/api/research/profile' : workspaceRoute(id, 'profile')), id);
    },
    async record(role, input) {
      requireThat(typeof input?.workspaceId === 'string' && Array.isArray(input.nodes) && Array.isArray(input.edges),
        'RESEARCH_KNOWLEDGE', 'Research memory requires a workspace and typed nodes and edges.', 422);
      return request(role, workspaceRoute(input.workspaceId, 'knowledge'), { method: 'POST', body: input });
    },
    async project(role, event) {
      requireThat(typeof event?.workspaceId === 'string' && (typeof event?.id === 'string' || Number.isSafeInteger(event?.id)),
        'RESEARCH_PROJECTION', 'A projection requires workspace and ledger event IDs.', 422);
      return request(role, workspaceRoute(event.workspaceId, 'projections'), { method: 'POST', body: { event }, requestTimeoutMs: Math.min(timeoutMs, 2500) });
    }
  };
}
