import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalStringify, DEFAULT_BOB_CONFIG, hashValue } from './config.mjs';
import { AppError, requireThat } from './errors.mjs';
import { resolveConditions } from './condition-service.mjs';

const MAX_BUNDLES = 100;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const BUNDLE_KEYS = ['id', 'name', 'revision', 'hash', 'conditions', 'createdAt'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Stored fixtures already passed resolveConditions. The accumulated collection
// can legitimately exceed the per-fixture JSON node budget.
const clone = value => structuredClone(value);
const stringify = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

function validName(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value)
    && !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]{12,}|\bsk-[A-Za-z0-9_-]{16,}/.test(value);
}
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fileError(message = 'The saved condition bundle file or directory is invalid.') { return new AppError('CONDITION_FILE', message, 500); }

/** Researcher-owned reusable fixtures. Nothing is persisted until save is explicitly called. */
export class ConditionStore {
  constructor({ directory, persist = true } = {}) {
    requireThat(!persist || (typeof directory === 'string' && directory.length > 0), 'CONDITION_DIRECTORY', 'A condition bundle directory is required.', 500);
    this.directory = directory ? path.resolve(directory) : null;
    this.filename = this.directory ? path.join(this.directory, 'conditions.json') : null;
    this.persist = persist;
    this.bundles = new Map();
    this.queue = Promise.resolve();
  }

