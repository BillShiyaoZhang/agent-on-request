import { mkdir, readFile, writeFile, lstat, unlink } from 'node:fs/promises';
import { renameAtomicFile } from './atomic-file.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { clone, DEFAULT_BOB_CONFIG, validateConfig, hashValue } from './config.mjs';
import { requireThat } from './errors.mjs';

export class ProfileStore {
  constructor({ directory, persist = true } = {}) {
    this.directory = directory;
    this.persist = persist;
    this.template = clone(DEFAULT_BOB_CONFIG);
    this.templateRevision = 1;
    this.revision = 1;
    this.profiles = new Map([['Conference baseline', clone(DEFAULT_BOB_CONFIG)]]);
    this.versions = [{ revision: 1, hash: hashValue(this.template), target: 'template', createdAt: new Date().toISOString(), config: clone(this.template) }];
    this.queue = Promise.resolve();
  }
  async init() {
    if (!this.persist) return this;
    try {
      const filename = path.join(this.directory, 'config.json');
      const stat = await lstat(filename);
      requireThat(stat.isFile() && !stat.isSymbolicLink(), 'CONFIG_FILE', '配置文件必须为普通文件。');
      const saved = JSON.parse(await readFile(filename, 'utf8'));
      requireThat(validateConfig(saved.template).valid && Number.isSafeInteger(saved.revision) && saved.revision >= saved.templateRevision && saved.templateRevision > 0, 'CONFIG_FILE', '已保存的配置无效。');
      this.template = clone(saved.template);
      this.templateRevision = saved.templateRevision;
      this.revision = saved.revision;
      this.versions = (saved.versions ?? [{ revision: this.templateRevision, hash: hashValue(this.template), target: 'template', createdAt: new Date().toISOString(), config: this.template }]).filter(item => validateConfig(item.config).valid && item.hash === hashValue(item.config) && Number.isSafeInteger(item.revision) && item.revision > 0 && item.revision <= this.revision).map(clone);
      for (const profile of saved.profiles ?? []) if (validateConfig(profile.config).valid && typeof profile.name === 'string') this.profiles.set(profile.name, clone(profile.config));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this;
  }
  list() { return [...this.profiles].map(([name, config]) => ({ name, config: clone(config) })); }
  listVersions() { return clone(this.versions); }
  async mutate(operation) {
    const result = this.queue.then(async () => {
      const snapshot = { template: clone(this.template), templateRevision: this.templateRevision, revision: this.revision, profiles: new Map(this.profiles), versions: clone(this.versions) };
      try { const output = operation(); await this.save(); return output; }
      catch (error) { Object.assign(this, snapshot); throw error; }
    });
    this.queue = result.catch(() => {});
    return result;
  }
  // The rename dependency is injectable by local tests, never from an HTTP request.
  async save({ renameFile = renameAtomicFile } = {}) {
    if (!this.persist) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    requireThat(stat.isDirectory() && !stat.isSymbolicLink(), 'CONFIG_FILE', '配置目录无效。');
    const filename = path.join(this.directory, 'config.json');
    const temporary = path.join(this.directory, `.config-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ template: this.template, templateRevision: this.templateRevision, revision: this.revision, profiles: this.list(), versions: this.versions }), { flag: 'wx', mode: 0o600 });
      await renameFile(temporary, filename);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  archive(config, target) {
    const revision = ++this.revision;
    this.versions.push({ revision, hash: hashValue(config), target, createdAt: new Date().toISOString(), config: clone(config) });
    return revision;
  }
  async nextRevision(config) { return this.mutate(() => this.archive(config, 'session')); }
  async applyTemplate(config, expectedRevision) {
    return this.mutate(() => {
      requireThat(expectedRevision === this.templateRevision, 'STALE_CONFIG', '预设已更新，请重新查看差异。', 409);
      this.template = clone(config);
      this.templateRevision = this.archive(config, 'template');
      return this.templateRevision;
    });
  }
  async saveProfile(name, config) {
    requireThat(typeof name === 'string' && name.trim().length > 0 && name.length <= 80 && !/[\u0000-\u001f]/.test(name), 'PROFILE_NAME', '预设名称需要 1–80 个字符。');
    return this.mutate(() => this.profiles.set(name.trim(), clone(config)) && this.list());
  }
}
