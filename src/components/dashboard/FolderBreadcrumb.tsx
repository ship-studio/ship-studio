/**
 * Folder breadcrumb shown above ProjectList when the user has drilled into
 * a folder. Tiny leaf component extracted from ProjectList during Block 7
 * of the DX refactor.
 */

import { ArrowLeftIcon } from '@/components/icons';

interface FolderBreadcrumbProps {
  folderName: string;
  onBack: () => void;
}

export function FolderBreadcrumb({ folderName, onBack }: FolderBreadcrumbProps) {
  return (
    <div className="folder-breadcrumb">
      <button className="folder-breadcrumb-back text-style-control" onClick={onBack}>
        <ArrowLeftIcon size={14} />
        All Projects
      </button>
      <span className="folder-breadcrumb-separator text-style-control">/</span>
      <span className="folder-breadcrumb-current text-style-h4">{folderName}</span>
    </div>
  );
}
