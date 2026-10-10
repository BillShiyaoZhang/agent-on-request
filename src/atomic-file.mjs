import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const WINDOWS_RENAME_DELAYS = Object.freeze([25, 50, 100, 200]);
const WINDOWS_TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Replace by rename only; the caller owns temporary-file creation and cleanup. */
export async function renameAtomicFile(source, destination, {
  platform = process.platform, renameOperation = rename, wait = delay,
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      await renameOperation(source, destination);
      return;
    } catch (error) {
      // Windows can temporarily refuse a replacement while a file handle is held.
      // Never unlink the destination or bypass permissions to force a replacement.
      if (platform !== 'win32' || !WINDOWS_TRANSIENT_CODES.has(error?.code)
        || attempt >= WINDOWS_RENAME_DELAYS.length) throw error;
      await wait(WINDOWS_RENAME_DELAYS[attempt]);
    }
  }
}
