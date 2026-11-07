import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPayload } from './runtime-helpers.mjs';
import { AppError } from './errors.mjs';

export const RESEARCH_ROLES = Object.freeze(['Alice', 'Bob']);
export const RESEARCH_TASK_TYPES = Object.freeze(['schedule', 'select_presentation', 'prepare_discussion']);
const clone = value => structuredClone(value);
const repository = fileURLToPath(new URL('../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const profileKeys = ['ontology', 'knowledge', 'calendar', 'materials', 'interests', 'reportAnnotations', 'skills', 'policyTemplates'];

function requireRole(role) {
  if (!RESEARCH_ROLES.includes(role)) throw new AppError('RESEARCH_ROLE', 'Choose Alice or Bob.', 422);
  return role.toLowerCase();
}
function readJson(filename, description) {
  try { return JSON.parse(readFileSync(filename, 'utf8')); }
  catch { throw new AppError('RESEARCH_WORKSPACE', `Cannot load ${description}.`, 503); }
}

/** Read exactly one role's complete, versioned seed. Neither peer seed files nor
 * acceptance answers are required to initialize this researcher. */
function readWorkspace(role) {
  const key = requireRole(role), directory = path.join(repository, 'workspaces', key);
  const manifest = readJson(path.join(directory, 'manifest.json'), `${role}'s workspace manifest`);
  const fail = message => { throw new AppError('RESEARCH_WORKSPACE_MANIFEST', message, 503); };
  if (manifest.schemaVersion !== 1 || manifest.role !== role || !manifest.version || !manifest.files || !manifest.profile)
    fail(`${role}'s workspace manifest has an invalid identity or structure.`);
  const { hash, ...body } = manifest;
  if (hash !== hashPayload(body)) fail(`${role}'s workspace manifest fingerprint changed. Review and update the manifest.`);
  const root = realpathSync(directory), contents = new Map();
  for (const [relative, record] of Object.entries(manifest.files)) {
    if (!/^[A-Za-z0-9_.\/-]+$/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(relative))
      fail(`${role}'s workspace file reference must stay inside its own directory.`);
    let resolved, bytes;
    try { resolved = realpathSync(path.join(directory, relative)); bytes = readFileSync(resolved); }
    catch { fail(`${role}'s workspace file ${relative} is missing or unreadable.`); }
    if (!resolved.startsWith(root + path.sep)) fail(`${role}'s workspace file reference leaves its own directory.`);
    if (typeof record?.sha256 !== 'string' || sha256(bytes) !== record.sha256)
      fail(`${role}'s workspace file ${relative} differs from its reviewed manifest. Update the manifest after reviewing the change.`);
    contents.set(relative, bytes.toString('utf8'));
  }
  const profile = { role, name: manifest.name, field: manifest.field, description: manifest.description, synthetic: manifest.synthetic === true };
  for (const name of profileKeys) {
    const relative = manifest.profile[name];
    if (typeof relative !== 'string' || !contents.has(relative)) fail(`${role}'s manifest does not include its ${name} source.`);
    try { profile[name] = JSON.parse(contents.get(relative)); } catch { fail(`${role}'s ${name} source is not valid JSON.`); }
  }
  if (profile.ontology?.owner !== role) fail(`${role}'s ontology belongs to a different workspace.`);
  for (const skill of profile.skills ?? []) {
    const prefix = `workspaces/${key}/`;
    if (typeof skill.path !== 'string' || !skill.path.startsWith(prefix) || !contents.has(skill.path.slice(prefix.length)))
      fail(`${role}'s skill source must be a reviewed file in this workspace.`);
  }
  profile.seed = { version: manifest.version, hash, manifestHash: hash, directory: `workspaces/${key}` };
  const validation = validateResearchProfile(profile);
  if (!validation.valid) fail(`${role}'s workspace has invalid ontology, evidence or skill references: ${validation.errors[0].message}`);
  return { manifest, profile };
}

export function researchProfile(role) {
  return clone(readWorkspace(role).profile);
}

export function researchWorkspaceManifest(role) {
  return clone(readWorkspace(role).manifest);
}

export function researchSeedHash(role) {
  return readWorkspace(role).manifest.hash;
}

export function researchConference() {
  const conference = readJson(path.join(repository, 'demo', 'environment', 'conference.json'), 'the public conference program');
  if ((conference.reports ?? []).some(report => report.topics && (Object.hasOwn(report.topics, 'Alice') || Object.hasOwn(report.topics, 'Bob'))))
    throw new AppError('RESEARCH_ENVIRONMENT', 'Public conference data cannot contain personal researcher annotations.', 503);
  return conference;
}

/** Test-only reference fixture. Runtime agents receive proposed correspondences
 * exclusively through their actual task communication, not this answer file. */
export function researchMappings() {
  return readJson(path.join(repository, 'demo', 'acceptance', 'mappings.json'), 'the acceptance-only reference mappings');
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
    if (typeof node.id !== 'string' || !node.id.startsWith(`${profile.role.toLowerCase()}:`)) error(node.id, 'Knowledge belongs in this role namespace.');
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
    if (typeof edge.id !== 'string' || !edge.id.startsWith(`${profile.role.toLowerCase()}:`)) error(edge.id, 'Knowledge edges belong in this role namespace.');
    if (edgeIds.has(edge.id)) error(edge.id, 'Knowledge edge IDs must be unique.'); edgeIds.add(edge.id);
    const source = nodes.get(edge.source), target = nodes.get(edge.target), relation = relations.get(edge.relation);
    if (!source || !target || !relation) { error(edge.id, 'Graph endpoints and relation definitions must exist.'); continue; }
    for (const [node, allowed, side] of [[source, relation.domain, 'domain'], [target, relation.range, 'range']]) {
      if (!allowed.includes('*') && !allowed.some(type => ancestors(node.type).has(type))) error(edge.id, `The relation ${side} does not accept ${node.type}.`);
    }
  }
  const materialIds = new Set();
  for (const material of profile.materials ?? []) {
    if (typeof material.id !== 'string' || !material.id.startsWith(`${profile.role.toLowerCase()}:`)) error(material.id, 'Material belongs in this role namespace.');
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
  const reportIds = new Set();
  for (const annotation of profile.reportAnnotations ?? []) {
    if (typeof annotation.reportId !== 'string' || !annotation.reportId || reportIds.has(annotation.reportId)) error('$.reportAnnotations', 'Personal report annotations need unique report IDs.');
    reportIds.add(annotation.reportId);
    if (typeof annotation.recordType !== 'string' || !concepts.has(annotation.recordType)) error(annotation.reportId, 'Personal presentation record types must be declared in this role ontology.');
    if (!Array.isArray(annotation.topicIds) || annotation.topicIds.some(id => !nodes.has(id))) error(annotation.reportId, 'Personal report annotations may reference only own research topics.');
    if (!annotation.source || !annotation.version) error(annotation.reportId, 'Personal report annotations retain a source and version.');
  }
  const { hash, ...definition } = profile.ontology;
  if (hash !== hashPayload(definition)) error('$.ontology.hash', 'The ontology digest does not match its actual definitions.');
  return { valid: errors.length === 0, errors };
}
