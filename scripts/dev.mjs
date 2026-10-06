// Startet Server (mit Watch) und Vite-Dev-Server parallel – ohne zusätzliche Abhängigkeiten.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = (...p) => path.join(root, 'node_modules', ...p);

const procs = [
  ['server', [bin('tsx', 'dist', 'cli.mjs'), 'watch', '--disable-warning=ExperimentalWarning', 'server/index.ts']],
  ['web', [bin('vite', 'bin', 'vite.js'), '--config', 'web/vite.config.ts']],
].map(([name, args]) => {
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const prefix = name === 'server' ? '\x1b[34m[server]\x1b[0m ' : '\x1b[32m[web]\x1b[0m    ';
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { out.write(prefix + buf.slice(0, i) + '\n'); buf = buf.slice(i + 1); }
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => { console.log(prefix + 'beendet (' + code + ')'); shutdown(); });
  return child;
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) { try { p.kill(); } catch { /* bereits beendet */ } }
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
