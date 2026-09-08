/**
 * Credit for whoever is doing — and paying for — the install work.
 *
 * Shown only during the install phase, which is the only time it is true:
 * that is when the agent is running and when the sponsored tokens are
 * actually being spent. Putting it on the opening question would credit fx
 * for a screen fx had nothing to do with.
 *
 * Quiet on purpose. It is an acknowledgement, not an ad, and it sits below
 * the thing the user is actually watching.
 */

import { VercelIcon } from '@/components/icons';
import type { InstallAgentAttribution } from '../../../lib/installAgent';

export function InstallAttribution({ poweredBy, fundedBy }: InstallAgentAttribution) {
  return (
    <p className="flow-attribution">
      <span className="flow-attribution-part">
        Powered by <span className="flow-attribution-name">{poweredBy}</span>
      </span>
      {fundedBy && (
        <>
          <span className="flow-attribution-sep" aria-hidden="true">
            ·
          </span>
          <span className="flow-attribution-part">
            Credits funded by
            <VercelIcon size={11} />
            <span className="flow-attribution-name">{fundedBy}</span>
          </span>
        </>
      )}
    </p>
  );
}
