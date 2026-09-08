/**
 * The install agent's whole world.
 *
 * Deliberately a CLOSED WHITELIST. The agent never authors a shell command; it
 * picks a step by id from a fixed menu and we run the command we wrote. Three
 * reasons this shape and not "run arbitrary bash":
 *
 *   1. We would be shipping a sponsored API key inside an open-source desktop
 *      app. A key that can drive arbitrary shell on a user's machine is a
 *      remote-code-execution primitive with a public key attached. This one
 *      can only install the things onboarding was always going to install.
 *   2. Cost. A closed menu keeps turns short and the context tiny, which is
 *      the whole argument for the credits ask being cents per user.
 *   3. In the real app these map 1:1 onto Rust commands we already have, so
 *      the agent inherits our permission model rather than a CLI's.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Every install this agent is permitted to perform, keyed by step id. */
export const INSTALL_STEPS = {
  homebrew: {
    label: 'Homebrew',
    probe: ['brew', ['--version']],
    command: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
  },
  node: {
    label: 'Node.js',
    probe: ['node', ['--version']],
    command: 'brew install node',
    requires: 'homebrew',
  },
  git: {
    label: 'Git',
    probe: ['git', ['--version']],
    command: 'brew install git',
    requires: 'homebrew',
  },
  gh: {
    label: 'GitHub CLI',
    probe: ['gh', ['--version']],
    command: 'brew install gh',
    requires: 'homebrew',
  },
  'claude-code': {
    label: 'Claude Code',
    probe: ['claude', ['--version']],
    command: 'curl -fsSL https://claude.ai/install.sh | bash',
  },
  codex: {
    label: 'Codex',
    probe: ['codex', ['--version']],
    command: 'npm install -g @openai/codex',
    requires: 'node',
  },
  opencode: {
    label: 'Opencode',
    probe: ['opencode', ['--version']],
    command: 'npm install -g opencode-ai',
    requires: 'node',
  },
};

/**
 * Is a step already satisfied? Runs the probe binary; absence is not failure.
 * In the app this is `get_full_setup_status`, which is the authority — the
 * agent's own claim that it installed something is never trusted.
 */
export async function probe(stepId) {
  const step = INSTALL_STEPS[stepId];
  if (!step) return { installed: false, error: `unknown step: ${stepId}` };
  const [bin, args] = step.probe;
  try {
    const { stdout } = await exec(bin, args, { timeout: 10_000 });
    return { installed: true, version: stdout.trim().split('\n')[0] };
  } catch {
    return { installed: false };
  }
}

/**
 * The tool descriptors handed to fx. `execute` is ours, which is the point of
 * the libfx design: "The JavaScript host is the authority for tool effects."
 *
 * `dryRun` measures the conversation without touching the machine — that is
 * how we get a token number on a dev box instead of only in a fresh VM.
 */
export function buildTools({ dryRun = true, onEffect = () => {} } = {}) {
  return [
    {
      name: 'check_installed',
      description:
        'Check whether one tool is already present on this machine. Returns its version if so. ' +
        'Always check before installing.',
      inputSchema: {
        type: 'object',
        properties: {
          step: { type: 'string', enum: Object.keys(INSTALL_STEPS) },
        },
        required: ['step'],
      },
      async execute(input) {
        onEffect({ tool: 'check_installed', input });
        return probe(input.step);
      },
    },
    {
      name: 'install',
      description:
        'Install one tool from the supported list. Only these tools can be installed and the ' +
        'command is fixed by the host — you choose which step to run, not how. ' +
        'Some steps require another step first (see `requires` in the result if it fails).',
      inputSchema: {
        type: 'object',
        properties: {
          step: { type: 'string', enum: Object.keys(INSTALL_STEPS) },
        },
        required: ['step'],
      },
      async execute(input) {
        const step = INSTALL_STEPS[input.step];
        if (!step) return { ok: false, error: `unknown step: ${input.step}` };
        onEffect({ tool: 'install', input });

        if (step.requires) {
          const dep = await probe(step.requires);
          if (!dep.installed) {
            return { ok: false, error: `${step.requires} must be installed first` };
          }
        }
        if (dryRun) {
          return { ok: true, dryRun: true, wouldRun: step.command };
        }
        try {
          await exec('/bin/bash', ['-lc', step.command], { timeout: 15 * 60_000 });
          const after = await probe(input.step);
          return { ok: after.installed, ...after };
        } catch (err) {
          return { ok: false, error: String(err.message ?? err).slice(0, 500) };
        }
      },
    },
    {
      name: 'report_done',
      description:
        'Call once when every requested tool is confirmed installed, or when you are blocked ' +
        'and cannot continue. This ends the session.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['complete', 'blocked'] },
          summary: { type: 'string' },
        },
        required: ['status', 'summary'],
      },
      async execute(input) {
        onEffect({ tool: 'report_done', input });
        return { acknowledged: true };
      },
    },
  ];
}
