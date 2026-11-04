/**
 * An agent bound to a project: the "Works in" picker in the editor, the
 * project chip in the chat header, and the card a turn leaves when it
 * changed files there. Everything on the card is read from git by the
 * backend (`agents/project.rs`); nothing about deploys is shown, because
 * nothing here knows whether that commit deployed.
 *
 * @module components/agents/AgentProject
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { BranchIcon, CheckIcon, ChevronIcon, FolderIcon, GlobeIcon } from '@/components/icons';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { DiffModal } from '../branches/DiffModal';
import { listProjects } from '../../lib/project';
import {
  folderName,
  getChangeDiff,
  type Agent,
  type AgentMessage,
  type ChangedFile,
} from '../../lib/agents';

interface ProjectEntry {
  name: string;
  path: string;
}

interface AgentProjectsValue {
  /** The user's projects; null until loaded. */
  projects: ProjectEntry[] | null;
  openProject: (path: string) => void;
}

const AgentProjectsContext = createContext<AgentProjectsValue | null>(null);

/** Agents mode provides the user's projects and how to leave for one. */
export function AgentProjectsProvider({
  onOpenProject,
  children,
}: {
  onOpenProject: (path: string) => void;
  children: ReactNode;
}) {
  const [projects, setProjects] = useState<ProjectEntry[] | null>(null);
  useEffect(() => {
    let live = true;
    listProjects()
      .then((list) => live && setProjects(list))
      .catch(() => live && setProjects([]));
    return () => {
      live = false;
    };
  }, []);
  const value = useMemo(
    () => ({ projects, openProject: onOpenProject }),
    [projects, onOpenProject]
  );
  return <AgentProjectsContext.Provider value={value}>{children}</AgentProjectsContext.Provider>;
}

export const useAgentProjects = () => useContext(AgentProjectsContext);

/** The project's own name when it's still listed; its folder's otherwise. */
function nameOf(projects: ProjectEntry[] | null, path: string): string {
  return projects?.find((p) => p.path === path)?.name ?? folderName(path);
}

/** Quiet chip in the chat header: where this agent works. Opens the project. */
export function AgentProjectChip({ agent }: { agent: Agent }) {
  const ctx = useAgentProjects();
  if (!agent.project || !ctx) return null;
  const path = agent.project;
  const name = nameOf(ctx.projects, path);
  // Only said once the list is in: a project that left it can't be opened.
  const missing = ctx.projects !== null && !ctx.projects.some((p) => p.path === path);
  return (
    <Button
      tabIndex={0}
      variant="ghost"
      size="compact"
      className="agent-chat__project"
      leftIcon={<FolderIcon size={12} />}
      onClick={() => ctx.openProject(path)}
      disabled={missing}
      title={missing ? `${path} isn't one of your projects any more` : `Open ${name}`}
    >
      {name}
    </Button>
  );
}

/** "Works in" in the agent editor: none, or one of the user's projects. */
export function AgentProjectField({
  value,
  onChange,
}: {
  value: string;
  onChange: (path: string) => void;
}) {
  const ctx = useAgentProjects();
  const [loaded, setLoaded] = useState<ProjectEntry[] | null>(null);
  // The editor also opens outside Agents mode's provider (and before it loads).
  useEffect(() => {
    if (ctx?.projects) return;
    let live = true;
    listProjects()
      .then((list) => live && setLoaded(list))
      .catch(() => live && setLoaded([]));
    return () => {
      live = false;
    };
  }, [ctx?.projects]);
  const projects = ctx?.projects ?? loaded;
  const label = value ? nameOf(projects, value) : 'No project';
  return (
    <div className="agent-editor__label" role="group" aria-label="Works in">
      Works in
      <Dropdown
        menuClassName="agent-model-menu agent-project-menu"
        trigger={(p) => (
          <MenuButton
            {...p}
            tabIndex={0}
            variant="secondary"
            className="agent-editor__project"
            expanded={p['aria-expanded']}
            aria-label={`Works in: ${label}`}
          >
            <FolderIcon size={14} />
            <span className="agent-editor__project-name">{label}</span>
            <ChevronIcon size={10} className={p['aria-expanded'] ? 'chevron-flipped' : undefined} />
          </MenuButton>
        )}
      >
        <DropdownItem onSelect={() => onChange('')}>
          <span className="agent-model-menu__label">No project</span>
          <span className="agent-model-menu__check" aria-hidden="true">
            {!value && <CheckIcon size={12} />}
          </span>
        </DropdownItem>
        {projects && projects.length > 0 && <DropdownDivider />}
        {projects?.map((p) => (
          <DropdownItem key={p.path} onSelect={() => onChange(p.path)}>
            <span className="agent-model-menu__label">{p.name}</span>
            <span className="agent-model-menu__check" aria-hidden="true">
              {p.path === value && <CheckIcon size={12} />}
            </span>
          </DropdownItem>
        ))}
      </Dropdown>
      <p className="agent-editor__hint">
        {value
          ? "It works inside this project, so the project's CLAUDE.md and settings apply. After each turn that changes files, the chat lists them."
          : 'It works in its own folder and can still reach every project.'}
      </p>
    </div>
  );
}

