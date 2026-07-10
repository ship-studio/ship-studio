/**
 * Scripted stand-in for the guided agent session, used under mock mode
 * (SHIPSTUDIO_FORCE_SETUP). Plays a realistic agent transcript on a timeline
 * and flips the backend mock state as it "installs" each tool, so the real
 * checklist polling ticks green exactly as it would in production — with zero
 * changes to the host machine. This is the reliable visual test path for
 * contributors; see CLAUDE.md → Onboarding Testing.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { mockMarkSetupItemReady, HostChoice } from '../../../lib/agentOnboarding';
import { logger } from '../../../lib/logger';

interface DemoLine {
  /** Styling: agent prose, executed command, command output, success note. */
  kind: 'agent' | 'cmd' | 'out' | 'ok';
  text: string;
  /** Pause before this line appears. */
  delayMs: number;
  /** Mock item to flip ready when this line lands. */
  markReady?: string;
}

const SCRIPT: DemoLine[] = [
  {
    kind: 'agent',
    text: "Hi! I'm your AI agent. I'll get this computer ready for Ship Studio — sit back, I'll explain each step as I go.",
    delayMs: 600,
  },
  { kind: 'agent', text: 'First, checking what’s already installed…', delayMs: 1600 },
  { kind: 'cmd', text: '$ brew --version', delayMs: 900 },
  { kind: 'out', text: 'zsh: command not found: brew', delayMs: 700 },
  {
    kind: 'agent',
    text: 'Homebrew isn’t installed yet — it’s the tool that installs everything else. Installing it now (about a minute; if you’re asked for your computer password, type it and press Enter — it stays invisible while you type).',
    delayMs: 1200,
  },
  {
    kind: 'cmd',
    text: '$ /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
    delayMs: 1100,
  },
  { kind: 'out', text: '==> Downloading and installing Homebrew…', delayMs: 1000 },
  { kind: 'out', text: '🍺  Installation successful!', delayMs: 1800 },
  { kind: 'ok', text: '✓ Homebrew installed and verified', delayMs: 700, markReady: 'homebrew' },
  {
    kind: 'agent',
    text: 'Now Node.js, Git and the GitHub CLI — all three in one go.',
    delayMs: 1100,
  },
  { kind: 'cmd', text: '$ brew install node git gh', delayMs: 900 },
  { kind: 'out', text: '==> Fetching node, git, gh', delayMs: 900 },
  { kind: 'out', text: '==> Pouring node, git, gh bottles…', delayMs: 1300 },
  { kind: 'ok', text: '✓ Node.js v22 installed and verified', delayMs: 1200, markReady: 'node' },
  { kind: 'ok', text: '✓ Git installed and verified', delayMs: 800, markReady: 'git' },
  { kind: 'ok', text: '✓ GitHub CLI installed and verified', delayMs: 800, markReady: 'gh' },
  {
    kind: 'agent',
    text: 'Last step — connecting your GitHub account, which is where your projects are saved online. A browser window will open: sign in, or create a free account, then come back here.',
    delayMs: 1200,
  },
  { kind: 'cmd', text: '$ gh auth login --web --git-protocol https', delayMs: 1000 },
  { kind: 'out', text: '! First copy your one-time code: ABCD-1234', delayMs: 900 },
  { kind: 'out', text: '✓ Authentication complete.', delayMs: 2200 },
  { kind: 'ok', text: '✓ GitHub account connected', delayMs: 700, markReady: 'gh_auth' },
];

/** Host-specific demo beats, appended before the wrap-up line. */
const HOST_SCRIPTS: Record<HostChoice, DemoLine[]> = {
  vercel: [
    {
      kind: 'agent',
      text: 'And your hosting — installing the Vercel CLI and signing you in.',
      delayMs: 1100,
    },
    { kind: 'cmd', text: '$ npm install -g vercel --force && vercel login', delayMs: 900 },
    { kind: 'ok', text: '✓ Vercel connected', delayMs: 1600, markReady: 'vercel' },
    { kind: 'ok', text: '✓ Vercel account signed in', delayMs: 700, markReady: 'vercel_auth' },
  ],
  cloudflare: [
    {
      kind: 'agent',
      text: 'And your hosting — installing the Cloudflare Wrangler CLI and signing you in.',
      delayMs: 1100,
    },
    { kind: 'cmd', text: '$ npm install -g wrangler --force && wrangler login', delayMs: 900 },
    { kind: 'ok', text: '✓ Cloudflare connected', delayMs: 1600 },
  ],
};

const WRAP_UP: DemoLine = {
  kind: 'agent',
  text: 'That’s everything! Watch the checklist — Ship Studio is running its own checks, and every item should turn green. You’re ready to ship. 🚢',
  delayMs: 1100,
};

interface DemoAgentTerminalProps {
  /** Hosting provider chosen in the hosting step (null = skipped). */
  hostChoice: HostChoice | null;
}

export function DemoAgentTerminal({ hostChoice }: DemoAgentTerminalProps) {
  const [visibleCount, setVisibleCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const script = useMemo(
    () => [...SCRIPT, ...(hostChoice ? HOST_SCRIPTS[hostChoice] : []), WRAP_UP],
    [hostChoice]
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const playFrom = (index: number) => {
      if (cancelled || index >= script.length) return;
      const line = script[index];
      timer = setTimeout(() => {
        if (cancelled) return;
        setVisibleCount(index + 1);
        if (line.markReady) {
          mockMarkSetupItemReady(line.markReady).catch((err: unknown) => {
            logger.warn('Demo: failed to mark mock item ready', {
              itemId: line.markReady,
              error: String(err),
            });
          });
        }
        playFrom(index + 1);
      }, line.delayMs);
    };
    playFrom(0);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [script]);

  // Keep the newest line in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibleCount]);

  return (
    <div className="demo-agent-terminal" ref={scrollRef} aria-label="Demo agent session">
      <div className="demo-agent-terminal-badge">Demo — scripted session, nothing is installed</div>
      {script.slice(0, visibleCount).map((line, idx) => (
        <div key={idx} className={`demo-agent-line demo-agent-line-${line.kind}`}>
          {line.text}
        </div>
      ))}
      {visibleCount < script.length && <span className="demo-agent-cursor" />}
    </div>
  );
}
