import { readFileSync } from 'node:fs';
import { hashPayload } from './runtime-helpers.mjs';
import { AppError } from './errors.mjs';

export const RESEARCH_ROLES = Object.freeze(['Alice', 'Bob']);
export const RESEARCH_TASK_TYPES = Object.freeze(['schedule', 'select_presentation', 'prepare_discussion']);
const clone = value => structuredClone(value);
const readSource = name => JSON.parse(readFileSync(new URL(`../profiles/research/${name}.json`, import.meta.url), 'utf8'));
const baseline = readSource('baseline');
const sources = { Alice: readSource('alice'), Bob: readSource('bob') };
const conference = readSource('conference');
const mappings = readSource('mappings');

function requireRole(role) {
  if (!RESEARCH_ROLES.includes(role)) throw new AppError('RESEARCH_ROLE', 'Choose Alice or Bob.', 422);
  return role.toLowerCase();
}
const definitions = [
  { id: 'coordinate-calendar', label: 'Coordinate academic calendars', description: 'Find a mutually offered interval using only scoped availability and actual peer receipts.', modules: ['time'], inputTypes: ['TimeInterval'], outputTypes: ['AttendancePlan'], tools: ['knowledge.search', 'authorization.check', 'peer.request', 'peer.send', 'task.status'], sideEffects: ['disclose-availability'] },
  { id: 'plan-conference', label: 'Plan conference attendance', description: 'Use research questions, topic meanings and individually identified presentations to plan learning.', modules: ['research'], inputTypes: ['ResearchQuestion', 'Conference'], outputTypes: ['AttendancePlan'], tools: ['knowledge.search', 'ontology.describe', 'alignment.propose', 'alignment.accept', 'peer.send', 'task.status'], sideEffects: ['disclose-working-ontology', 'disclose-report-selection'] },
  { id: 'prepare-discussion', label: 'Prepare a research discussion', description: 'Combine independently understood research questions and actually received materials into a sourced agenda.', modules: ['collaboration'], inputTypes: ['ResearchQuestion', 'DocumentVersion'], outputTypes: ['DiscussionPlan', 'AgendaItem'], tools: ['knowledge.search', 'artifact.prepare', 'artifact.revise', 'peer.request', 'task.checkpoint', 'task.status'], sideEffects: ['write-local-draft'] },
  { id: 'share-materials', label: 'Share selected research materials', description: 'Prepare an exact versioned projection, obtain current permission and send only approved fields.', modules: ['materials'], inputTypes: ['DocumentVersion'], outputTypes: ['SelectedExcerpt'], tools: ['artifact.prepare', 'authorization.check', 'authorization.request', 'peer.send', 'task.checkpoint', 'task.status'], sideEffects: ['disclose-material'] },
  { id: 'authorization-memory', label: 'Retrieve and request authorization', description: 'Find relevant long-term rules and task grants, propose an explicit standing rule for owner confirmation, then verify current authority before an external effect.', modules: ['work'], inputTypes: ['Task'], outputTypes: ['Decision'], tools: ['knowledge.search', 'authorization.list', 'authorization.check', 'authorization.request', 'authorization.propose_policy', 'task.checkpoint'], sideEffects: ['request-owner-decision', 'propose-standing-policy'] },
  { id: 'reserve-resource', label: 'Coordinate rooms and resources', description: 'Match requirements to rooms, prepare an exact booking and execute only with independently checked permission.', modules: ['collaboration'], inputTypes: ['VenueRequirement'], outputTypes: ['ReservationProposal', 'ConfirmedReservation'], tools: ['resource.search', 'artifact.prepare', 'authorization.check', 'authorization.request', 'reservation.submit', 'task.status'], sideEffects: ['reserve-resource'] },
];
const domainSkills = {
  Alice: [
    { id: 'research-lineage', label: 'Maintain research and literature lineage', description: 'Connect papers, notes, methods and datasets to research questions while preserving source and version evidence.', modules: ['research', 'semantics'], inputTypes: ['ResearchQuestion', 'Paper'], outputTypes: ['ResearchNote', 'ReadingPlan'], tools: ['knowledge.search', 'artifact.prepare', 'artifact.revise'], sideEffects: ['write-local-draft'] },
    { id: 'semantic-review', label: 'Review semantic models and mappings', description: 'Inspect researched ontology artifacts and mapping candidates; retain definitions, counterexamples and review scope.', modules: ['semantics'], inputTypes: ['OntologyArtifactVersion', 'MappingCandidate'], outputTypes: ['HumanReviewDecision', 'ResearchNote'], tools: ['knowledge.search', 'ontology.describe', 'artifact.prepare'], sideEffects: ['write-local-draft'] },
    { id: 'compare-experiments', label: 'Compare experiments and trace claims', description: 'Trace a claim to metrics, experiment inputs and exact ontology versions; compare like-for-like configurations.', modules: ['evidence'], inputTypes: ['ResearchClaim', 'ExperimentRun'], outputTypes: ['BenchmarkReport'], tools: ['knowledge.search', 'artifact.prepare'], sideEffects: ['write-local-draft'] },
    { id: 'research-brief', label: 'Prepare a sourced research brief', description: 'Prepare a concise account of research questions, methods, evidence and limitations from explicit source versions.', modules: ['evidence', 'materials'], inputTypes: ['ResearchProject', 'DocumentVersion'], outputTypes: ['DocumentVersion', 'SelectedExcerpt'], tools: ['knowledge.search', 'artifact.prepare', 'artifact.revise', 'authorization.check', 'authorization.request'], sideEffects: ['write-local-draft', 'request-owner-decision'] }
  ],
  Bob: [
    { id: 'organize-user-study', label: 'Organize user-study evidence', description: 'Connect research questions, protocols, sessions, observations and findings without treating interpretations as observations.', modules: ['study', 'findings'], inputTypes: ['UserStudy', 'Observation'], outputTypes: ['StudyReport'], tools: ['knowledge.search', 'artifact.prepare', 'artifact.revise'], sideEffects: ['write-local-draft'] },
    { id: 'review-interaction', label: 'Review interaction alternatives', description: 'Compare prototypes and design alternatives against user needs, use contexts and supported findings.', modules: ['interaction', 'findings'], inputTypes: ['InteractivePrototype', 'DesignAlternative'], outputTypes: ['DesignRationale', 'DesignNote'], tools: ['knowledge.search', 'artifact.prepare'], sideEffects: ['write-local-draft'] },
    { id: 'synthesize-findings', label: 'Synthesize scoped research findings', description: 'Trace observations supporting findings and summarize design implications with context and limitations.', modules: ['findings'], inputTypes: ['Finding', 'Observation'], outputTypes: ['DesignImplication', 'StudyReport'], tools: ['knowledge.search', 'artifact.prepare', 'artifact.revise'], sideEffects: ['write-local-draft'] },
    { id: 'cross-domain-brief', label: 'Prepare cross-domain collaboration briefs', description: 'Translate HCI research into partner-facing questions and design suggestions without equating unrelated domain terms.', modules: ['findings', 'materials'], inputTypes: ['ResearchQuestion', 'Finding'], outputTypes: ['DiscussionPlan', 'DocumentVersion'], tools: ['knowledge.search', 'ontology.describe', 'artifact.prepare', 'authorization.check', 'authorization.request'], sideEffects: ['write-local-draft', 'request-owner-decision'] }
  ]
};

