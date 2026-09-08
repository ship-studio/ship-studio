/**
 * The built-in install agent — the thing that runs *before* the user has an
 * agent of their own.
 *
 * Ship Studio's whole position is that it works with the AI subscription you
 * already pay for. This agent is the exception that proves it: it exists only
 * to do the jobs that must happen before Claude Code / Codex / Cursor exist on
 * the machine, and it hands the wheel over the moment one does.
 *
 * The audience is someone who has never opened a terminal. Every design call
 * below follows from that.
 *
 * ## Why there is a driver seam
 *
 * The UI must be demoable, screenshottable and testable without a network
 * call, an API key or a real install — the same reason `SHIPSTUDIO_FORCE_SETUP`
 * exists. So the flow talks to an {@link InstallAgentDriver} and never to a
 * model directly:
 *
 * - {@link scriptedDriver} plays a believable session against the backend's
 *   mock state. No key, no network, deterministic. Drives the real UI.
 * - The fx driver (see `spikes/fx-install-agent/`) runs the real thing. It is
 *   not wired here yet: it needs an AI Gateway key, and the app should not
 *   grow a code path that silently no-ops without one.
 *
 * Both emit the same {@link InstallAgentEvent} stream, so the UI cannot tell
 * them apart and cannot drift between them.
 *
 * ## The agent never authors a command
 *
 * A driver may only run steps from {@link INSTALL_STEPS}. The real one picks a
 * step id from a fixed menu; the command is ours. That is not politeness — a
 * sponsored API key shipped inside an open-source desktop app is a public key,
 * and a public key that can drive arbitrary shell is a remote-code-execution
 * primitive. This one can only install the things onboarding was always going
 * to install.
 *
 * ## The human is part of the protocol
 *
 * Some steps cannot be automated and should never pretend to be: an admin
 * password, a browser sign-in, a licence someone has to accept. Those are not
 * failures and not edge cases — on a fresh machine they are guaranteed. So the
 * driver asks the host for them through {@link InstallAgentHost.requestUser}
 * and blocks until a human answers. The agent owns the machine; the host owns
 * the human. See {@link UserActionRequest} for why no password ever crosses
 * this boundary.
 *
 * @module lib/installAgent
 */

import { mockMarkSetupItemReady } from './agentOnboarding';
import { logger } from './logger';

// ============ The closed menu ============

/** Every install the built-in agent is permitted to perform. */
export const INSTALL_STEPS = {
  homebrew: { label: 'Homebrew', detail: 'Package manager', needsAdmin: true },
  node: { label: 'Node.js', detail: 'JavaScript runtime', requires: 'homebrew' },
  git: { label: 'Git', detail: 'Version control', requires: 'homebrew' },
  gh: { label: 'GitHub CLI', detail: 'GitHub from the terminal', requires: 'homebrew' },
  claude: { label: 'Claude Code', detail: "Anthropic's coding agent" },
  codex: { label: 'Codex', detail: "OpenAI's coding agent", requires: 'node' },
  cursor: { label: 'Cursor', detail: "Cursor's coding agent" },
  opencode: { label: 'Opencode', detail: 'Open-source coding agent', requires: 'node' },
} as const satisfies Record<
  string,
  { label: string; detail: string; requires?: string; needsAdmin?: boolean }
>;

export type InstallStepId = keyof typeof INSTALL_STEPS;

/** Setup items every machine needs, in dependency order. */
export const BASE_STEPS: InstallStepId[] = ['homebrew', 'node', 'git', 'gh'];

/** Human-readable label for a step, for UI that only has the id. */
export function stepLabel(step: InstallStepId): string {
  return INSTALL_STEPS[step].label;
}

// ============ Handing back to the human ============

/**
 * Something only a person can do. The host renders it; the driver waits.
 *
 * **No password ever crosses this boundary.** For `admin`, the host does not
 * collect a password and hand it to us — it asks the backend to run the step
 * through the OS's own authorization prompt, so the secret goes from the user
 * to macOS/Windows and never exists as a JavaScript string in our webview. The
 * result below is therefore only ever "they authorized it" or "they didn't".
 * Anything that would need us to hold the password is the wrong design.
 */
