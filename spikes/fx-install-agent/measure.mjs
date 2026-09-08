/**
 * Measure what one built-in-install-agent onboarding actually costs.
 *
 * This exists to replace a guess with a number in the Vercel credits
 * conversation. It runs the real fx kernel with the real tool descriptors and
 * the real prompt, and reports tokens per completed run.
 *
 *   AI_GATEWAY_API_KEY=... node measure.mjs
 *   AI_GATEWAY_API_KEY=... node measure.mjs --runs 5 --model google/gemini-2.5-flash-lite
 *   AI_GATEWAY_API_KEY=... node measure.mjs --live      # actually install (use a VM!)
 *
 * Dry-run by default: the conversation is real, the installs are not. Token
 * counts are close to a live run because the agent still probes the machine
 * and still reasons about ordering — only the effects are stubbed.
 */

import { createFxAgent } from 'libfx';
import { buildTools, INSTALL_STEPS } from './tools.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const MODEL = flag('model', 'google/gemini-2.5-flash-lite');
const RUNS = Number(flag('runs', 1));
const LIVE = argv.includes('--live');
const WANTED = (flag('tools', 'homebrew,node,git,gh,claude-code')).split(',');

const apiKey = process.env.AI_GATEWAY_API_KEY;
if (!apiKey) {
  console.error('AI_GATEWAY_API_KEY is not set. Get one from the Vercel dashboard (AI Gateway).');
  process.exit(1);
}

const INSTRUCTIONS = `
You set up a developer machine for Ship Studio, before the user has any coding
agent installed. You are the reason they do not have to.

Rules:
- Check before you install. Never install something already present.
- Install in dependency order. Homebrew first on macOS; Node before anything
  installed with npm.
- You cannot run arbitrary commands. You choose a step id from the fixed list;
  the host owns the command.
- If a step fails, try its dependency once, then report blocked. Do not loop.
- Be brief. Nobody is reading your prose, a checklist is showing your progress.
- Call report_done exactly once, at the end.
`.trim();

function prompt(wanted) {
  const labels = wanted.map((id) => INSTALL_STEPS[id]?.label ?? id).join(', ');
  return `Set this machine up with: ${labels}. Check what is already there first.`;
}

async function runOnce(index) {
  const effects = [];
  const agent = await createFxAgent({
    apiKey,
    model: MODEL,
    instructions: INSTRUCTIONS,
    tools: buildTools({ dryRun: !LIVE, onEffect: (e) => effects.push(e) }),
  });

  const startedAt = Date.now();
  let text = '';
  try {
    const turn = agent.prompt(prompt(WANTED));
    for await (const event of turn) {
      if (event.type === 'text_delta') text += event.delta;
    }
    const result = await turn.result;
    return {
      run: index + 1,
      ok: true,
      elapsedMs: Date.now() - startedAt,
      stopReason: result.stopReason,
      inputTokens: result.usage?.input_tokens ?? result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.output_tokens ?? result.usage?.outputTokens ?? 0,
      toolCalls: effects.length,
      finalText: text.trim().slice(0, 400),
    };
  } finally {
    await agent.close();
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const results = [];
for (let i = 0; i < RUNS; i++) {
  process.stderr.write(`run ${i + 1}/${RUNS}${LIVE ? ' (LIVE)' : ' (dry)'}… `);
  try {
    const r = await runOnce(i);
    results.push(r);
    process.stderr.write(`${r.inputTokens} in / ${r.outputTokens} out, ${r.toolCalls} tools\n`);
  } catch (err) {
    process.stderr.write(`failed: ${err.message}\n`);
    results.push({ run: i + 1, ok: false, error: String(err.message ?? err) });
  }
}

const ok = results.filter((r) => r.ok);
const summary = {
  model: MODEL,
  mode: LIVE ? 'live' : 'dry-run',
  requested: WANTED,
  runs: RUNS,
  succeeded: ok.length,
  medianInputTokens: ok.length ? median(ok.map((r) => r.inputTokens)) : null,
  medianOutputTokens: ok.length ? median(ok.map((r) => r.outputTokens)) : null,
  medianToolCalls: ok.length ? median(ok.map((r) => r.toolCalls)) : null,
  medianElapsedMs: ok.length ? median(ok.map((r) => r.elapsedMs)) : null,
};

console.log(JSON.stringify({ summary, results }, null, 2));
