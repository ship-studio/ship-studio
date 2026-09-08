/**
 * Conversational onboarding: one question at a time, and an agent that does
 * the work between the questions.
 *
 * The flow the user sees:
 *
 *   which agent? → (agent installs everything) → sign in → GitHub → host → done
 *
 * The point of the shape is that the *first* thing we ask is the only thing a
 * new user has an opinion about. Everything downstream — Homebrew, Node, Git,
 * the GitHub CLI — is machinery they never asked for and shouldn't have to
 * learn, so it happens behind one screen that reports progress in English.
 *
 * ## Why this doesn't run on a real machine yet
 *
 * The install work comes from an {@link InstallAgentDriver}, and the only
 * driver that exists is the scripted one. So the router hands this flow a
 * driver only in mock mode and keeps the existing agent-led screen for real
 * machines. That is deliberate: a beautiful flow that silently fails to
 * install anything is worse than the plainer flow that works. The real driver
 * (fx, see `spikes/fx-install-agent/`) needs an AI Gateway key.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CelebrationScreen } from '../CelebrationScreen';
import { FlowScreen } from './FlowScreen';
import { FlowChoice, FlowOption } from './FlowChoice';
import { FlowInstalling } from './FlowInstalling';
import { UserActionPrompt } from './UserActionPrompt';
import { InstallAttribution } from './InstallAttribution';
import { Button } from '../../primitives/Button';
import { Spinner } from '../../primitives/Spinner';
import { useInstallAgentSession } from '../../../hooks/useInstallAgentSession';
import { baseSteps, InstallAgentDriver, InstallStepId, stepLabel } from '../../../lib/installAgent';
import { SetupItem, getFullSetupStatus, setDefaultAgentId } from '../../../lib/setup';
import { setDefaultHost, setExternalAgentOptIn, HostChoice } from '../../../lib/agentOnboarding';
import {
  ClaudeIcon,
  CodexIcon,
  CursorIcon,
  OpencodeIcon,
  GitHubIcon,
  VercelIcon,
  CloudflareIcon,
} from '@/components/icons';
import { trackEvent } from '../../../lib/analytics';
import { logger } from '../../../lib/logger';

type AgentChoice = 'claude' | 'codex' | 'cursor' | 'opencode' | 'other';
type Step = 'loading' | 'agent' | 'host' | 'waiting' | 'signin' | 'github' | 'complete';

/** Progress for the hairline bar. Terminal screens omit it entirely. */
const PROGRESS: Partial<Record<Step, number>> = {
  agent: 0.15,
  host: 0.4,
  waiting: 0.6,
  signin: 0.75,
  github: 0.9,
};

const AGENT_OPTIONS: FlowOption<AgentChoice>[] = [
  {
    value: 'claude',
    label: 'Claude Code',
    description: "Anthropic's agent. The one most Ship Studio users pick.",
    icon: <ClaudeIcon size={22} />,
  },
  {
    value: 'codex',
    label: 'Codex',
    description: "OpenAI's agent. Works with a ChatGPT Plus or Pro plan.",
    icon: <CodexIcon size={22} />,
  },
  {
    value: 'cursor',
    label: 'Cursor',
    description: "Cursor's agent, if that's already your editor.",
    icon: <CursorIcon size={22} />,
  },
  {
    value: 'opencode',
    label: 'Opencode',
    description: 'Open source, bring your own model.',
    icon: <OpencodeIcon size={22} />,
  },
  {
    value: 'other',
    label: 'Something else',
    description: "I'll set my own agent up later.",
  },
];

const HOST_OPTIONS: FlowOption<HostChoice | 'later'>[] = [
  {
    value: 'vercel',
    label: 'Vercel',
    description: 'Push a branch and it goes live. Free to start.',
    icon: <VercelIcon size={20} />,
  },
  {
    value: 'cloudflare',
    label: 'Cloudflare',
    description: 'Same idea, on Cloudflare Pages.',
    icon: <CloudflareIcon size={20} />,
  },
  {
    value: 'later',
    label: 'Decide later',
    description: "You can pick a host the first time you're ready to publish.",
  },
];

/** Setup ids that mean "this step is already on the machine". */
function presentSteps(items: SetupItem[], wanted: InstallStepId[]): InstallStepId[] {
  return wanted.filter((step) => items.find((i) => i.id === step)?.status === 'ready');
}

