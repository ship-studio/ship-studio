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
import {
  BASE_STEPS,
  InstallAgentDriver,
  InstallStepId,
  stepLabel,
} from '../../../lib/installAgent';
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
type Step = 'loading' | 'agent' | 'installing' | 'signin' | 'github' | 'host' | 'complete';

/** Progress for the hairline bar. Terminal screens omit it entirely. */
const PROGRESS: Partial<Record<Step, number>> = {
  agent: 0.15,
  installing: 0.4,
  signin: 0.6,
  github: 0.8,
  host: 0.95,
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

interface FlowOnboardingProps {
  /** Supplies the install work. See the module note on why this is injected. */
  driver: InstallAgentDriver;
  onComplete: () => void;
}

export function FlowOnboarding({ driver, onComplete }: FlowOnboardingProps) {
  const [step, setStep] = useState<Step>('loading');
  const [items, setItems] = useState<SetupItem[]>([]);
  const [agent, setAgent] = useState<AgentChoice | null>(null);
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
      setStep('agent');
      void trackEvent('onboarding_flow_started');
    })();
  }, []);

  /** Everything the machine needs, plus the agent they picked. */
  const installSteps = useMemo<InstallStepId[]>(() => {
    if (!agent || agent === 'other') return BASE_STEPS;
    return [...BASE_STEPS, agent];
  }, [agent]);

  const alreadyPresent = useMemo(() => presentSteps(items, installSteps), [items, installSteps]);

  const session = useInstallAgentSession(
    driver,
    { steps: installSteps, alreadyPresent },
    {
      enabled: step === 'installing',
      // Skip the sign-in beat for someone bringing their own agent: there is
      // nothing of ours for them to sign into.
      onDone: (status) => {
        if (status !== 'complete') return;
        setStep(agent && agent !== 'other' ? 'signin' : 'github');
      },
    }
  );

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
    setStep('installing');
  }, []);

  const handleHost = useCallback((choice: HostChoice | 'later') => {
    void trackEvent('onboarding_flow_host_picked', { host: choice });
    if (choice !== 'later') {
      setHostConnected(true);
      void setDefaultHost(choice).catch((err) =>
        logger.warn('Flow onboarding: failed to persist host', { error: err })
      );
    }
    setStep('complete');
  }, []);

  const agentLabel = agent && agent !== 'other' ? stepLabel(agent) : 'your agent';

  if (step === 'loading') {
    return (
      <div className="flow-onboarding flow-onboarding-loading">
        <Spinner size="lg" />
      </div>
    );
  }

  if (step === 'complete') {
    return <CelebrationScreen onContinue={onComplete} hostingConnected={hostConnected} />;
  }

  return (
    <div className="flow-onboarding">
      {step === 'agent' && (
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

      {step === 'installing' && (
        <FlowScreen
          stepKey={session.pendingUserAction ? 'installing-user' : 'installing'}
          progress={PROGRESS.installing}
          title={session.pendingUserAction ? 'One thing I need you for' : `Setting up your machine`}
          subtitle={session.pendingUserAction ? undefined : (session.narration ?? undefined)}
          footer={driver.attribution && <InstallAttribution {...driver.attribution} />}
        >
          <FlowInstalling steps={installSteps} session={session} />
        </FlowScreen>
      )}

      {step === 'signin' && (
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

      {step === 'github' && (
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
            onRespond={() => setStep('host')}
          />
        </FlowScreen>
      )}

      {step === 'host' && (
        <FlowScreen
          stepKey="host"
          progress={PROGRESS.host}
          title="Last one — where should your sites go live?"
          subtitle="You can change this any time, and you don't need it to start building."
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
      {step === 'github' && (
        <p className="flow-onboarding-aside">
          <GitHubIcon size={12} /> We only ever push to repositories you create.
        </p>
      )}
    </div>
  );
}
