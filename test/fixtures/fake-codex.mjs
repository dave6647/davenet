#!/usr/bin/env node
// Nachbildung der Codex CLI für Tests: `--version`, `login status` und `exec --json` mit Bildablage wie Codex
// ($CODEX_HOME/generated_images/<thread>/<call>.png). Verhalten über FAKE_CODEX_MODE steuerbar.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE || 'ok';
const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (process.env.FAKE_CODEX_LOG) {
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ args, cwd: process.cwd(), codex_home: process.env.CODEX_HOME ?? null, openai_key: process.env.OPENAI_API_KEY ?? null })}\n`);
}

if (args[0] === '--version') {
  console.log('codex-cli 0.160.1');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  if (mode === 'logged_out') {
    console.error('Not logged in');
    process.exit(1);
  }
  console.error('Logged in using ChatGPT');
  process.exit(0);
}
if (args[0] !== 'exec') {
  console.error(`error: unrecognized subcommand '${args[0]}'`);
  process.exit(2);
}
if (mode === 'old' && args.includes('--ignore-rules')) {
  console.error("error: unexpected argument '--ignore-rules' found");
  process.exit(2);
}

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  if (process.env.FAKE_CODEX_PROMPT) fs.writeFileSync(process.env.FAKE_CODEX_PROMPT, prompt);
  const thread = '019a5c1e-test-thread';
  out({ type: 'thread.started', thread_id: thread });
  out({ type: 'turn.started' });
  if (mode === 'limit') {
    out({ type: 'turn.failed', error: { message: "You've hit your usage limit for image generation. Try again in 2 hours 30 minutes." } });
    process.exit(1);
  }
  if (mode === 'noimage') {
    out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'FAILED: image generation failed: rejected by content policy' } });
  } else {
    const dir = mode === 'cwd' ? path.join(process.cwd(), 'generated_images') : path.join(home, 'generated_images', thread);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ig_0001.png'), PNG);
    out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'DONE' } });
  }
  out({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 40, reasoning_output_tokens: 10 } });
});
