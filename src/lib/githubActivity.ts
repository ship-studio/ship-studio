/**
 * Authenticated GitHub activity returned by the desktop GitHub CLI integration.
 *
 * @module lib/githubActivity
 */

import { invoke } from '@tauri-apps/api/core';

export type GitHubPullRequestStatus = 'merged' | 'open' | 'closed' | 'restricted';

export interface GitHubContributionDay {
  date: string;
  count: number;
  level: number;
}

export interface GitHubCommitContribution {
  occurredAt: string;
  commitCount: number;
}

export interface GitHubPullRequestContribution {
  occurredAt: string;
  statusChangedAt: string;
  number: number | null;
  title: string | null;
  repository: string | null;
  url: string | null;
  status: GitHubPullRequestStatus;
}

export interface GitHubReviewContribution {
  occurredAt: string;
  state: string;
  number: number | null;
  title: string | null;
  repository: string | null;
  url: string | null;
}

export interface GitHubActivityData {
  username: string;
  contributions: GitHubContributionDay[];
  commits: GitHubCommitContribution[];
  pullRequests: GitHubPullRequestContribution[];
  reviews: GitHubReviewContribution[];
  completeness: {
    commits: boolean;
    pullRequests: boolean;
    reviews: boolean;
    privateActivityRestricted: boolean;
  };
}

/**
 * Fetch the signed-in GitHub user's recent activity through `gh`.
 *
 * @param from - Inclusive ISO 8601 start timestamp in the user's local range.
 * @param to - Inclusive ISO 8601 end timestamp in the user's local range.
 */
export function getGitHubActivity(from: string, to: string): Promise<GitHubActivityData> {
  return invoke<GitHubActivityData>('get_github_activity', { from, to });
}
