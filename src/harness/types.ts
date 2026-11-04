/**
 * Harness scenario vocabulary.
 *
 * A scenario is a named set of command answers layered over `baseCommands`.
 * Values are either literal responses or functions of the invoke args, which
 * is what lets a scenario model a *changing* backend (a build that moves from
 * queued to ready over ten seconds) rather than only a frozen snapshot.
 */

export type CommandHandler = (args: Record<string, unknown>) => unknown;
/**
 * A literal response or a function of the invoke args. `unknown` already
 * subsumes the handler type, so the union is expressed as `unknown` with the
 * handler documented here and narrowed by `isHandler` at the call site.
 */
export type CommandMap = Record<string, unknown>;

/**
 * One interaction the harness performs before capturing.
 *
 * `fill` writes through React's own value setter and dispatches `input`, which
 * is what a controlled component listens for — assigning `el.value` directly
 * updates the DOM and leaves React's state (and therefore the disabled Save
 * button) untouched, which would photograph a state the app never has.
 */
export interface ScenarioStep {
  /** Click this once it exists. */
  click?: string;
  /** Point at this once it exists, e.g. to show its tooltip. */
  hover?: string;
  /** Type into this input once it exists. */
  fill?: string;
  /** Choose this value from a native select once it exists. */
  select?: string;
  /** The text `fill` types. */
  value?: string;
}

export interface Scenario {
  /** URL slug: `?scenario=<id>`. */
  id: string;
  /** One line shown in the harness switcher and in captured screenshots. */
  title: string;
  /**
   * What a reviewer is meant to check here. Written for a human or an agent
   * reading a screenshot, so a capture run can print it as the caption.
   */
  looksRightWhen: string;
  /**
   * Open straight into this project's workspace instead of the dashboard.
   * Saved a whole class of brittle "click the third card" capture steps.
   */
  project?: string;
  /**
   * CSS selector clicked once the app has settled, so a scenario about a
   * popover or a modal can be captured unattended. Declared here rather than
   * scripted in the capture runner, because the scenario is the thing that
   * knows which control it is about.
   */
  openSelector?: string;
  /**
   * Further interaction after `openSelector`, in order, once the app has
   * settled.
   *
   * `openSelector` reaches a popover in one click, which is as far as most
   * surfaces are. A connect flow is not one of them: its modal opens from a
   * button *inside* the popover, and its interesting states (a token typed but
   * not saved, a save in flight, a provider chosen and its projects loading)
   * exist only after two or three interactions. Without this the whole flow is
   * unreachable by the harness, which is how it ended up with no coverage at
   * all.
   *
   * Each step waits for its selector to appear before acting, so a step
   * depending on the previous one's render is not a race. A step whose
   * selector never appears is logged and recorded in `window.__harness.steps`
   * — and, because the states these reach are exactly the ones a `requires`
   * selector describes, a missed step shows up as a failed capture rather
   * than as a tidy screenshot of the wrong screen.
   */
  steps?: ScenarioStep[];

  /**
   * Capture only this element. A scenario about a popover is reviewed on the
   * popover, not on 1400px of surrounding workspace that the harness cannot
   * make realistic anyway (no dev server, no real PTY).
   */
  clipSelector?: string;
  /**
   * Capture at this window size instead of 1440×900, e.g. below the 750px
   * compact breakpoint. The capture runner emulates it before the app loads.
   */
  viewport?: { width: number; height: number };
  /**
   * `localStorage` seeded after the harness wipes storage. Use it for states
   * that only exist as a stored preference (onboarding mode, a dismissed
   * banner) rather than as backend data.
   */
  storage?: Record<string, string>;
  /**
   * A selector that must be present for this capture to mean anything.
   *
   * A scenario is a claim about a surface. When that surface stops rendering —
   * the feature is not on this branch, the component was renamed, a capture
   * attached to the wrong tree — the run still produces a clean screenshot of
   * *something*, captioned with this scenario's name, and nothing says the
   * subject is missing. A fixture written before or after its subject exists
   * has an expiry date, and this is what marks it.
   *
   * Missing means the capture failed, not that the screen is empty.
   */
  requires?: string;
  /**
   * A Cmd+K command run once the app has settled, to navigate to the surface
   * this scenario is about. Reuses the same plumbing as `?command=`; a
   * scenario that needs a panel or modal open should say so here rather than
   * relying on the app's default view happening to show it.
   */
  command?: string;
  /**
   * Deliver Tauri events between `emit` and `listen` (Tauri's own event
   * mocking). Off by default so other scenarios keep today's behaviour; a
   * fixture that streams backend events (dictation) turns it on and calls
   * `emit` from `@tauri-apps/api/event`.
   */
  mockEvents?: boolean;
  commands: CommandMap;
}