export type UserActionRequest =
  | {
      kind: 'admin';
      /** Plain language, no jargon: why the OS is about to ask for a password. */
      reason: string;
      step: InstallStepId;
    }
  | {
      kind: 'browser_auth';
      reason: string;
      /** What they're signing into, as they'd name it ("GitHub"). */
      service: string;
      /** One-time code to enter, when the service uses the device flow. */
      code?: string;
      /** Where we're sending them, shown so the destination is never a mystery. */
      url?: string;
    }
  | {
      kind: 'confirm';
      reason: string;
      /** Label for the affirmative button ("I've done it"). */
      confirmLabel: string;
    };

/** What the human decided. Deliberately carries no secret — see above. */
export type UserActionResult =
  | { ok: true }
  | { ok: false; reason: 'declined' | 'timed_out' | 'cancelled' };

/**
 * The half of the session the UI owns.
 *
 * Named `host` deliberately: it is the same split libfx draws when it says the
 * JavaScript host is the authority for tool effects. The driver decides what
 * needs to happen; the host decides what actually touches the user's machine
 * or the user's attention.
 */
export interface InstallAgentHost {
  /** Show a human-action request and resolve once they've dealt with it. */
  requestUser(request: UserActionRequest): Promise<UserActionResult>;
}

// ============ The event stream ============

/** One thing the agent did or said, as the UI sees it. */
export type InstallAgentEvent =
  /** A line of narration. The UI types it out; keep it to one sentence. */
  | { type: 'say'; text: string }
  /** Work started on a step. */
  | { type: 'step_start'; step: InstallStepId }
  /** Work finished. `ok: false` means it failed, not that it was skipped. */
  | { type: 'step_end'; step: InstallStepId; ok: boolean; detail?: string }
  /** Nothing to do — it was already on the machine. */
  | { type: 'step_skipped'; step: InstallStepId; version?: string }
  /** Waiting on the human. Emitted alongside the `requestUser` call so the UI
   *  can show the reason inline in the transcript as well as in the prompt. */
  | { type: 'awaiting_user'; request: UserActionRequest }
  /** The human answered (or didn't). */
  | { type: 'user_responded'; result: UserActionResult }
  /** The session ended. */
  | { type: 'done'; status: 'complete' | 'blocked'; summary: string };

/** What the flow asks a driver to accomplish. */
export interface InstallAgentRequest {
  /** Steps to get onto the machine, in the caller's preferred order. */
  steps: InstallStepId[];
  /** Steps already detected as present, so the agent can skip them out loud. */
  alreadyPresent: InstallStepId[];
}

/**
 * Who to credit while this driver is working.
 *
 * A property of the driver rather than a constant in the UI, because it is a
 * factual claim about what is running and who is paying for it. A screen that
 * says "powered by fx" while something else does the work is the same class of
 * mistake as showing a deployment URL nobody returned to us — so a driver that
 * is not fx-powered simply omits this and the credit does not render.
 */
export interface InstallAgentAttribution {
  /** The agent runtime doing the work. */
  poweredBy: string;
  /** Who funds the tokens it spends. Omitted when nobody does. */
  fundedBy?: string;
}

/**
 * Runs one install session and yields events as it goes.
 *
 * Async iterable rather than a callback so the UI can apply backpressure and
 * so cancellation is just breaking the loop — the same contract libfx's own
 * `agent.prompt()` turn uses, which keeps the real driver a thin adapter.
 */
export interface InstallAgentDriver {
  /** Rendered while this driver runs. See {@link InstallAgentAttribution}. */
  attribution?: InstallAgentAttribution;
  run(
    request: InstallAgentRequest,
    host: InstallAgentHost,
    signal?: AbortSignal
  ): AsyncIterable<InstallAgentEvent>;
}

// ============ Scripted driver ============

/** Beats between scripted events. Slow enough to read, fast enough to not annoy. */
const SCRIPT_BEAT_MS = 800;
const SCRIPT_INSTALL_MS = 2000;

