import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 20_000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || stderr || (err ? String(err) : '')).trim() });
    });
  });
}

/**
 * Versioniert den Projekt-Workspace nach jeder umgesetzten Task (Konzept §16 "Artifact Storage / Git",
 * Approval-Level 1: autonom mit Nachvollziehbarkeit). Ohne installiertes Git wird still übersprungen.
 */
export async function commitWorkspace(dir: string, message: string): Promise<string | null> {
  if (!fs.existsSync(dir)) return null;
  if (!fs.existsSync(path.join(dir, '.git'))) {
    const init = await git(dir, ['init', '-q']);
    if (!init.ok) return null;
  }
  await git(dir, ['add', '-A']);
  const commit = await git(dir, ['-c', 'user.name=Davenet', '-c', 'user.email=davenet@localhost', 'commit', '-q', '--no-verify', '-m', message]);
  if (!commit.ok) return null;
  const head = await git(dir, ['rev-parse', '--short', 'HEAD']);
  return head.ok ? head.out : null;
}