  async assertDirectory(directory = this.directory) {
    // lstat every ancestor instead of realpath: Windows sandbox hosts can allow
    // file access while refusing the native realpath operation.
    let current = directory;
    while (true) {
      const stat = await lstat(current);
      requireThat(stat.isDirectory() && !stat.isSymbolicLink(), 'CONDITION_FILE', 'Condition bundles require a real directory without symbolic links.', 500);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  async ensureDirectory() {
    // Verify the nearest existing ancestor before mkdir can follow a junction.
    let ancestor = this.directory;
    while (true) {
      try { await this.assertDirectory(ancestor); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw fileError();
      ancestor = parent;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.assertDirectory();
  }

  async assertFile() {
    try {
      const stat = await lstat(this.filename);
      requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_FILE_BYTES, 'CONDITION_FILE', 'Condition bundles require a regular file within the size limit.', 500);
      return stat;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async init() {
    if (!this.persist) return this;
    try { await this.assertDirectory(); }
    catch (error) { if (error.code === 'ENOENT') return this; throw error; }
    const expected = await this.assertFile();
    if (!expected) return this;
    let handle;
    try {
      handle = await open(this.filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      requireThat(stat.isFile() && stat.size <= MAX_FILE_BYTES && stat.ino === expected.ino && stat.dev === expected.dev, 'CONDITION_FILE', 'The condition bundle file changed while opening.', 500);
      const saved = JSON.parse(await handle.readFile('utf8'));
      if (!plainObject(saved) || Object.keys(saved).some(key => !['schemaVersion', 'bundles'].includes(key)) || saved.schemaVersion !== 1 || !Array.isArray(saved.bundles) || saved.bundles.length > MAX_BUNDLES) throw fileError();
      const bundles = new Map(), names = new Set();
      for (const entry of saved.bundles) {
        if (!plainObject(entry) || Object.keys(entry).length !== BUNDLE_KEYS.length || Object.keys(entry).some(key => !BUNDLE_KEYS.includes(key)) || !UUID.test(entry.id) || !validName(entry.name) || entry.name !== entry.name.trim() || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || typeof entry.hash !== 'string' || !/^[0-9a-f]{64}$/.test(entry.hash) || typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt)) || bundles.has(entry.id) || names.has(entry.name)) throw fileError();
        // Historical owner capability labels remain inert fixture metadata when
        // restoring. Session creation still resolves against the current owner.
        const template = clone(DEFAULT_BOB_CONFIG);
        if (Array.isArray(entry.conditions?.agents?.Bob?.skills)) template.tools.capabilities = clone(entry.conditions.agents.Bob.skills);
        const conditions = resolveConditions(entry.conditions, template);
        if (hashValue(conditions) !== entry.hash || canonicalStringify(conditions) !== canonicalStringify(entry.conditions)) throw fileError('The saved condition bundle hash or normalized fixture is invalid.');
        bundles.set(entry.id, clone({ ...entry, conditions }));
        names.add(entry.name);
      }
      this.bundles = bundles;
    } catch (error) {
      if (error instanceof AppError && error.code === 'CONDITION_FILE') throw error;
      throw fileError('The saved condition bundle file failed validation.');
    } finally { await handle?.close(); }
    return this;
  }

  list() { return clone([...this.bundles.values()]); }

  async persistSnapshot(bundles) {
    if (!this.persist) return;
    const serialized = stringify({ schemaVersion: 1, bundles: [...bundles.values()] });
    requireThat(Buffer.byteLength(serialized, 'utf8') <= MAX_FILE_BYTES, 'CONDITION_LIMIT', 'Saved condition bundles exceed the file size limit.', 422);
    await this.ensureDirectory();
    await this.assertFile();
    const temporary = path.join(this.directory, `.conditions-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(serialized);
      await handle.sync();
      await handle.close(); handle = null;
      await this.assertDirectory();
      await this.assertFile();
      await rename(temporary, this.filename);
    } finally {
      await handle?.close();
      try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  mutate(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async save(request, bobTemplate = DEFAULT_BOB_CONFIG) {
    try { canonicalStringify(request); }
    catch { throw new AppError('CONDITION_BUNDLE', 'Bundle requests must be plain JSON without unsafe keys or accessors.', 422); }
    requireThat(plainObject(request) && Object.keys(request).every(key => ['name', 'input', 'expectedRevision'].includes(key)) && Object.hasOwn(request, 'input'), 'CONDITION_BUNDLE', 'Provide only name, input and an optional expectedRevision.', 422);
    requireThat(validName(request.name), 'CONDITION_NAME', 'Bundle names need 1–80 characters without credentials or control characters.', 422);
    const name = request.name.trim();
    if (Object.hasOwn(request, 'expectedRevision')) requireThat(Number.isSafeInteger(request.expectedRevision) && request.expectedRevision >= 0, 'CONDITION_REVISION', 'expectedRevision must be a nonnegative integer.', 422);
    const conditions = resolveConditions(request.input, bobTemplate);
    const hash = hashValue(conditions);
    return this.mutate(async () => {
      const existing = [...this.bundles.values()].find(bundle => bundle.name === name);
      requireThat(existing ? request.expectedRevision === existing.revision : request.expectedRevision === undefined || request.expectedRevision === 0, 'STALE_CONDITION_BUNDLE', 'The bundle changed. Reload its current revision before saving.', 409);
      requireThat(existing || this.bundles.size < MAX_BUNDLES, 'CONDITION_LIMIT', `At most ${MAX_BUNDLES} saved bundles are allowed.`, 422);
      const bundle = { id: existing?.id ?? randomUUID(), name, revision: (existing?.revision ?? 0) + 1, hash, conditions, createdAt: existing?.createdAt ?? new Date().toISOString() };
      const next = new Map(this.bundles); next.set(bundle.id, clone(bundle));
      await this.persistSnapshot(next);
      this.bundles = next;
      return clone(bundle);
    });
  }

  async delete(id, expectedRevision) {
    requireThat(typeof id === 'string' && UUID.test(id), 'CONDITION_ID', 'A valid bundle ID is required.', 422);
    requireThat(Number.isSafeInteger(expectedRevision) && expectedRevision > 0, 'CONDITION_REVISION', 'Deleting a bundle requires its current expectedRevision.', 422);
    return this.mutate(async () => {
      const bundle = this.bundles.get(id);
      requireThat(bundle, 'CONDITION_NOT_FOUND', 'The saved condition bundle does not exist.', 404);
      requireThat(expectedRevision === bundle.revision, 'STALE_CONDITION_BUNDLE', 'The bundle changed. Reload its current revision before deleting.', 409);
      const next = new Map(this.bundles); next.delete(id);
      await this.persistSnapshot(next);
      this.bundles = next;
      return { id, deleted: true, revision: bundle.revision };
    });
  }
}
