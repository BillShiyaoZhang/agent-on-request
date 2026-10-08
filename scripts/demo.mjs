import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoServer } from '../src/server.mjs';
import { loadDemoEnvironment } from '../src/demo-environment.mjs';

// A separate event workspace keeps rehearsals away from existing research data.
const root = fileURLToPath(new URL('../', import.meta.url));
let app;
try {
  await loadDemoEnvironment({ root });
  app = await createDemoServer({ host: '127.0.0.1', port: Number(process.env.DEMO_PORT || 4327),
    directory: path.join(root, '.data', 'demo'), openControls: true,
    minimaxApiKey: '', environmentApiKey: process.env.MINIMAX_TOKEN_PLAN_KEY ?? '' });
  const address = await app.listen();
  console.log(`Demo ready: http://127.0.0.1:${address.port}`);
  console.log('Separate demo workspace: .data/demo · All controls are available without sign-in.');
  console.log(app.models.view().keyConfigured ? 'Live uses the saved provider configuration.' : 'Controlled is ready. Configure MINIMAX_TOKEN_PLAN_KEY in .env for Live.');
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
