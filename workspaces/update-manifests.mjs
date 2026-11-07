import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPayload } from '../src/runtime-helpers.mjs';

const root = fileURLToPath(new URL('./', import.meta.url));
const names = process.argv.slice(2);
if (names.some(name => !['alice', 'bob'].includes(name))) throw new Error('Usage: node workspaces/update-manifests.mjs [alice] [bob]');
for (const name of names.length ? [...new Set(names)] : ['alice', 'bob']) {
  const directory = path.join(root, name), manifestFile = path.join(directory, 'manifest.json');
  const { hash: previousHash, ...manifest } = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.role.toLowerCase() !== name) throw new Error('Workspace identity differs from its directory.');
  const files = {};
  function collect(relative = '') {
    for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'manifest.json' || entry.name.startsWith('.')) continue;
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Seed workspaces must not contain symbolic links: ${file}`);
      if (entry.isDirectory()) collect(file);
      else if (entry.isFile()) {
        if (!/\.(json|md)$/.test(file)) throw new Error(`Unexpected runtime file in seed workspace: ${file}`);
        files[file] = { sha256: createHash('sha256').update(readFileSync(path.join(directory, file))).digest('hex'),
          description: manifest.files[file]?.description ?? 'Reviewed workspace seed file.' };
      }
    }
  }
  collect();
  for (const file of Object.values(manifest.profile)) if (!files[file]) throw new Error(`Missing profile source: ${file}`);
  manifest.files = files;
  const updated = { ...manifest, hash: hashPayload(manifest) }, temporary = path.join(directory, '.manifest.tmp');
  writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`);
  renameSync(temporary, manifestFile);
  process.stdout.write(`${manifest.role}: ${updated.hash}\n`);
}
