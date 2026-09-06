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
   * Capture only this element. A scenario about a popover is reviewed on the
   * popover, not on 1400px of surrounding workspace that the harness cannot
   * make realistic anyway (no dev server, no real PTY).
   */
  clipSelector?: string;
  commands: CommandMap;
}
