/**
 * The command line an agent tab's PTY is spawned with.
 *
 * One builder for both ways a tab starts: a mounted `Terminal` (the user's own
 * tab) and a session started in the background for an agent or remote access
 * (`useRemoteAgentControl`), which spawns the PTY without mounting the
 * workspace. Both must launch exactly the same CLI — same PATH, same session
 * id, same auto-accept flag, same `--add-dir` libraries — or a session started
 * in the background would behave differently once the user opens it.
 *
 * Per-workspace credentials and config dirs are not here: `pty_session_open`
 * injects them server-side from the project's workspace, so secrets never
 * cross into the webview.
 *
 * @module lib/agentSpawn
 */

import { homeDir } from '@tauri-apps/api/path';
import { getShellPath, getSystemEnv } from './project';
import { isWindows, needsCmdExeWrapper, resolveCliPath, type ResolvedCli } from './setup';
import { attachedLibraryDirs } from './attached-libraries';
import { agentPromptArgs, type AgentConfig } from './agent';
import { logger } from './logger';

export interface AgentSpawnOptions {
  agent: AgentConfig;
  projectPath: string;
  /** The tab's session id; Claude Code is pinned to it so it can be resumed. */
  sessionName?: string;
  /** Resume `sessionName` rather than start it fresh (Claude Code). */
  resume?: boolean;
  autoAccept?: boolean;
  /** The opening prompt, delivered through argv (spawn, never paste). */
  initialPrompt?: string;
}

export interface AgentSpawn {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export async function buildAgentSpawn({
  agent,
  projectPath,
  sessionName,
  resume = false,
  autoAccept = false,
  initialPrompt,
}: AgentSpawnOptions): Promise<AgentSpawn> {
  // Get extended PATH from backend (includes nvm, Claude desktop app, etc.)
  const home = await homeDir();
  const isWin = isWindows();
  const sep = isWin ? '\\' : '/';
  const homeNormalized = home.endsWith(sep) ? home : `${home}${sep}`;
  const fullPath = await getShellPath();

  // Build platform-appropriate env vars
  // Must pass all essential env vars since env replaces (not merges with) parent environment
  let env: Record<string, string>;
  if (isWin) {
    // Windows: get system env vars from backend and merge with PATH
    const systemEnv = await getSystemEnv();
    env = {
      ...systemEnv,
      PATH: fullPath,
      TERM: 'xterm-256color',
    };
  } else {
    env = {
      PATH: fullPath,
      HOME: homeNormalized.slice(0, -1),
      USER: homeNormalized.split('/').filter(Boolean).pop() || 'user',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      SHELL: '/bin/zsh',
    };
  }

  // The PTY merges this env over the app's own, so npm/pnpm "invocation
  // directory" vars leak through when Ship Studio runs under `pnpm tauri
  // dev`. Tools the agent runs (e.g. `shopify theme dev`) trust INIT_CWD
  // over process.cwd() and resolve paths against the wrong directory —
  // pin both to where this terminal actually runs.
  env.INIT_CWD = projectPath;
  env.PNPM_SCRIPT_SRC_DIR = projectPath;

  const agentArgs: string[] = [];

  // Session persistence for Claude Code: assign a fixed session ID per tab
  // so we can resume the exact conversation when the project is reopened
  if (agent.id === 'claude-code' && sessionName) {
    agentArgs.push(resume ? '--resume' : '--session-id', sessionName);
  }

  if (autoAccept && agent.autoAcceptFlag) {
    agentArgs.push(agent.autoAcceptFlag);
  }

  // Attached libraries: ride the user's registered cross-project library
  // folders into this session via the agent's additional-directory flag
  // (Claude Code: `--add-dir`). Their skills load and files are readable,
  // but their CLAUDE.md is not loaded, so they can't override the project.
  // Only agents that expose such a flag opt in; the rest are a no-op.
  // Best-effort: a failure to read the registry must never block the
  // agent from starting, so we log and continue.
  if (agent.additionalDirFlag) {
    try {
      for (const dir of await attachedLibraryDirs()) {
        agentArgs.push(agent.additionalDirFlag, dir);
      }
    } catch (err) {
      logger.warn('[agentSpawn] Failed to load attached libraries', {
        agent: agent.id,
        error: String(err),
      });
    }
  }

  // The opening prompt goes last: every supported CLI takes it as a
  // trailing positional argument (opencode behind --prompt), and a flag
  // added after it would be read as part of the prompt.
  if (initialPrompt && initialPrompt.trim()) {
    agentArgs.push(...agentPromptArgs(agent.id, initialPrompt));
  }

  // Placeholder — on Windows the real spawn shape (direct vs. wrapped
  // in cmd.exe /C) is decided AFTER binary resolution below, because
  // the decision depends on what the command resolves to (.cmd shim vs.
  // real executable). See needsCmdExeWrapper in lib/setup.ts.
  let command = agent.binaryName;
  let args = agentArgs;

  // Resolve the bare binary name through the backend's thorough
  // discovery (every NVM version, ~/.<agent>/bin, npm prefix -g …) the
  // way OnboardingTerminal already does. The hand-built PATH above is a
  // subset of what the status checks search, so "installed ✓ but Unable
  // to spawn claude" was possible (issue #280). Resolution errors fail
  // OPEN — the spawn proceeds with the bare name as before.
  //
  // Guard: only bare names go to the resolver. The raw Terminal tab's
  // "binary" is an absolute path (/bin/zsh), which the backend rejects
  // with a validation error on every open (issue #303).
  const isBareName = !agent.binaryName.includes('/') && !agent.binaryName.includes('\\');
  let resolved: ResolvedCli | null | undefined;
  if (isBareName) {
    try {
      resolved = await resolveCliPath(agent.binaryName);
      if (resolved) {
        const pathSep = isWin ? ';' : ':';
        if (!env.PATH.split(pathSep).includes(resolved.dir)) {
          env.PATH = `${env.PATH}${pathSep}${resolved.dir}`;
        }
        // Spawn the resolved absolute path — deterministic, no PATH
        // shadowing. (Windows decides wrapper-vs-direct below.)
        if (!isWin) command = resolved.path;
      }
    } catch (err) {
      resolved = undefined;
      logger.warn('[agentSpawn] resolveCliPath failed — spawning bare name', {
        binary: agent.binaryName,
        error: String(err),
      });
    }
  }

  if (isWin) {
    // Windows spawn shape, same rule OnboardingTerminal already uses.
    // Only .cmd/.bat shims need `cmd.exe /C` — they are batch scripts.
    // Routing a REAL executable through cmd.exe adds a second parse
    // layer (portable_pty composes one command line, then cmd re-parses
    // it with its own quote rules) between us and the agent, which is
    // what split a single `--session-id`/`--add-dir` value into several
    // tokens and made Claude Code exit with "too many arguments"
    // (issue #797). Unresolved names still wrap — needsCmdExeWrapper's
    // conservative default — so nothing regresses when resolution
    // fails open.
    if (needsCmdExeWrapper(agent.binaryName, resolved?.path)) {
      command = 'cmd.exe';
      args = ['/C', agent.binaryName, ...agentArgs];
    } else {
      command = resolved?.path ?? agent.binaryName;
    }
  }

  return { command, args, env };
}
