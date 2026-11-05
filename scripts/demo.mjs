import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoServer } from '../src/server.mjs';
import { loadDemoEnvironment } from '../src/demo-environment.mjs';
import { createHermesDemoClient } from '../src/hermes-demo-client.mjs';
import { createAgentCommDirect } from '../src/agent-comm-direct.mjs';
import { createKGClient } from '../src/kg-client.mjs';

// A separate event workspace keeps rehearsals away from existing research data.
const root = fileURLToPath(new URL('../', import.meta.url));
const useHermes = process.argv.includes('--hermes');
let app;
try {
  await loadDemoEnvironment({ root, migrate: !useHermes });
  const hermesOptions = useHermes ? {
    hermes: createHermesDemoClient({ endpoints: {
      alice: { url: process.env.DEMO_HERMES_ALICE_URL, apiKey: process.env.DEMO_HERMES_ALICE_KEY },
      bob: { url: process.env.DEMO_HERMES_BOB_URL, apiKey: process.env.DEMO_HERMES_BOB_KEY },
    } }),
    peerTransport: createAgentCommDirect({ command: process.env.DEMO_AGENT_COMM_DIRECT
      || path.join(root, 'bridge', 'agent-comm-direct', process.platform === 'win32' ? 'agent-comm-direct.exe' : 'agent-comm-direct') }),
  } : {};
  const workspace = useHermes ? 'demo-hermes' : 'demo';
  const useKnowledge = useHermes && Boolean(process.env.DEMO_KG_ALICE_URL || process.env.DEMO_KG_BOB_URL);
  const nativeInterfaces = useKnowledge ? Object.fromEntries(['Alice', 'Bob'].map(role => {
    const suffix = role.toUpperCase();
    const kgUrl = new URL(process.env['DEMO_KG_' + suffix + '_PUBLIC_URL'] || (role === 'Alice' ? 'http://127.0.0.1:8765/?view=graph' : 'http://127.0.0.1:8766/?view=graph'));
    kgUrl.hash = 'token=' + encodeURIComponent(process.env['DEMO_KG_' + suffix + '_TOKEN']);
    return [role, { kgUrl: kgUrl.href,
      hermesUrl: process.env['DEMO_HERMES_' + suffix + '_PUBLIC_URL'] || (role === 'Alice' ? 'http://127.0.0.1:9119/' : 'http://127.0.0.1:9121/') }];
  })) : undefined;
  const knowledge = useKnowledge ? createKGClient({ endpoints: Object.fromEntries(['Alice', 'Bob'].map(role => [role, {
    url: process.env['DEMO_KG_' + role.toUpperCase() + '_URL'], token: process.env['DEMO_KG_' + role.toUpperCase() + '_SERVICE_TOKEN']
  }])) }) : undefined;
  app = await createDemoServer({ host: '127.0.0.1', port: Number(process.env.DEMO_PORT || 4327),
    directory: path.join(root, '.data', workspace), openControls: true, ...hermesOptions, knowledge, nativeInterfaces,
    minimaxApiKey: '', environmentApiKey: useHermes ? '' : process.env.MINIMAX_TOKEN_PLAN_KEY ?? '' });
  const address = await app.listen();
  console.log(`Demo ready: http://127.0.0.1:${address.port}`);
  console.log(`Separate demo workspace: .data/${workspace} · Research controls are available without sign-in.`);
  console.log(useHermes ? 'Live uses two local Hermes profiles. Agent-comm connects the two local peers directly.'
    : app.models.view().keyConfigured ? 'Live uses the saved provider configuration.' : 'Controlled is ready. Configure MINIMAX_TOKEN_PLAN_KEY in .env for Live.');
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
