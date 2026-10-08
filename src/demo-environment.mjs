import path from 'node:path';
import { constants } from 'node:fs';
import { chmod, lstat, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { AppError, requireThat } from './errors.mjs';

const storageError = () => new AppError('DEMO_ENVIRONMENT', 'The local demo environment could not be loaded or saved.');
async function readOptional(filename) {
  let handle;
  try {
    const metadata = await lstat(filename);
    requireThat(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 1024 * 1024, 'DEMO_ENVIRONMENT', 'The local demo environment must use regular files no larger than 1 MiB.');
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    return await handle.readFile('utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw storageError(); }
  finally { await handle?.close(); }
}
async function writePrivate(filename, text) {
  const temporary = filename + '.' + randomUUID() + '.tmp';
  let handle;
  try {
    const directory = await lstat(path.dirname(filename));
    requireThat(directory.isDirectory() && !directory.isSymbolicLink(), 'DEMO_ENVIRONMENT', 'The local demo environment must use a real directory.');
    await readOptional(filename);
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(text, 'utf8'); await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, filename); await chmod(filename, 0o600);
  } catch { throw storageError(); }
  finally { await handle?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw storageError(); }); }
}
function quoteKey(key) {
  requireThat(typeof key === 'string' && key.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(key), 'DEMO_ENVIRONMENT', 'The local MiniMax key has an invalid format.');
  const quote = key.includes("'") ? '"' : "'";
  requireThat(!key.includes(quote), 'DEMO_ENVIRONMENT', 'The local MiniMax key could not be saved in environment format.');
  return quote + key + quote;
}

/** Loads local settings without returning or logging their values. */
export async function loadDemoEnvironment({ root, environment = process.env, migrate = true } = {}) {
  requireThat(typeof root === 'string' && root, 'DEMO_ENVIRONMENT', 'A project directory is required for the local demo environment.');
  root = path.resolve(root);
  const filename = path.join(root, '.env');
  const modelFilename = path.join(root, '.data', 'demo', 'models.json');
  let text = await readOptional(filename) ?? '';
  let values;
  try { values = parseEnv(text); } catch { throw storageError(); }
  let migrated = false;
  if (migrate) {
    const modelText = await readOptional(modelFilename);
    if (modelText) {
      let saved;
      try { saved = JSON.parse(modelText); } catch { throw storageError(); }
      // A China subscription key is never inferred for a different provider.
      const official = saved?.config?.provider === 'minimax_cn_token_plan' && saved?.config?.baseUrl?.replace(/\/+$/, '') === 'https://api.minimax.cn/v1';
      if (official && typeof saved.apiKey === 'string' && saved.apiKey) {
        requireThat(saved.schemaVersion === 1 && Number.isSafeInteger(saved.revision) && saved.revision >= 1 && saved.apiKey.startsWith('sk-cp') && saved.apiKey.length >= 16, 'DEMO_ENVIRONMENT', 'The saved MiniMax credential metadata is invalid.');
        if (!values.MINIMAX_TOKEN_PLAN_KEY) {
          // Preserve comments and other local settings; replace only this assignment.
          text = text.replace(/^\s*(?:export\s+)?MINIMAX_TOKEN_PLAN_KEY\s*=.*(?:\r?\n|$)/gm, '');
          text = text.replace(/\s*$/, '') + (text.trim() ? '\n' : '') + 'MINIMAX_TOKEN_PLAN_KEY=' + quoteKey(saved.apiKey) + '\n';
          await writePrivate(filename, text); values = parseEnv(text);
        }
        const metadata = { ...saved, keySource: 'environment' }; delete metadata.apiKey;
        await writePrivate(modelFilename, JSON.stringify(metadata) + '\n');
        migrated = true;
      }
    }
  }
  for (const [name, value] of Object.entries(values)) if (environment[name] === undefined) environment[name] = value;
  return { file: '.env', migrated, keyConfigured: Boolean(environment.MINIMAX_TOKEN_PLAN_KEY) };
}