function LineCounts({ added = 0, removed = 0 }: { added?: number; removed?: number }) {
  return (
    <>
      {added > 0 && <span className="agent-changes__added">+{added}</span>}
      {removed > 0 && <span className="agent-changes__removed">−{removed}</span>}
    </>
  );
}

/** What a bound agent's turn changed in its project, from git. */
export function ChangeCard({ message, arrived }: { message: AgentMessage; arrived?: boolean }) {
  const ctx = useAgentProjects();
  const changes = message.changes;
  const [expanded, setExpanded] = useState(false);
  const [viewing, setViewing] = useState<ChangedFile | null>(null);
  // Stable, or the diff modal would refetch on every render.
  const { agentId, id } = message;
  const loadDiff = useCallback(
    (_: string, path: string) => getChangeDiff(agentId, id, path),
    [agentId, id]
  );
  if (!changes) return null;
  const project = nameOf(ctx?.projects ?? null, changes.project);
  const count = changes.fileCount === 1 ? '1 file' : `${changes.fileCount} files`;
  const only = changes.files.length === 1 ? changes.files[0] : null;
  const unlisted = changes.fileCount - changes.files.length;
  const viewDiff = () => (only ? setViewing(only) : setExpanded((v) => !v));
  return (
    <div
      className="agent-changes"
      data-arrived={arrived || undefined}
      data-message-ids={message.id}
    >
      <div className="agent-changes__head">
        <span className="agent-changes__summary">
          Changed {count} in {project}
          <span className="agent-changes__counts">
            <LineCounts added={changes.added} removed={changes.removed} />
          </span>
        </span>
        {changes.branch && (
          <span className="agent-changes__branch" title="Branch when the turn ended">
            <BranchIcon size={12} />
            {changes.branch}
          </span>
        )}
      </div>
      {expanded && (
        <ul className="agent-changes__files">
          {changes.files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                tabIndex={0}
                className="agent-changes__file"
                data-status={file.status}
                onClick={() => setViewing(file)}
                title={`View the diff of ${file.path}`}
              >
                <span className="agent-changes__path">{file.path}</span>
                <span className="agent-changes__counts">
                  {file.added == null ? (
                    'binary'
                  ) : (
                    <LineCounts added={file.added} removed={file.removed} />
                  )}
                </span>
              </button>
            </li>
          ))}
          {unlisted > 0 && <li className="agent-changes__more">and {unlisted} more</li>}
        </ul>
      )}
      <div className="agent-changes__actions">
        <TextButton tabIndex={0} aria-expanded={only ? undefined : expanded} onClick={viewDiff}>
          {only || !expanded ? 'View diff' : 'Hide files'}
        </TextButton>
        {ctx && (
          <TextButton
            tabIndex={0}
            leftIcon={<GlobeIcon size={12} />}
            onClick={() => ctx.openProject(changes.project)}
          >
            Open preview
          </TextButton>
        )}
      </div>
      {viewing && (
        <DiffModal
          projectPath={changes.project}
          filePath={viewing.path}
          fileStatus={viewing.status}
          loadDiff={loadDiff}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}
