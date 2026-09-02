/**
 * AttachedLibrariesModal — manage the workspace's shared libraries ("attached
 * libraries" internally): local folders that ride along into every agent
 * session in the active workspace.
 *
 * Shared libraries let a user carry their own skills and reference docs across
 * a workspace's projects: Ship Studio passes each registered folder to the
 * agent via its additional-directory flag (Claude Code's `--add-dir`), so the
 * folder's skills load and its files are readable in every project. The
 * folder's own CLAUDE.md is never loaded, so it can't override the project's
 * instructions. Scoping is per workspace (account) — e.g. one set of brand
 * docs per client workspace — resolved backend-side from the active account.
 *
 * Folders are registered through a native picker (the trust boundary) — see
 * `src/lib/attached-libraries.ts` and `commands/attached_libraries.rs`.
 *
 * @module components/dashboard/AttachedLibrariesModal
 */

import { useEffect } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { FolderPlusIcon, TrashIcon } from '@/components/icons';
import { useAsyncState } from '../../hooks/useAsyncState';
import { useOptionalToast } from '../../contexts/ToastContext';
import {
  listAttachedLibraries,
  addAttachedLibrary,
  removeAttachedLibrary,
  type AttachedLibrary,
} from '../../lib/attached-libraries';
import { asCommandError, formatCommandError } from '../../lib/errors';

const errMsg = (err: unknown) => formatCommandError(asCommandError(err));

interface AttachedLibrariesModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AttachedLibrariesModal({ isOpen, onClose }: AttachedLibrariesModalProps) {
  const { showToast } = useOptionalToast();
  const { data, isLoading, error, execute } =
    useAsyncState<AttachedLibrary[]>(listAttachedLibraries);

  // Load (and refresh) the list whenever the modal opens.
  useEffect(() => {
    if (isOpen) void execute();
  }, [isOpen, execute]);

  const libraries = data ?? [];

  const handleAdd = async () => {
    try {
      const added = await addAttachedLibrary();
      // null = user cancelled the folder picker; nothing to do.
      if (added) {
        showToast('Library attached', 'success');
        await execute();
      }
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
  };

  const handleRemove = async (path: string) => {
    try {
      await removeAttachedLibrary(path);
      showToast('Library removed', 'success');
      await execute();
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
  };

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={onClose}
      title="Shared libraries"
      className="settings-modal"
    >
      <div className="settings-modal-body">
        <p className="attached-libraries-intro">
          A shared library is a folder your agent brings along to every project in this workspace —
          it can read and edit the files in it from any project, without you copying them into each
          repo.
        </p>

        {isLoading && libraries.length === 0 ? (
          <div className="attached-libraries-loading">
            <Spinner />
          </div>
        ) : error ? (
          <p className="attached-libraries-error">Couldn&rsquo;t load attached libraries.</p>
        ) : libraries.length === 0 ? (
          <div className="attached-libraries-empty">
            <p>Attach a folder of things you reuse across this workspace&rsquo;s projects:</p>
            <ul className="attached-libraries-examples">
              <li>Brand guidelines, tone of voice, product facts</li>
              <li>Code snippets and components you copy between projects</li>
              <li>
                Your own agent skills (a <code>.claude/skills</code> folder) — usable everywhere
              </li>
            </ul>
            <p className="attached-libraries-note">
              Works with Claude Code. A library&rsquo;s own <code>CLAUDE.md</code> is never loaded,
              so it can&rsquo;t override a project&rsquo;s instructions.
            </p>
          </div>
        ) : (
          <ul className="attached-libraries-list">
            {libraries.map((lib) => (
              <li key={lib.path} className="attached-libraries-item">
                <span className="attached-libraries-path" title={lib.path}>
                  {lib.path}
                </span>
                <button
                  type="button"
                  className="attached-libraries-remove"
                  onClick={() => void handleRemove(lib.path)}
                  title="Remove library"
                  aria-label={`Remove ${lib.path}`}
                >
                  <TrashIcon size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <Button
          variant="secondary"
          leftIcon={<FolderPlusIcon size={14} />}
          onClick={() => void handleAdd()}
        >
          Add library
        </Button>
      </div>
    </ModalFrame>
  );
}
