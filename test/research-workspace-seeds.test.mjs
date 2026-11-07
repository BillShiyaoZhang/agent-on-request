import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { researchProfile, researchSeedHash, researchWorkspaceManifest, researchConference, validateResearchProfile } from '../src/research-profiles.mjs';
import { hashPayload } from '../src/runtime-helpers.mjs';

async function isolatedRole(t, role) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'research-role-seed-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'workspaces'));
  for (const file of ['research-profiles.mjs', 'runtime-helpers.mjs', 'errors.mjs']) {
    await copyFile(new URL(`../src/${file}`, import.meta.url), path.join(root, 'src', file));
  }
  await cp(new URL(`../workspaces/${role.toLowerCase()}/`, import.meta.url), path.join(root, 'workspaces', role.toLowerCase()), { recursive: true });
  const module = await import(pathToFileURL(path.join(root, 'src', 'research-profiles.mjs')).href);
  return { root, module, directory: path.join(root, 'workspaces', role.toLowerCase()) };
}

test('each researcher initializes from only its own complete workspace without peer seed, public program or acceptance answers', async t => {
  for (const role of ['Alice', 'Bob']) {
    const { module } = await isolatedRole(t, role);
    const profile = module.researchProfile(role);
    assert.deepEqual(validateResearchProfile(profile), { valid: true, errors: [] });
    assert.equal(profile.skills.length, 10);
    assert.ok(profile.ontology.modules.some(item => item.id.endsWith(':personal')));
    assert.equal(profile.seed.hash, researchSeedHash(role));
    assert.throws(() => module.researchProfile(role === 'Alice' ? 'Bob' : 'Alice'), { code: 'RESEARCH_WORKSPACE' });
    assert.throws(() => module.researchMappings(), { code: 'RESEARCH_WORKSPACE' }, 'Acceptance answers were not eagerly required to initialize this role.');
  }
});

test('manifest fingerprints cover own installed skills and reproducible initial data without importing old authorization uses', async () => {
  for (const role of ['Alice', 'Bob']) {
    const manifest = researchWorkspaceManifest(role), profile = researchProfile(role), other = role === 'Alice' ? 'bob' : 'alice';
    const { hash, ...body } = manifest;
    assert.equal(hash, hashPayload(body));
    assert.equal(hash, profile.seed.manifestHash);
    for (const skill of profile.skills) {
      assert.ok(skill.path.startsWith(`workspaces/${role.toLowerCase()}/skills/`));
      const document = await readFile(new URL(`../${skill.path}`, import.meta.url), 'utf8');
      const local = skill.path.split('/').slice(2).join('/');
      assert.equal(manifest.files[local].sha256, createHash('sha256').update(document).digest('hex'));
    }
    assert.ok(!JSON.stringify(profile.ontology).includes(`${other}:`));
    assert.ok(!JSON.stringify(profile.knowledge).includes(`${other}:`));
    assert.ok(profile.policyTemplates.every(rule => !rule.taskId && !rule.projectId && !rule.grantId && !rule.uses && !rule.decisions));
    assert.ok(profile.reportAnnotations.every(annotation => annotation.topicIds.every(topic => topic.startsWith(`${role.toLowerCase()}:`))));
    assert.ok(profile.reportAnnotations.every(annotation => annotation.recordType.startsWith(`${role.toLowerCase()}:`)));
    assert.ok(!JSON.stringify(profile).includes('provenance/transparency as related'));
  }
  assert.ok(researchConference().reports.every(report => !Object.hasOwn(report, 'topics')));
});

test('mutating one returned profile cannot contaminate the next audience or the other researcher', () => {
  for (const role of ['Alice', 'Bob']) {
    const original = researchProfile(role), modified = researchProfile(role);
    modified.calendar[0].status = 'Unexpected';
    modified.ontology.modules[0].concepts[0].definition = 'Changed';
    modified.materials[0].fields.summary = 'Changed';
    modified.reportAnnotations[0].topicIds.push('injected:topic');
    modified.policyTemplates[0].effect = 'deny';
    modified.skills[0].description = 'Changed';
    assert.deepEqual(researchProfile(role), original);
  }
});

test('seed loading fails on unreviewed data edits or a manifest path outside its own workspace', async t => {
  const { module, directory } = await isolatedRole(t, 'Alice');
  const calendar = path.join(directory, 'calendar.json');
  await writeFile(calendar, `${await readFile(calendar, 'utf8')}\n`);
  assert.throws(() => module.researchProfile('Alice'), { code: 'RESEARCH_WORKSPACE_MANIFEST' });
  const manifestFile = path.join(directory, 'manifest.json');
  const { hash: previous, ...manifest } = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.files['calendar.json'].sha256 = createHash('sha256').update(await readFile(calendar)).digest('hex');
  manifest.files['../bob/ontology.json'] = { sha256: '0'.repeat(64), description: 'Forbidden peer source' };
  await writeFile(manifestFile, JSON.stringify({ ...manifest, hash: hashPayload(manifest) }));
  assert.throws(() => module.researchProfile('Alice'), error => error.code === 'RESEARCH_WORKSPACE_MANIFEST' && /inside its own directory/.test(error.message));
});
