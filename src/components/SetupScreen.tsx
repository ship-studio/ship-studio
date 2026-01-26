/**
 * SetupScreen component displayed when required CLI tools are missing.
 *
 * Shows a checklist of prerequisites (node, npm, git, gh, vercel, claude)
 * with their installation status. For missing tools, provides:
 * - Direct links to installation pages
 * - Homebrew/npm install commands where applicable
 *
 * Users can retry detection after installing missing tools.
 *
 * @module components/SetupScreen
 */

/** Represents a CLI tool prerequisite and its availability */
interface Prerequisite {
  name: string;
  available: boolean;
  path: string | null;
}

interface SetupScreenProps {
  prerequisites: Prerequisite[];
  onRetry: () => void;
}

const INSTALL_INSTRUCTIONS: Record<string, { url: string; command?: string }> = {
  node: {
    url: 'https://nodejs.org',
    command: 'brew install node',
  },
  npm: {
    url: 'https://nodejs.org',
    command: 'Comes with Node.js',
  },
  git: {
    url: 'https://git-scm.com',
    command: 'brew install git',
  },
  gh: {
    url: 'https://cli.github.com',
    command: 'brew install gh',
  },
  vercel: {
    url: 'https://vercel.com/docs/cli',
    command: 'npm install -g vercel',
  },
  claude: {
    url: 'https://docs.anthropic.com/en/docs/claude-code',
    command: 'npm install -g @anthropic-ai/claude-code',
  },
};

export function SetupScreen({ prerequisites, onRetry }: SetupScreenProps) {
  const missing = prerequisites.filter((p) => !p.available);

  return (
    <div className="setup-screen">
      <h1>Setup Required</h1>
      <p>Ship Studio requires the following tools to be installed:</p>

      <div className="prerequisites-list">
        {prerequisites.map((prereq) => (
          <div
            key={prereq.name}
            className={`prerequisite ${prereq.available ? 'available' : 'missing'}`}
          >
            <span className="status">{prereq.available ? '✓' : '✗'}</span>
            <span className="name">{prereq.name}</span>
            {prereq.available ? (
              <span className="path">{prereq.path}</span>
            ) : (
              <div className="install-info">
                <a
                  href={INSTALL_INSTRUCTIONS[prereq.name]?.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Install →
                </a>
                {INSTALL_INSTRUCTIONS[prereq.name]?.command && (
                  <code>{INSTALL_INSTRUCTIONS[prereq.name].command}</code>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {missing.length > 0 && (
        <div className="setup-actions">
          <p>Install the missing tools above, then click retry.</p>
          <button className="btn-primary" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
