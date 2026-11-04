import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { networkInterfaces } from 'node:os';

function forward(listenHost, listenPort, targetHost, targetPort) {
  return createServer({ allowHalfOpen: true }, client => {
    const target = createConnection({ host: targetHost, port: targetPort, allowHalfOpen: true });
    client.on('error', () => target.destroy());
    target.on('error', () => client.destroy());
    client.pipe(target).pipe(client);
  }).listen(listenPort, listenHost);
}

// The browser listener lives on the ingress interface, away from the role links.
// The demo and both gateway clients keep their numeric-loopback contracts.
const ingress = networkInterfaces().eth0?.find(entry => entry.family === 'IPv4')?.address;
if (!ingress) throw new Error('The Docker demo requires its dedicated eth0 ingress interface.');
const [aliceKey, bobKey] = await Promise.all(['alice', 'bob'].map(async role => {
  const key = (await readFile(`/run/demo-gateway-auth/${role}/key`, 'utf8')).trim();
  if (!/^[!-~]{16,512}$/.test(key)) throw new Error(`Invalid ${role} gateway key file.`);
  return key;
}));
if (aliceKey === bobKey) throw new Error('The Docker demo requires distinct gateway keys.');
const servers = [
  forward(ingress, 4328, '127.0.0.1', 4327),
  forward('127.0.0.1', 8643, 'hermes-alice', 8642),
  forward('127.0.0.1', 8644, 'hermes-bob', 8642),
];
await Promise.all(servers.map(server => once(server, 'listening')));

const demo = spawn(process.execPath, ['scripts/demo.mjs', '--hermes'], {
  stdio: 'inherit',
  env: { ...process.env, DEMO_HERMES_ALICE_KEY: aliceKey, DEMO_HERMES_BOB_KEY: bobKey },
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  for (const server of servers) server.close();
  demo.kill(signal);
});
const [code] = await once(demo, 'exit');
process.exit(code ?? (stopping ? 0 : 1));
