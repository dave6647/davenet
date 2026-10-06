#!/usr/bin/env node
// Simulierte Claude Code CLI für Adapter-Tests. Verhalten über "MODE:<x>" im Prompt (stdin).
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('9.9.9 (Claude Code)');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }));
  process.exit(0);
}
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const mode = (input.match(/MODE:(\w+)/) ?? [])[1] ?? 'success';
  if (mode === 'flag' && args.includes('--restricted')) {
    process.stderr.write("error: unknown option '--restricted'\n");
    process.exit(1);
  }
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const now = Math.floor(Date.now() / 1000);
  out({ type: 'system', subtype: 'init', apiKeySource: 'none', model: args[args.indexOf('--model') + 1] });
  const echo = {
    args,
    hasApiKey: !!process.env.ANTHROPIC_API_KEY,
    configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    maxOut: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? null,
    nested: !!process.env.CLAUDECODE,
  };
  if (mode === 'quota') {
    out({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: "You've hit your limit" }] } });
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: now + 3600, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt: now + 3600 }, seven_day: { utilization: 0.4, resetsAt: now + 86400 } } } });
    out({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 5pm", num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 0 } });
    return;
  }
  if (mode === 'auth') {
    out({ type: 'assistant', error: 'authentication_failed', message: { content: [] } });
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login', num_turns: 1 });
    return;
  }
  if (mode === 'crash') {
    process.stderr.write('Segmentation fault\n');
    process.exit(3);
  }
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'test' } }] } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fertig.' }] } });
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: now + 7200, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: now + 7200 } } } });
  const schema = args.includes('--json-schema');
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 3,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 5, output_tokens: 7 },
    modelUsage: {
      'claude-sonnet-5-5': { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 300, cacheCreationInputTokens: 50, webSearchRequests: 1, costUSD: 0.01 },
      'claude-haiku-4-5-20251001': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.0023 },
    },
    result: JSON.stringify(echo),
    ...(schema ? { structured_output: { ok: true, echo } } : {}),
  });
});
