/**
 * Popover for a control whose value is inherited from an ANCESTOR element's
 * styles (the orange label state). Shows the provenance — which ancestor
 * defines the value and, when confidently attributed, its Tailwind token —
 * plus two actions: adopt the value locally ("Set here"), and jump to the
 * ancestor's source location (lazily resolved; container classes often can't
 * be pinned to one spot, which degrades to a muted note, never a guess).
 */

import { useEffect } from 'react';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { CodeIcon } from './CodeIcon';
import { Spinner } from '../primitives/Spinner';
import { useInvoke } from '../../hooks/useInvoke';
import type { ElementSignature, InheritedProp, Resolution } from '../../lib/edit';

interface Props {
  inherited: InheritedProp;
  projectPath: string;
  onAdopt?: () => void;
  onOpenInCode?: (file: string, line: number) => void;
  onClose: () => void;
}

export function InheritancePopover({
  inherited,
  projectPath,
  onAdopt,
  onOpenInCode,
  onClose,
}: Props) {
  // The synthetic signature the resolver anchors with: the DEFINING ancestor's
  // own class string plus the chain above it.
  const signature: ElementSignature = {
    className: inherited.className,
    tagName: inherited.tagName,
    text: '',
    ancestorClasses: inherited.ancestorClasses,
  };
  const resolution = useInvoke<Resolution>('resolve_classname_source');

  useEffect(() => {
    void resolution.execute({ projectPath, signature });
    // Resolve once per open; the selection's provenance doesn't change mid-popover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const res = resolution.data;
  const firstClass = inherited.className.trim().split(/\s+/)[0] ?? '';

  return (
    <div className="ss-inherit-pop" role="dialog" aria-label="Inherited style provenance">
      <p className="ss-inherit-pop__title">Inherited</p>
      <p className="ss-inherit-pop__from">
        <code>
          &lt;{inherited.tagName}
          {firstClass && `.${firstClass}`}&gt;
        </code>
        {inherited.token && <span className="ss-inherit-pop__token">{inherited.token}</span>}
      </p>
      <p className="ss-inherit-pop__value">
        Value <code>{inherited.cssValue}</code>
      </p>

      {onAdopt && (
        <Button
          variant="default"
          size="compact"
          block
          onClick={() => {
            onAdopt();
            onClose();
          }}
        >
          Set here explicitly
        </Button>
      )}

      <div className="ss-inherit-pop__source">
        {resolution.isLoading ? (
          <Spinner size="sm" />
        ) : res?.status === 'resolved' && onOpenInCode ? (
          <TextButton
            onClick={() => {
              onOpenInCode(res.file, res.line);
              onClose();
            }}
            title="Open the defining class in the Code tab"
          >
            <code>
              {res.file}:{res.line}
            </code>
            <CodeIcon size={12} />
          </TextButton>
        ) : (
          // multi / read_only / no_class / error — the ancestor's class literal
          // appears in several spots or isn't a static string; never guess.
          <span className="ss-inherit-pop__nosrc">Source couldn&apos;t be pinned</span>
        )}
      </div>

      <p className="ss-inherit-pop__hint">Editing the value here writes a local override.</p>
    </div>
  );
}
