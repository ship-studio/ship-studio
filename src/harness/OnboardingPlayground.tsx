/**
 * A workbench for onboarding.
 *
 * Onboarding has historically been miserable to work on, for one structural
 * reason: it is the only screen in the app whose whole point is a machine
 * state you cannot have. To see the interesting parts you needed a computer
 * with nothing installed, a package mirror that happened to be down, or a
 * Windows box — and having got one, every change cost a full run-through to
 * look at.
 *
 * So: every one of those variables becomes a control, and the flow re-mounts
 * against them instantly. Which screen, what's already installed, which step
 * fails, which OS the copy claims to be on, how fast it plays.
 *
 * Two rules keep it honest:
 *
 * - It renders the **real** `FlowOnboarding` against the **real** fixture
 *   backend. Nothing here reimplements a screen, so it cannot drift from the
 *   thing users get and quietly certify a layout that doesn't exist.
 * - The state lives in the URL, so a bug report is a link. "Broken on the
 *   Windows password screen with Homebrew failing" stops being a paragraph
 *   someone has to reconstruct.
 *
 * Reachable at `harness.html?scenario=onboarding-playground`.
 */

import { useCallback, useState } from 'react';
import { FlowOnboarding, type FlowStep } from '../components/setup/flow/FlowOnboarding';
import { scriptedDriver, INSTALL_STEPS, type InstallStepId } from '../lib/installAgent';
import { __setPlatformOverrideForDev } from '../lib/setup';
import { setHarnessSetupPresent } from './scenarios/onboarding';

type AgentChoice = 'claude' | 'codex' | 'cursor' | 'opencode' | 'other';

/** Machine states worth having a button for. */
const MACHINES = {
  fresh: { label: 'Nothing installed', present: [] as string[] },
  partial: { label: 'Has Claude Code', present: ['claude'] },
  loaded: {
    label: 'Everything already there',
    present: ['homebrew', 'node', 'git', 'gh', 'claude'],
  },
} as const;
type MachineKey = keyof typeof MACHINES;

const STEPS: { value: FlowStep; label: string }[] = [
  { value: 'agent', label: 'Pick an agent' },
  { value: 'installing', label: 'Installing' },
  { value: 'signin', label: 'Sign in to agent' },
  { value: 'github', label: 'Connect GitHub' },
  { value: 'host', label: 'Choose a host' },
  { value: 'complete', label: 'Celebration' },
];

const PACES = [
  { value: '1', label: 'Real time' },
  { value: '0.25', label: '4× faster' },
  { value: '0.02', label: 'Instant' },
];

interface Settings {
  step: FlowStep;
  agent: AgentChoice;
  machine: MachineKey;
  failStep: InstallStepId | '';
  platform: 'macos' | 'windows';
  pace: string;
}

const DEFAULTS: Settings = {
  step: 'agent',
  agent: 'claude',
  machine: 'fresh',
  failStep: '',
  platform: 'macos',
  pace: '1',
};

/** Settings live in the query string so any state is a shareable link. */
function readSettings(): Settings {
  const p = new URLSearchParams(window.location.search);
  const get = <K extends keyof Settings>(key: K, fallback: Settings[K]) =>
    (p.get(key) as Settings[K]) || fallback;
  return {
    step: get('step', DEFAULTS.step),
    agent: get('agent', DEFAULTS.agent),
    machine: get('machine', DEFAULTS.machine),
    failStep: get('failStep', DEFAULTS.failStep),
    platform: get('platform', DEFAULTS.platform),
    pace: get('pace', DEFAULTS.pace),
  };
}

function writeSettings(settings: Settings): void {
  const p = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(settings)) {
    if (value) p.set(key, String(value));
    else p.delete(key);
  }
  window.history.replaceState(null, '', `?${p.toString()}`);
}

export function OnboardingPlayground() {
  const [settings, setSettings] = useState<Settings>(readSettings);
  /** Bumping this remounts the flow, which is how "Restart" works. */
  const [runId, setRunId] = useState(0);

  // Applied before the flow renders, since both are read at session start.
  __setPlatformOverrideForDev(settings.platform);
  localStorage.setItem('shipstudio.installAgentPace', settings.pace);
  if (settings.failStep) localStorage.setItem('shipstudio.installAgentFailStep', settings.failStep);
  else localStorage.removeItem('shipstudio.installAgentFailStep');

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      writeSettings(next);
      return next;
    });
    setRunId((n) => n + 1);
  }, []);

  // The scenario owns the command map; this only decides which of its items
  // read as ready. Applied during render, like the pace and platform above,
  // because the flow reads all three as it mounts.
  setHarnessSetupPresent(MACHINES[settings.machine].present);

  return (
    <div className="pg">
      <aside className="pg-controls">
        <h2 className="pg-title">Onboarding playground</h2>

        <Field label="Start on">
          <select
            value={settings.step}
            onChange={(e) => update({ step: e.target.value as FlowStep })}
          >
            {STEPS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Machine">
          <select
            value={settings.machine}
            onChange={(e) => update({ machine: e.target.value as MachineKey })}
          >
            {Object.entries(MACHINES).map(([key, m]) => (
              <option key={key} value={key}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Agent">
          <select
            value={settings.agent}
            onChange={(e) => update({ agent: e.target.value as AgentChoice })}
          >
            {(['claude', 'codex', 'cursor', 'opencode', 'other'] as AgentChoice[]).map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Make this fail">
          <select
            value={settings.failStep}
            onChange={(e) => update({ failStep: e.target.value as InstallStepId | '' })}
          >
            <option value="">Nothing fails</option>
            {(Object.keys(INSTALL_STEPS) as InstallStepId[]).map((id) => (
              <option key={id} value={id}>
                {INSTALL_STEPS[id].label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Pretend OS">
          <select
            value={settings.platform}
            onChange={(e) => update({ platform: e.target.value as Settings['platform'] })}
          >
            <option value="macos">macOS</option>
            <option value="windows">Windows</option>
          </select>
        </Field>

        <Field label="Speed">
          <select value={settings.pace} onChange={(e) => update({ pace: e.target.value })}>
            {PACES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>

        <button type="button" className="pg-restart" onClick={() => setRunId((n) => n + 1)}>
          Restart run
        </button>

        <p className="pg-note">
          Every setting is in the URL — copy the address bar to hand someone the exact screen you
          are looking at.
        </p>
      </aside>

      <main className="pg-stage">
        <FlowOnboarding
          key={`${runId}-${settings.step}-${settings.agent}`}
          driver={scriptedDriver}
          initialStep={settings.step}
          initialAgent={settings.agent}
          onComplete={() => update({ step: 'agent' })}
        />
      </main>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="pg-field">
      <span className="pg-field-label">{label}</span>
      {children}
    </label>
  );
}