export type FlowStep = Step;

interface FlowOnboardingProps {
  /** Supplies the install work. See the module note on why this is injected. */
  driver: InstallAgentDriver;
  onComplete: () => void;
  /**
   * Start partway through. **Development tooling only** — the onboarding
   * playground uses it so a screen four answers deep is one click away
   * instead of a two-minute run-through every time you change a word on it.
   *
   * Production always starts at the beginning; nothing in the app passes this.
   */
  initialStep?: Step;
  /** Pre-answer the agent question, for the same reason as `initialStep`. */
  initialAgent?: AgentChoice;
}

export function FlowOnboarding({
  driver,
  onComplete,
  initialStep,
  initialAgent,
}: FlowOnboardingProps) {
  const [step, setStep] = useState<Step>('loading');
  const [items, setItems] = useState<SetupItem[]>([]);
  const [agent, setAgent] = useState<AgentChoice | null>(initialAgent ?? null);
  /** Whether the optional hosting step was actually answered, so the
   *  celebration copy doesn't claim a connection that was skipped. */
  const [hostConnected, setHostConnected] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const status = await getFullSetupStatus();
        setItems(status.items);
      } catch (err) {
        // Detection is an optimisation — without it the agent installs
        // everything and finds most of it already there. Not a blocker.
        logger.warn('Flow onboarding: setup status failed', { error: err });
      }
      setStep(initialStep ?? 'agent');
      void trackEvent('onboarding_flow_started');
    })();
  }, [initialStep]);

  /** Everything the machine needs, plus the agent they picked. */
  const installSteps = useMemo<InstallStepId[]>(() => {
    if (!agent || agent === 'other') return baseSteps();
    return [...baseSteps(), agent];
  }, [agent]);

  const alreadyPresent = useMemo(() => presentSteps(items, installSteps), [items, installSteps]);

  /**
   * Installing starts the moment an agent is chosen and runs underneath the
   * remaining questions.
   *
   * Waiting for a progress bar is dead time when there are still questions to
   * ask, and the hosting question needs nothing installed to answer. So the
   * work happens while the user is still reading — on a fast machine they
   * never see an install screen at all.
   */
  const session = useInstallAgentSession(
    driver,
    { steps: installSteps, alreadyPresent },
    { enabled: agent !== null }
  );

  const installsFinished = session.status === 'complete' || session.status === 'blocked';

  /** Sign-in only makes sense for an agent we actually got onto the machine. */
  const agentInstalled = agent !== null && agent !== 'other' && !session.skipped.includes(agent);

  /**
   * The screen actually shown.
   *
   * Two derivations rather than more state. `waiting` disappears the instant
   * the installs finish, so a fast machine never sees it — expressing that as
   * an effect would mean a render committing a state change, and a flicker of
   * a screen nobody needed to see.
   */
  const effectiveStep: Step =
    step === 'waiting' && installsFinished ? (agentInstalled ? 'signin' : 'github') : step;

  /**
   * The agent needs a person: an admin prompt, or a decision about a failure.
   *
   * This interrupts whatever question is on screen, because it is the only
   * thing in the flow that blocks real work and the only thing the user cannot
   * come back to later. One rule, no ordering to reason about.
   */
  const interruption = session.pendingUserAction ?? session.pendingRecovery;

  const handleAgent = useCallback((choice: AgentChoice) => {
    setAgent(choice);
    void trackEvent('onboarding_flow_agent_picked', { agent: choice });
    void (async () => {
      try {
        if (choice === 'other') {
          await setExternalAgentOptIn(true);
        } else {
          await setDefaultAgentId(choice === 'claude' ? 'claude-code' : choice);
        }
      } catch (err) {
        logger.warn('Flow onboarding: failed to persist agent choice', { error: err });
      }
    })();
    // Straight to the next question; the installs are already running.
    setStep('host');
  }, []);

  const handleHost = useCallback((choice: HostChoice | 'later') => {
    void trackEvent('onboarding_flow_host_picked', { host: choice });
    if (choice !== 'later') {
      setHostConnected(true);
      void setDefaultHost(choice).catch((err) =>
        logger.warn('Flow onboarding: failed to persist host', { error: err })
      );
    }
    setStep('waiting');
  }, []);

  const agentLabel = agent && agent !== 'other' ? stepLabel(agent) : 'your agent';

  if (step === 'loading') {
    return (
      <div className="flow-onboarding flow-onboarding-loading">
        <Spinner size="lg" />
      </div>
    );
  }

  if (effectiveStep === 'complete') {
    return (
      <CelebrationScreen
        onContinue={onComplete}
        hostingConnected={hostConnected}
        missing={session.skipped.map(stepLabel)}
      />
    );
  }

  /**
   * The interrupt outranks the question underneath it.
   *
   * Rendered before the step machine rather than inside it, so there is one
   * place that decides "the agent needs you" and no step has to remember to
   * check.
   */
  if (interruption) {
    return (
      <div className="flow-onboarding">
        <FlowScreen
          stepKey={session.pendingRecovery ? 'install-failed' : 'installing-user'}
          progress={PROGRESS[effectiveStep]}
          title={
            session.pendingRecovery
              ? `I couldn't install ${stepLabel(session.pendingRecovery.step)}`
              : 'One thing I need you for'
          }
          footer={driver.attribution && <InstallAttribution {...driver.attribution} />}
        >
          <FlowInstalling steps={installSteps} session={session} />
        </FlowScreen>
      </div>
    );
  }

  return (
    <div className="flow-onboarding">
      {effectiveStep === 'agent' && (
        <FlowScreen
          stepKey="agent"
          progress={PROGRESS.agent}
          title="Which coding agent do you want to use?"
          subtitle="This is the AI that writes your code. Pick the one you already pay for — or the first one, if you're not sure."
        >
          <FlowChoice
            options={AGENT_OPTIONS.map((option) => ({
              ...option,
              satisfied: items.find((i) => i.id === option.value)?.status === 'ready',
            }))}
            onSelect={handleAgent}
          />
        </FlowScreen>
      )}

      {/* Only reached when the installs are still going after every question
          has been answered. On a quick machine nobody ever sees this. */}
      {effectiveStep === 'waiting' && (
        <FlowScreen
          stepKey="waiting"
          progress={PROGRESS.waiting}
          title="Just finishing up"
          subtitle={session.narration ?? undefined}
          footer={driver.attribution && <InstallAttribution {...driver.attribution} />}
        >
          <FlowInstalling steps={installSteps} session={session} />
        </FlowScreen>
      )}

      {effectiveStep === 'signin' && (
        <FlowScreen
          stepKey="signin"
          progress={PROGRESS.signin}
          title={`${agentLabel} is installed. Sign in to start using it.`}
          subtitle="This connects the plan you already pay for. Ship Studio never sees your credentials."
        >
          <UserActionPrompt
            request={{
              kind: 'browser_auth',
              service: agentLabel,
              reason: `We'll open ${agentLabel} in your browser to sign in. Come back here when it's done.`,
            }}
            onRespond={() => setStep('github')}
          />
        </FlowScreen>
      )}

      {effectiveStep === 'github' && (
        <FlowScreen
          stepKey="github"
          progress={PROGRESS.github}
          title="Connect GitHub"
          subtitle="This is where your code lives, so you can't lose it and other people can see it."
        >
          <UserActionPrompt
            request={{
              kind: 'browser_auth',
              service: 'GitHub',
              reason:
                "We'll open GitHub in your browser. If you don't have an account, you can make one on the same screen — it's free.",
            }}
            onRespond={() => setStep('complete')}
          />
        </FlowScreen>
      )}

      {effectiveStep === 'host' && (
        <FlowScreen
          stepKey="host"
          progress={PROGRESS.host}
          title="Where should your sites go live?"
          subtitle="You can change this any time, and you don't need it to start building. I'm installing everything else while you decide."
          footer={
            <Button variant="ghost" onClick={() => handleHost('later')}>
              Skip this
            </Button>
          }
        >
          <FlowChoice options={HOST_OPTIONS} onSelect={handleHost} />
        </FlowScreen>
      )}

      {/* Quiet, always-present reassurance that GitHub is the only account
          we ever push to. Sits outside the screen so it doesn't animate. */}
      {effectiveStep === 'github' && (
        <p className="flow-onboarding-aside">
          <GitHubIcon size={12} /> We only ever push to repositories you create.
        </p>
      )}
    </div>
  );
}
