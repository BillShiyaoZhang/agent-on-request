import path from 'node:path';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { renameAtomicFile } from './atomic-file.mjs';
import { requireThat } from './errors.mjs';

const roles = ['Alice', 'Bob'];
const seedDirectory = role => fileURLToPath(new URL(`../workspaces/${role.toLowerCase()}/`, import.meta.url));
export const experienceDirectory = (directory, id, role) => path.join(directory, 'runs', id, role.toLowerCase());

async function jsonFile(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await renameAtomicFile(temporary, filename);
  } finally { await rm(temporary, { force: true }); }
}

export async function initializeExperienceFiles(directory, workspace) {
  for (const role of roles) {
    const destination = experienceDirectory(directory, workspace.id, role);
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const seed = path.join(destination, 'seed'), manifest = workspace.seedManifests[role];
    requireThat(manifest.hash === workspace.profiles[role].seed?.hash, 'RESEARCH_WORKSPACE_MANIFEST',
      'The seed manifest changed while creating this audience. Review it and retry.', 503);
    await mkdir(seed, { recursive: true, mode: 0o700 });
    for (const [relative, record] of Object.entries(manifest.files)) {
      const bytes = await readFile(path.join(seedDirectory(role), relative));
      requireThat(createHash('sha256').update(bytes).digest('hex') === record.sha256,
        'RESEARCH_WORKSPACE_MANIFEST', 'A seed changed during initialization. Review it and retry.', 503);
      const file = path.join(seed, relative); await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    }
    await jsonFile(path.join(seed, 'manifest.json'), manifest);
  }
}

/** Readable owner-scoped runtime exports. The controller's private keys and
 * admission prompts stay in its protected database, outside these exports.
 */
export function experienceSnapshot(workspace) {
  return Object.fromEntries(roles.map(role => [role, {
    manifest: { experienceId: workspace.id, role, createdAt: workspace.createdAt, seed: workspace.profiles[role].seed,
      namespace: workspace.profiles[role].nativeWorkspace?.namespace ?? `${workspace.id}:${role.toLowerCase()}` },
    profile: workspace.profiles[role],
    inbox: workspace.messages.filter(message => message.to === role),
    outbox: workspace.messages.filter(message => message.from === role),
    artifacts: workspace.artifacts.filter(artifact => artifact.owner === role),
    tasks: workspace.tasks.filter(task => task.type !== 'research_work' || task.initiator === role).map(task => ({
      id: task.id, type: task.type, mode: task.mode, status: task.status, checkpoint: task.checkpoints[role] ?? null,
      ...(task.initiator === role ? { ownerGoal: task.ownerGoal } : {}),
      nativeRun: task.nativeRuns?.[role] ? { runId: task.nativeRuns[role].runId, sessionId: task.nativeRuns[role].sessionId,
        status: task.nativeRuns[role].status, startedAt: task.nativeRuns[role].startedAt } : null,
    })),
  }]));
}

export async function saveExperienceFiles(directory, id, snapshot) {
  for (const role of roles) {
    const destination = experienceDirectory(directory, id, role);
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const [name, data] of Object.entries(snapshot[role])) await jsonFile(path.join(destination, `${name}.json`), data);
  }
}
