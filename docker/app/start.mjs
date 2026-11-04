import { spawn } from 'node:child_process';
import { once } from 'node:events';
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
const servers = [
  forward(ingress, 4328, '127.0.0.1', 4327),
  forward('127.0.0.1', 8643, 'hermes-alice', 8642),
  forward('127.0.0.1', 8644, 'hermes-bob', 8642),
];
await Promise.all(servers.map(server => once(server, 'listening')));

const demo = spawn(process.execPath, ['scripts/demo.mjs', '--hermes'], { stdio: 'inherit' });
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  for (const server of servers) server.close();
  demo.kill(signal);
});
const [code] = await once(demo, 'exit');
process.exit(code ?? (stopping ? 0 : 1));