function materialize(role) {
  const prefix = requireRole(role);
  const source = sources[role];
  const qualify = id => id === '*' ? id : `${prefix}:${id}`;
  const modules = [...baseline.modules, ...source.modules].map(item => ({
    ...clone(item), id: qualify(item.id), owner: role,
    dependencies: item.dependencies.map(qualify),
    concepts: item.concepts.map(term => ({ ...clone(term), id: qualify(term.id), uri: `urn:agent-on-request:research:${prefix}:ontology:${term.id}`,
      ...(term.parent ? { parent: qualify(term.parent) } : {}),
      properties: (term.properties ?? []).map(property => ({ ...clone(property), id: qualify(`${term.id}.${property.id}`), key: property.id,
        definition: property.definition ?? `${property.id} of ${term.label}.` })) })),
    relations: item.relations.map(relation => ({ ...clone(relation), id: qualify(relation.id),
      domain: relation.domain.map(qualify), range: relation.range.map(qualify) }))
  }));
  const ontology = { id: `urn:agent-on-request:research:${prefix}:application-ontology`, owner: role,
    version: source.version, basis: clone(baseline.basis), baselineVersion: baseline.version, modules };
  ontology.hash = hashPayload(ontology);
  const sourceRef = `synthetic:${prefix}:research-fixture:${source.version}`;
  return {
    role, name: source.name, field: source.field, description: source.description, synthetic: true, ontology,
    skills: [...definitions, ...domainSkills[role]].map(skill => ({ ...clone(skill), modules: skill.modules.map(qualify),
      inputTypes: skill.inputTypes.map(qualify), outputTypes: skill.outputTypes.map(qualify),
      ...(domainSkills[role].includes(skill) ? { tools: [...skill.tools, 'knowledge.record'], sideEffects: [...skill.sideEffects, 'write-private-knowledge'] } : {}),
      path: `skills/research/${definitions.includes(skill) ? 'common' : prefix}/${skill.id}/SKILL.md` })),
    knowledge: {
      nodes: source.knowledge.nodes.map(node => ({ ...clone(node), id: qualify(node.id), type: qualify(node.type),
        source: sourceRef, version: '1', visibility: node.visibility ?? 'private' })),
      edges: source.knowledge.edges.map(([from, to, relation], index) => ({ id: qualify(`edge-${index + 1}`), source: qualify(from), target: qualify(to), relation: qualify(relation), sourceRecord: sourceRef, version: '1' }))
    },
    calendar: clone(source.calendar),
    materials: source.materials.map(material => ({ ...clone(material), id: qualify(material.id), source: sourceRef,
      sourceIds: material.sourceIds.map(qualify), ownerConfirmedVisibility: true })),
    interests: source.interests.map(qualify)
  };
}

