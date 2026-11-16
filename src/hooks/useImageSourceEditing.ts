import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { resolveImageSource, type ElementSignature, type ImageResolution } from '../lib/edit';

export function imageSourceSignatureKey(projectPath: string, signature: ElementSignature): string {
  return JSON.stringify([
    projectPath,
    signature.domPath,
    signature.className,
    signature.tagName,
    signature.sourceFile,
    signature.sourceLine,
    signature.sourceColumn,
    signature.attrSrc,
    signature.attrAlt,
    signature.attrWidth,
    signature.attrHeight,
    signature.attrLoading,
    signature.ancestorClasses,
  ]);
}

/** Resolve a Settings-panel image independently of generic markup attribute lookup. */
export function useImageSourceResolution(
  projectPath: string,
  signature: ElementSignature,
  selectionKey: string
): {
  resolution: ImageResolution | null;
  setResolution: (resolution: ImageResolution) => void;
} {
  const key = `${selectionKey}:${imageSourceSignatureKey(projectPath, signature)}`;
  const signatureRef = useRef(signature);
  const currentKey = useRef(key);
  const [state, setState] = useState<{ key: string; resolution: ImageResolution | null }>(() => ({
    key,
    resolution: null,
  }));

  useLayoutEffect(() => {
    signatureRef.current = signature;
    currentKey.current = key;
  }, [key, signature]);

  useEffect(() => {
    if (signatureRef.current.tagName.toLowerCase() !== 'img' || !projectPath) return;

    let active = true;
    void resolveImageSource(projectPath, signatureRef.current)
      .then((resolution) => {
        if (active && currentKey.current === key) setState({ key, resolution });
      })
      .catch(() => {
        if (active && currentKey.current === key) {
          setState({
            key,
            resolution: { status: 'read_only', reason: 'Could not resolve this image to source.' },
          });
        }
      });
    return () => {
      active = false;
    };
  }, [key, projectPath]);

  const updateResolution = useCallback(
    (resolution: ImageResolution) => {
      setState((current) => (current.key === key ? { key, resolution } : current));
    },
    [key]
  );

  return {
    resolution: state.key === key ? state.resolution : null,
    setResolution: updateResolution,
  };
}

interface PendingReplacement {
  value: string;
  identity: string;
}

function resolutionIdentity(resolution: ImageResolution | null): string {
  if (!resolution) return '';
  if (resolution.status === 'json_property') {
    return JSON.stringify([
      resolution.source_file,
      resolution.source_line,
      resolution.source_column,
      resolution.file,
      resolution.property_path,
      resolution.expression,
      resolution.references,
      resolution.literal_references,
      resolution.scope_known,
    ]);
  }
  if (resolution.status === 'resolved') {
    return `${resolution.file}:${resolution.line}:${resolution.column}`;
  }
  return resolution.reason;
}

/** Shared Replace/URL confirmation flow for JSON-backed image values. */
export function useImageSourceEditConfirmation(
  resolution: ImageResolution | null,
  selectionKey: string,
  onReplace: (value: string, confirmedShared?: boolean) => Promise<void>
) {
  const identity = `${selectionKey}:${resolutionIdentity(resolution)}`;
  const identityRef = useRef(identity);
  const [pending, setPending] = useState<PendingReplacement | null>(null);
  const [applying, setApplying] = useState(false);
  const needsConfirmation =
    resolution?.status === 'json_property' &&
    (!resolution.scope_known || resolution.references.length > 1);

  useLayoutEffect(() => {
    identityRef.current = identity;
  }, [identity]);

  useEffect(() => {
    setPending(null);
  }, [identity]);

  const requestReplacement = useCallback(
    async (value: string) => {
      if (!resolution || resolution.status === 'read_only') return;
      if (needsConfirmation) {
        setPending({ value, identity });
        return;
      }
      await onReplace(value);
    },
    [identity, needsConfirmation, onReplace, resolution]
  );

  const cancel = useCallback(() => {
    if (!applying) setPending(null);
  }, [applying]);

  const confirm = useCallback(async () => {
    if (!pending || pending.identity !== identityRef.current) {
      setPending(null);
      return;
    }
    setApplying(true);
    try {
      await onReplace(pending.value, true);
      setPending(null);
    } catch {
      // The writer reports its failure; keep the review open for retry.
    } finally {
      setApplying(false);
    }
  }, [onReplace, pending]);

  return {
    needsConfirmation,
    pendingValue: pending?.identity === identity ? pending.value : null,
    applying,
    requestReplacement,
    cancel,
    confirm,
  };
}
