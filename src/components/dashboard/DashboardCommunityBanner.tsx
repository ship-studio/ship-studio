/**
 * DashboardCommunityBanner — Slack community callout for the dashboard sidebar.
 *
 * @module components/DashboardCommunityBanner
 */

import { openUrl } from '@tauri-apps/plugin-opener';
import { EyeOffIcon, SlackIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { SLACK_INVITE_URL } from '../../lib/links';

interface DashboardCommunityBannerProps {
  onHide: () => void;
}

/**
 * Renders the dashboard community banner with join and hide actions.
 * @param props - Banner dismissal callback.
 */
export function DashboardCommunityBanner({ onHide }: DashboardCommunityBannerProps) {
  return (
    <div className="slack-cta" data-education-id="slack-cta">
      <div className="slack-cta-content">
        <SlackIcon />
        <span className="text-style-body-medium">
          <strong>Join the Slack</strong> — suggest features, share what you're building, and shape
          the future of how we build for the web.
        </span>
      </div>
      <div className="slack-cta-actions">
        <Button
          variant="secondary"
          className="slack-cta-join text-style-control-semibold"
          onClick={() => void openUrl(SLACK_INVITE_URL)}
        >
          Join Slack
        </Button>
        <IconButton
          variant="ghost"
          className="slack-cta-hide"
          icon={<EyeOffIcon size={14} />}
          onClick={onHide}
          title="Hide"
          aria-label="Hide community banner"
        />
      </div>
    </div>
  );
}
