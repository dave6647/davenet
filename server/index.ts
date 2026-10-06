import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { buildHttp } from './http/server.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };

const port = Number(process.env.DAVENET_PORT ?? 4310);
const host = process.env.DAVENET_HOST ?? '127.0.0.1';
const dataDir = path.resolve(process.env.DAVENET_DATA_DIR ?? path.join(root, 'data'));
const allowedHosts = (process.env.DAVENET_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

const app = createApp({ dataDir });
const http = await buildHttp(app, { webDir: path.join(root, 'web', 'dist'), allowedHosts, version: pkg.version });

await http.listen({ port, host });
const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
console.log(`Davenet ${pkg.version} läuft auf http://${shown}:${port}`);
console.log(`Daten: ${dataDir}`);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`\n${signal} – Davenet wird beendet (laufende Jobs werden beim nächsten Start fortgesetzt) …`);
  await http.close();
  await app.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
