import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createDemoServer } from '../src/server.mjs';

// A separate event workspace keeps rehearsals away from existing research data.
const root = fileURLToPath(new URL('../', import.meta.url));
const adminPin = process.env.AGENT_DEMO_ADMIN_PIN || randomBytes(5).toString('hex');
let app;
try {
  app = await createDemoServer({ host: '127.0.0.1', port: Number(process.env.DEMO_PORT || 4327),
    directory: path.join(root, '.data', 'demo'), adminPin, minimaxApiKey: '' });
  const address = await app.listen();
  console.log(`Demo ready: http://127.0.0.1:${address.port}`);
  console.log(`Researcher PIN: ${adminPin}`);
  console.log('Separate demo workspace: .data/demo · Controlled is ready; Live needs a configured key.');
} catch (error) {
  await app?.close();
  console.error(error.code === 'EADDRINUSE' ? 'This demo port is already in use. Open the running demo, or set DEMO_PORT to another port.' : error.message);
  process.exitCode = 1;
}
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (closing) return; closing = true;
  await app?.close(); process.exit(0);
});