/**
 * Multiplier on the scripted pauses. 1 is the pace a person reads at.
 *
 * The pauses exist so someone can follow along, which makes them a cost for
 * anything that isn't a person: the full sequence runs about twelve seconds,
 * longer than the harness waits for a step to appear, so every screen *after*
 * the install was uncapturable. A scenario that wants to reach one of those
 * sets this near zero and skips the performance; a scenario about the install
 * itself leaves it alone and gets the real pace.
 *
 * Read from storage rather than an argument because the driver is chosen by
 * the router, which has no idea what any given capture is trying to look at.
 */
const PACE_STORAGE_KEY = 'shipstudio.installAgentPace';

function paceFactor(): number {
  try {
    const raw = localStorage.getItem(PACE_STORAGE_KEY);
    if (!raw) return 1;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  } catch {
    // Private mode, blocked storage: the readable pace is the safe default.
    return 1;
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

/**
 * Plays a believable install session without touching the machine.
 *
 * It flips the backend's mock state as it goes (`mock_mark_setup_item_ready`)
 * so the app's own status checks tick green behind it — the checklist verifies
 * real backend state exactly as it will in production. The script is the
 * agent; the verification is never faked.
 *
 * It also exercises the human-action path, because a demo that skips the
 * password prompt is a demo of the easy half.
 */
export const scriptedDriver: InstallAgentDriver = {
  // The scripted driver stands in for fx in demos and captures, and only ever
  // runs behind SHIPSTUDIO_FORCE_SETUP — never in front of a real user. It
  // therefore carries fx's attribution so what we demo matches what we ship.
  // A driver that is genuinely not fx-powered must omit this.
  attribution: { poweredBy: 'fx', fundedBy: 'Vercel' },

  async *run({ steps, alreadyPresent }, host, signal) {
    const pace = paceFactor();
    const present = new Set(alreadyPresent);
    const todo = steps.filter((s) => !present.has(s));

    if (todo.length === 0) {
      yield { type: 'say', text: 'Everything I need is already here. Nice machine.' };
      yield { type: 'done', status: 'complete', summary: 'Nothing to install.' };
      return;
    }

    yield {
      type: 'say',
      text:
        present.size > 0
          ? `You've already got some of this. I'll fill in the rest.`
          : "Fresh machine — I'll set everything up. Takes a couple of minutes.",
    };
    await wait(SCRIPT_BEAT_MS * pace, signal);

    for (const step of steps) {
      if (present.has(step)) {
        yield { type: 'step_skipped', step };
        await wait((SCRIPT_BEAT_MS / 3) * pace, signal);
        continue;
      }

      const meta = INSTALL_STEPS[step];

      if ('needsAdmin' in meta && meta.needsAdmin) {
        const request: UserActionRequest = {
          kind: 'admin',
          step,
          reason: `${meta.label} installs into a folder that belongs to your Mac, so macOS will ask for your password. That prompt is your Mac's, not ours — we never see what you type.`,
        };
        yield { type: 'awaiting_user', request };
        const result = await host.requestUser(request);
        yield { type: 'user_responded', result };
        if (!result.ok) {
          yield {
            type: 'done',
            status: 'blocked',
            summary: `${meta.label} needs your permission to install.`,
          };
          return;
        }
      }

      yield { type: 'step_start', step };
      await wait(SCRIPT_INSTALL_MS * pace, signal);

      try {
        await mockMarkSetupItemReady(step);
      } catch (err) {
        // Mock-state flip is a demo affordance; a real driver has no such call.
        logger.debug('Install agent: mock flip failed', { step, error: err });
      }

      yield { type: 'step_end', step, ok: true };
      await wait((SCRIPT_BEAT_MS / 3) * pace, signal);
    }

    yield { type: 'say', text: "That's everything. Your machine is ready." };
    yield {
      type: 'done',
      status: 'complete',
      summary: `Installed ${todo.length} ${todo.length === 1 ? 'tool' : 'tools'}.`,
    };
  },
};