/** Immutable package definitions are materialized into an independent role namespace on each call. */
export function researchProfile(role) {
  return materialize(role);
}

export function researchConference() {
  return clone(conference);
}

/** Candidates are evidence for peer review, never pre-existing accepted mappings or grants. */
export function researchMappings() {
  return clone(mappings);
}

/** The optional profile is the version exported by the role's actual KG, rather than a second schema copy. */
export function selectWorkingOntology(role, input, profile = researchProfile(role)) {
  requireRole(role);
  const taskType = typeof input === 'string' ? input : input?.type;
  if (!RESEARCH_TASK_TYPES.includes(taskType)) throw new AppError('RESEARCH_TASK', 'Choose a supported research task.', 422);
  if (profile.role !== role || profile.ontology?.owner !== role) throw new AppError('RESEARCH_ROLE', 'The ontology belongs to a different role.', 422);
  const prefix = role.toLowerCase();
  const roots = taskType === 'schedule' ? ['time'] : taskType === 'select_presentation' ? ['research']
    : ['collaboration', role === 'Alice' ? 'evidence' : 'findings'];
  const index = new Map(profile.ontology.modules.map(module => [module.id, module]));
  const selected = new Set();
  function add(id) {
    if (selected.has(id)) return;
    const item = index.get(id);
    if (!item) throw new AppError('RESEARCH_ONTOLOGY', `Missing required ontology module ${id}.`, 422);
    selected.add(id);
    item.dependencies.forEach(add);
  }
  roots.map(id => `${prefix}:${id}`).forEach(add);
  const modules = profile.ontology.modules.filter(module => selected.has(module.id));
  const result = { owner: role, id: profile.ontology.id, version: profile.ontology.version,
    ontologyHash: profile.ontology.hash, taskType, modules: clone(modules),
    excludedModuleIds: profile.ontology.modules.filter(module => !selected.has(module.id)).map(module => module.id) };
  return { ...result, hash: hashPayload(result) };
}

