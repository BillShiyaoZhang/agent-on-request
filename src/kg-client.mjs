import { AppError, requireThat } from './errors.mjs';

const ROLES = ['Alice', 'Bob'];
const SESSION = /^[A-Za-z0-9_.-]{1,100}$/;

/** Uses each agent's native workbench API as its authoritative knowledge source. */
export function createKGClient({ endpoints, timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const targets = Object.fromEntries(ROLES.map(role => {
    const input = endpoints?.[role] ?? endpoints?.[role.toLowerCase()];
    const url = URL.parse(input?.url);
    requireThat(url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
      'KG_CONFIGURATION', `Configure the ${role} native KG service URL.`, 503);
    requireThat(typeof input.token === 'string' && input.token.length >= 16 && !/[\r\n]/.test(input.token),
      'KG_CONFIGURATION', `Configure the ${role} native KG service token.`, 503);
    return [role, { url: url.href.replace(/\/$/, ''), token: input.token }];
  }));
  requireThat(targets.Alice.url !== targets.Bob.url && targets.Alice.token !== targets.Bob.token,
    'KG_CONFIGURATION', 'Alice and Bob require separate native KG endpoints and credentials.', 503);

  function verifyRole(role, value) {
    requireThat(value?.role === role, 'KG_ROLE', 'The native KG response belongs to a different agent.', 502);
    return value;
  }

  async function request(role, path, { method = 'GET', body } = {}) {
    const target = targets[role];
    requireThat(target, 'KG_ROLE', 'Choose Alice or Bob.', 422);
    let response;
    try {
      response = await fetchImpl(target.url + path, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + target.token,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body) });
    } catch { throw new AppError('KG_UNAVAILABLE', `${role}'s native KG service is unavailable. Restore it and retry the same operation.`, 503); }
    let value;
    try { value = await response.json(); }
    catch { throw new AppError('KG_RESPONSE', `${role}'s native KG service returned an invalid response.`, 502); }
    if (!response.ok) throw new AppError(response.status === 409 ? 'KG_CONFLICT' : 'KG_UNAVAILABLE',
      response.status === 409 ? `${role}'s knowledge changed. Reload the native state before retrying.`
        : `${role}'s native KG service could not complete this operation.`, response.status >= 500 ? 503 : response.status);
    return value;
  }

  function roundPath({ sessionId, epoch }) {
    requireThat(typeof sessionId === 'string' && SESSION.test(sessionId) && Number.isSafeInteger(epoch) && epoch > 0,
      'KG_SESSION', 'A valid session and epoch are required.', 422);
    return '/api/demo/rounds/' + encodeURIComponent(sessionId) + '/' + epoch;
  }

  async function snapshots(ref) {
    const rows = await Promise.all(ROLES.map(async role => {
      const value = verifyRole(role, await request(role, roundPath(ref)));
      requireThat(value.sessionId === ref.sessionId && value.epoch === ref.epoch && Array.isArray(value.receipts)
        && value.profile && value.graph && value.provenance?.provider === 'kg',
      'KG_SNAPSHOT', 'The native KG returned a different or incomplete round snapshot.', 502);
      return value;
    }));
    return Object.fromEntries(rows.map((value, index) => [ROLES[index], value]));
  }

  async function defaults() {
    const rows = await Promise.all(ROLES.map(async role => verifyRole(role, await request(role, '/api/demo/default'))));
    requireThat(rows[0].provenance?.namespace && rows[1].provenance?.namespace
      && rows[0].provenance.namespace !== rows[1].provenance.namespace,
    'KG_ISOLATION', 'Alice and Bob require independent native KG namespaces.', 502);
    return { conditions: { schemaVersion: 1, presetId: 'custom', componentIds: { Alice: [], Bob: [] },
      agents: Object.fromEntries(rows.map((value, index) => [ROLES[index], value.profile])) },
      revisions: Object.fromEntries(rows.map((value, index) => [ROLES[index], value.revision])),
      provenance: Object.fromEntries(rows.map((value, index) => [ROLES[index], value.provenance])) };
  }

  return {
    async check() { return Object.fromEntries(await Promise.all(ROLES.map(async role => [role, verifyRole(role, await request(role, '/api/demo/health'))]))); },
    async initialize(conditions) {
      const health = await Promise.all(ROLES.map(async role => verifyRole(role, await request(role, '/api/demo/health'))));
      requireThat(health.every(value => value.ok && value.provider === 'kg' && typeof value.namespace === 'string')
        && health[0].namespace !== health[1].namespace, 'KG_ISOLATION', 'Both role-scoped native KG services must be ready.', 503);
      await Promise.all(ROLES.map(role => request(role, '/api/demo/default', { method: 'PUT',
        body: { profile: conditions.agents[role], seedOnly: true } })));
      return defaults();
    },
    defaults,
    async begin(ref) {
      await Promise.all(ROLES.map(role => request(role, roundPath(ref), { method: 'PUT', body: { profile: ref.conditions.agents[role] } })));
      return snapshots(ref);
    },
    async recordReceipt(ref) {
      requireThat(['aliceToBob', 'bobToAlice'].includes(ref.direction) && ref.receipt?.status === 'received',
        'KG_RECEIPT', 'Only actual receiver-confirmed receipts can enter the KG.', 422);
      const role = ref.direction === 'aliceToBob' ? 'Bob' : 'Alice';
      return request(role, roundPath(ref) + '/receipts', { method: 'POST', body: { direction: ref.direction, receipt: ref.receipt } });
    },
    snapshots,
    async finish(ref) {
      await Promise.all(ROLES.map(role => request(role, roundPath(ref) + '/result', { method: 'PUT', body: { result: ref.result } })));
      return snapshots(ref);
    },
  };
}
