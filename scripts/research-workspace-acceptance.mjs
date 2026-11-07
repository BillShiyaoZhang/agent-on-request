import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Local fictional acceptance: creates two audiences and acts only as their
// synthetic owners. No operator credentials or role tokens enter the report.
const base = new URL(process.env.DEMO_URL || 'http://127.0.0.1:4327');
assert(['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname));
const output = path.resolve(process.env.DEMO_ARTIFACTS || 'artifacts/research-workspace-acceptance');
async function api(route, token, data) {
  const response = await fetch(new URL(route, base), { method: data === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(60_000) });
  const value = await response.json(); assert(response.ok, `${route}: ${value.error?.code} ${value.error?.message}`); return value;
}
assert.equal((await api('/api/meta')).openControls, true, 'Use the dedicated synthetic localhost demo.');
const catalog = await api('/api/research/catalog');
assert.equal(catalog.conference.synthetic, true);
assert(catalog.conference.reports.every(report => !report.topics));
assert(!JSON.stringify(catalog.profiles).includes('MentalModelAlignmentTopic'));
const audiences = [];
try {
  for (let index = 0; index < 2; index++) {
    const created = await api('/api/research/workspaces', null, {});
    const root = `/api/research/workspaces/${created.workspaceId}`;
    const bob = await api(`/api/admin/research/workspaces/${created.workspaceId}/claim/Bob`, null, {});
    const tokens = { Alice: created.token, Bob: bob.token };
    const initial = Object.fromEntries(await Promise.all(['Alice', 'Bob'].map(async role => [role, await api(root, tokens[role])])));
    audiences.push({ root, tokens, initial, results: [] });
    const audience = audiences.at(-1);
    for (const role of ['Alice', 'Bob']) {
      const state = initial[role];
      assert.equal(state.peer.known, false); assert.equal(state.peer.ontology, null);
      assert.equal(state.messages.length, 0); assert.equal(state.tasks.length, 0); assert.equal(state.authorizations.grants.length, 0);
      assert.match(state.workspace.nativeNamespace, new RegExp(`:experience-${created.workspaceId}:`));
      assert.equal(state.workspace.manifest.role, role);
    }
    if (index === 0) {
      const claim = await api(root + '/query', tokens.Alice, { ids: ['alice:claim'], hops: 2 });
      const experiment = await api(root + '/query', tokens.Alice, { ids: ['alice:experiment'], hops: 2 });
      const design = await api(root + '/query', tokens.Bob, { ids: ['bob:design'], hops: 2 });
      const finding = await api(root + '/query', tokens.Bob, { ids: ['bob:finding'], hops: 1 });
      assert(claim.nodes.some(node => node.type === 'alice:ExperimentRun'));
      assert(experiment.nodes.some(node => node.type === 'alice:OntologyArtifactVersion'));
      assert(design.nodes.some(node => node.type === 'bob:Finding'));
      assert(finding.nodes.some(node => node.type === 'bob:Observation'));
      for (const [role, graph] of [['Alice', claim], ['Alice', experiment], ['Bob', design], ['Bob', finding]]) {
        assert(graph.nodes.every(node => node.id.startsWith(role.toLowerCase() + ':')));
      }
      audience.evidenceQueries = { Alice: [claim, experiment], Bob: [design, finding] };
      console.log('Ordinary evidence queries returned each owner own sources before any collaboration task.');
      for (const type of ['schedule', 'select_presentation', 'prepare_discussion']) {
        let state = await api(root + '/tasks', tokens.Alice, { type, mode: 'controlled' });
        while (state.tasks.at(-1).status === 'needs_owner') {
          for (const role of ['Alice', 'Bob']) {
            const own = role === 'Alice' ? state : await api(root, tokens[role]);
            for (const request of own.authorizations.requests.filter(item => item.status === 'pending')) {
              const fields = request.intent.action === 'reservation.submit' ? request.intent.fields : request.intent.fields.filter(field => !['note', 'results'].includes(field));
              await api(root + `/decisions/${request.id}`, tokens[role], { decision: 'allow', fields,
                expectedRevision: request.revision, expectedPayloadHash: request.payloadHash });
            }
          }
          state = await api(root, tokens.Alice);
        }
        assert.equal(state.tasks.at(-1).status, 'completed', state.tasks.at(-1).error);
        audience.results.push({ type, result: state.tasks.at(-1).result });
        console.log(`agent-comm rehearsal: ${type} completed`);
      }
      assert.equal(audience.results[0].result.meeting.day, 'Thu');
      assert.equal(audience.results[1].result.report.id, 'R3');
      assert.equal(audience.results[2].result.reservation.status, 'confirmed');
      const state = await api(root, tokens.Alice);
      assert(state.authorizations.grants.length >= 2);
      assert(state.messages.some(message => message.resourceId === 'working-ontology'));
      assert(state.tasks.find(task => task.type === 'select_presentation').proposals.some(proposal => proposal.status === 'rejected'));
    } else {
      for (const role of ['Alice', 'Bob']) {
        const first = audiences[0].initial[role], fresh = initial[role];
        assert.equal(fresh.profile.seed.hash, first.profile.seed.hash);
        assert.deepEqual(fresh.profile.calendar, first.profile.calendar);
        assert.deepEqual(fresh.profile.materials, first.profile.materials);
        assert.deepEqual(fresh.profile.knowledge, first.profile.knowledge);
        assert.notEqual(fresh.workspace.nativeNamespace, first.workspace.nativeNamespace);
        assert.equal(fresh.reservations.length, 0);
      }
    }
  }
  const report = { verifiedAt: new Date().toISOString(), audiences: audiences.map(audience => ({
    workspaceId: audience.initial.Alice.workspaceId,
    seeds: Object.fromEntries(['Alice', 'Bob'].map(role => [role, audience.initial[role].profile.seed])),
    namespaces: Object.fromEntries(['Alice', 'Bob'].map(role => [role, audience.initial[role].workspace.nativeNamespace])), results: audience.results,
    evidenceQueries: audience.evidenceQueries ? Object.fromEntries(Object.entries(audience.evidenceQueries).map(([role, graphs]) => [role,
      graphs.map(graph => ({ nodeIds: graph.nodes.map(node => node.id), relations: [...new Set(graph.edges.map(edge => edge.relation))] }))])) : undefined,
  })) };
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Fresh audience isolation and all three agent-comm rehearsals passed; report saved under ${output}.`);
} finally { for (const audience of audiences) await api(audience.root + '/end', audience.tokens.Alice, {}).catch(() => {}); }