export function validateResearchProfile(profile) {
  const errors = [];
  const error = (path, message) => errors.push({ path, message });
  if (!profile || typeof profile !== 'object') return { valid: false, errors: [{ path: '$', message: 'A profile is required.' }] };
  if (!RESEARCH_ROLES.includes(profile.role)) error('$.role', 'A supported role is required.');
  const modules = profile.ontology?.modules;
  if (!Array.isArray(modules)) return { valid: false, errors: [...errors, { path: '$.ontology.modules', message: 'Ontology modules are required.' }] };
  if (profile.ontology.owner !== profile.role) error('$.ontology.owner', 'Ontology and profile owners must agree.');
  const moduleIndex = new Map(), concepts = new Map(), relations = new Map();
  const ids = new Set();
  function unique(id, path) {
    if (typeof id !== 'string' || !id.startsWith(`${String(profile.role).toLowerCase()}:`)) error(path, 'Use an ID within the role namespace.');
    if (ids.has(id)) error(path, 'Identifiers must be unique.');
    ids.add(id);
  }
  modules.forEach((module, i) => {
    unique(module.id, `$.ontology.modules[${i}].id`); moduleIndex.set(module.id, module);
    if (!Array.isArray(module.dependencies) || !Array.isArray(module.concepts) || !Array.isArray(module.relations)) { error(`$.ontology.modules[${i}]`, 'Module arrays are required.'); return; }
    module.concepts.forEach((term, j) => {
      unique(term.id, `$.ontology.modules[${i}].concepts[${j}].id`); concepts.set(term.id, term);
      if (!term.definition?.trim()) error(term.id, 'Every concept needs an explicit definition.');
      (term.properties ?? []).forEach(property => {
        unique(property.id, `${term.id}.properties`);
        if (!['string', 'string[]', 'integer', 'number', 'boolean'].includes(property.datatype)) error(property.id, 'Use a supported property datatype.');
      });
    });
    module.relations.forEach(relation => { unique(relation.id, `$.ontology.modules[${i}].relations`); relations.set(relation.id, relation); });
  });
  const visiting = new Set(), visited = new Set();
  function visitModule(id) {
    if (visiting.has(id)) { error(id, 'Module dependencies cannot be cyclic.'); return; }
    if (visited.has(id)) return;
    const module = moduleIndex.get(id);
    if (!module) { error(id, 'Module dependency is missing.'); return; }
    visiting.add(id); (module.dependencies ?? []).forEach(visitModule); visiting.delete(id); visited.add(id);
  }
  moduleIndex.forEach((_, id) => visitModule(id));
  function ancestors(id, chain = new Set()) {
    if (chain.has(id)) { error(id, 'Class inheritance cannot be cyclic.'); return new Set(); }
    const term = concepts.get(id);
    if (!term) { error(id, 'Concept reference is missing.'); return new Set(); }
    const result = new Set([id]);
    if (term.parent) for (const parent of ancestors(term.parent, new Set([...chain, id]))) result.add(parent);
    return result;
  }
  concepts.forEach((_, id) => ancestors(id));
  relations.forEach(relation => {
    if (!relation.definition?.trim()) error(relation.id, 'Every relation needs an explicit definition.');
    for (const id of [...(relation.domain ?? []), ...(relation.range ?? [])]) if (id !== '*' && !concepts.has(id)) error(relation.id, `Unknown relation endpoint type ${id}.`);
  });
  const nodes = new Map();
  for (const node of profile.knowledge?.nodes ?? []) {
    if (nodes.has(node.id)) error(node.id, 'Knowledge node IDs must be unique.');
    nodes.set(node.id, node);
    if (!concepts.has(node.type)) { error(node.id, 'The node type must be declared in the ontology.'); continue; }
    if (!node.source || !node.version) error(node.id, 'Knowledge must retain a source and version.');
    if (!['public', 'private'].includes(node.visibility)) error(node.id, 'Knowledge must have explicit visibility.');
    const properties = new Map([...ancestors(node.type)].flatMap(type => (concepts.get(type)?.properties ?? []).map(property => [property.key, property])));
    for (const [key, value] of Object.entries(node.properties ?? {})) {
      const property = properties.get(key);
      if (!property) { error(`${node.id}.${key}`, 'The property is not declared for this type.'); continue; }
      const checks = { string: value => typeof value === 'string', 'string[]': value => Array.isArray(value) && value.every(item => typeof item === 'string'), integer: Number.isSafeInteger, number: value => typeof value === 'number' && Number.isFinite(value), boolean: value => typeof value === 'boolean' };
      if (!checks[property.datatype]?.(value)) error(`${node.id}.${key}`, 'The value does not match its declared datatype.');
    }
  }
  const edgeIds = new Set();
  for (const edge of profile.knowledge?.edges ?? []) {
    if (edgeIds.has(edge.id)) error(edge.id, 'Knowledge edge IDs must be unique.'); edgeIds.add(edge.id);
    const source = nodes.get(edge.source), target = nodes.get(edge.target), relation = relations.get(edge.relation);
    if (!source || !target || !relation) { error(edge.id, 'Graph endpoints and relation definitions must exist.'); continue; }
    for (const [node, allowed, side] of [[source, relation.domain, 'domain'], [target, relation.range, 'range']]) {
      if (!allowed.includes('*') && !allowed.some(type => ancestors(node.type).has(type))) error(edge.id, `The relation ${side} does not accept ${node.type}.`);
    }
  }
  const materialIds = new Set();
  for (const material of profile.materials ?? []) {
    if (materialIds.has(material.id)) error(material.id, 'Material IDs must be unique.'); materialIds.add(material.id);
    if (!material.version || !['public', 'private'].includes(material.visibility) || typeof material.ownerConfirmedVisibility !== 'boolean'
      || material.visibility === 'public' && !material.ownerConfirmedVisibility) error(material.id, 'Materials need a version and trusted certification for public visibility.');
    if (!material.sourceIds?.length || material.sourceIds.some(id => !nodes.has(id))) error(material.id, 'Material source references must exist.');
  }
  for (const skill of profile.skills ?? []) {
    for (const id of skill.modules ?? []) if (!moduleIndex.has(id)) error(skill.id, 'Skill dependency module is missing.');
    for (const id of [...(skill.inputTypes ?? []), ...(skill.outputTypes ?? [])]) if (!concepts.has(id)) error(skill.id, 'Skill I/O type must exist in the ontology.');
    if (!skill.tools?.length) error(skill.id, 'A usable skill declares required tools.');
  }
  for (const interest of profile.interests ?? []) if (!nodes.has(interest)) error(interest, 'Research interests must reference knowledge nodes.');
  const { hash, ...definition } = profile.ontology;
  if (hash !== hashPayload(definition)) error('$.ontology.hash', 'The ontology digest does not match its actual definitions.');
  return { valid: errors.length === 0, errors };
}
