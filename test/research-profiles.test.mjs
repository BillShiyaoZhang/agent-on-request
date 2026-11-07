import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { researchProfile, researchConference, researchMappings, selectWorkingOntology, validateResearchProfile, RESEARCH_ROLES } from '../src/research-profiles.mjs';
import { hashPayload } from '../src/runtime-helpers.mjs';

const walk = (profile, id, relation, reverse = false) => profile.knowledge.edges
  .filter(edge => edge.relation === relation && edge[reverse ? 'target' : 'source'] === id)
  .map(edge => edge[reverse ? 'source' : 'target']);

test('research profiles have independent, complete definitions and validated source-backed data', () => {
  for (const role of RESEARCH_ROLES) {
    const profile = researchProfile(role);
    assert.deepEqual(validateResearchProfile(profile), { valid: true, errors: [] });
    assert.equal(profile.ontology.basis.preset, 'personal');
    assert.ok(profile.ontology.modules.some(module => module.id.endsWith(':time')));
    assert.ok(profile.ontology.modules.some(module => module.id.endsWith(':collaboration')));
    assert.equal(profile.materials.find(material => material.id.endsWith(':research-brief')).visibility, 'private');
    assert.equal(profile.materials.find(material => material.id.endsWith(':public-intro')).ownerConfirmedVisibility, true);
  }
  assert.notEqual(researchProfile('Alice').ontology.hash, researchProfile('Bob').ontology.hash);
  const modified = researchProfile('Alice'); modified.knowledge.nodes[0].label = 'Changed';
  assert.equal(researchProfile('Alice').knowledge.nodes[0].label, 'Alice');
  assert.throws(() => researchProfile('Mallory'), error => error.code === 'RESEARCH_ROLE');
});

test('ordinary Alice query traces a claim through observed evidence to exact researched ontology versions', () => {
  const profile = researchProfile('Alice');
  const metrics = walk(profile, 'alice:claim', 'alice:supportedBy');
  assert.deepEqual(metrics, ['alice:metric']);
  const runs = walk(profile, metrics[0], 'alice:producesMetric', true);
  assert.deepEqual(runs, ['alice:experiment']);
  const mappingSet = walk(profile, runs[0], 'alice:evaluatesMapping')[0];
  assert.deepEqual(walk(profile, mappingSet, 'alice:sourceOntology'), ['alice:ontology-source']);
  assert.deepEqual(walk(profile, mappingSet, 'alice:targetOntology'), ['alice:ontology-target']);
  const artifact = profile.knowledge.nodes.find(node => node.id === 'alice:ontology-source');
  assert.equal(artifact.type, 'alice:OntologyArtifactVersion');
  assert.notEqual(artifact.id, profile.ontology.id);
});

test('ordinary Bob query traces an interaction design to findings and actual fixture observations', () => {
  const profile = researchProfile('Bob');
  const implication = walk(profile, 'bob:design', 'bob:informsDesign', true)[0];
  const finding = walk(profile, implication, 'bob:derivedFromFinding')[0];
  const observation = walk(profile, finding, 'bob:supportedBy')[0];
  const session = walk(profile, observation, 'bob:observedIn')[0];
  assert.equal(profile.knowledge.nodes.find(node => node.id === session).properties.synthetic, true);
  const types = profile.ontology.modules.flatMap(module => module.concepts);
  assert.match(types.find(term => term.id === 'bob:ParticipantConsentRecord').definition, /not authorization/);
});

test('working subsets include dependency closure, exclude unnecessary research evidence and consume actual exported ontology', () => {
  const profile = researchProfile('Alice');
  const working = selectWorkingOntology('Alice', 'schedule', profile);
  assert.deepEqual(working.modules.map(module => module.id), ['alice:personal', 'alice:time']);
  assert.ok(working.excludedModuleIds.includes('alice:evidence'));
  assert.equal(Object.hasOwn(working, 'knowledge'), false);
  profile.ontology.modules.find(module => module.id === 'alice:time').name = 'Owner-edited time module';
  const { hash: _, ...definition } = profile.ontology;
  profile.ontology.hash = hashPayload(definition);
  assert.equal(selectWorkingOntology('Alice', 'schedule', profile).modules[1].name, 'Owner-edited time module');
  assert.throws(() => selectWorkingOntology('Alice', 'unsupported'), error => error.code === 'RESEARCH_TASK');
  assert.throws(() => selectWorkingOntology('Bob', 'schedule', profile), error => error.code === 'RESEARCH_ROLE');
});

test('public conference keeps personal report interpretations independent and reference mappings are acceptance-only evidence', () => {
  const conference = researchConference();
  assert.equal(conference.synthetic, true);
  assert.ok(conference.reports.every(report => !Object.hasOwn(report, 'topics')));
  const offered = role => researchProfile(role).reportAnnotations.filter(annotation => annotation.topicIds.length).map(annotation => annotation.reportId);
  assert.deepEqual(offered('Alice'), ['R1', 'R3']);
  assert.deepEqual(offered('Bob'), ['R2', 'R3']);
  assert.deepEqual(offered('Alice').filter(id => offered('Bob').includes(id)), ['R3']);
  const candidates = researchMappings();
  assert.equal(candidates.find(mapping => mapping.id === 'alignment-label').valid, false);
  assert.equal(candidates.find(mapping => mapping.id === 'provenance-transparency').relation, 'related');
  assert.equal(candidates.find(mapping => mapping.id === 'review-control').relation, 'narrower');
  assert.match(candidates.find(mapping => mapping.id === 'individual-presentation').condition, /never a complete ProgramSession/);
  for (const mapping of candidates) {
    const sourceIds = researchProfile('Alice').ontology.modules.flatMap(module => module.concepts.map(term => term.id));
    const targetIds = researchProfile('Bob').ontology.modules.flatMap(module => module.concepts.map(term => term.id));
    assert.ok(sourceIds.includes(mapping.source)); assert.ok(targetIds.includes(mapping.target));
  }
});

test('profile validation rejects broken graph semantics, skill dependencies, cycles and altered definitions', () => {
  const profile = researchProfile('Alice');
  profile.knowledge.edges[0].target = 'alice:missing';
  profile.skills[0].modules.push('alice:absent');
  profile.ontology.modules[0].dependencies.push('alice:time');
  const result = validateResearchProfile(profile);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.message.includes('Graph endpoints')));
  assert.ok(result.errors.some(error => error.message.includes('dependency module')));
  assert.ok(result.errors.some(error => error.message.includes('cyclic')));
  assert.ok(result.errors.some(error => error.path === '$.ontology.hash'));
  const badEdge = researchProfile('Bob');
  badEdge.knowledge.edges[0].target = 'bob:observation';
  assert.ok(validateResearchProfile(badEdge).errors.some(error => error.message.includes('relation range')));
});

test('every declared domain and common skill has a usable native skill document and explicit ontology contract', async () => {
  for (const role of RESEARCH_ROLES) for (const skill of researchProfile(role).skills) {
    const document = await readFile(new URL(`../${skill.path}`, import.meta.url), 'utf8');
    assert.ok(document.includes(`name: ${skill.id}`));
    assert.ok(document.includes('## Procedure'));
    assert.ok(document.includes('## Verification'));
    assert.ok(skill.modules.length && skill.inputTypes.length && skill.outputTypes.length && skill.tools.length);
    for (const tool of skill.tools) assert.ok(document.includes(tool.replaceAll('.', '_')), `${skill.id} must describe its ${tool} tool`);
  }
});
