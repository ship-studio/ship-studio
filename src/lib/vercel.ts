/**
 * Vercel CLI integration utilities.
 *
 * Provides functions for:
 * - Checking Vercel CLI installation and authentication
 * - Installing the Vercel CLI globally
 * - Linking projects to Vercel via GitHub integration
 * - Deploying projects and checking deployment status
 *
 * All operations use the Vercel CLI via Tauri backend commands.
 *
 * @module lib/vercel
 */

import { invoke } from '@tauri-apps/api/core';

/** Vercel CLI installation and authentication status */
export interface VercelCliStatus {
  /** Whether vercel CLI is installed */
  installed: boolean;
  /** Whether user is logged in to Vercel */
  authenticated: boolean;
}

/** Project's Vercel connection status */
export interface ProjectVercelStatus {
  /** Connection state */
  status: 'not-linked' | 'not-git-connected' | 'connected';
  /** Vercel project name */
  project_name: string | null;
  /** Vercel org/team slug for dashboard URLs */
  vercel_org: string | null;
  /** Production URL (shortest alias, could be custom domain) */
  production_url: string | null;
  /** Staging URL (contains -git-staging-) */
  staging_url: string | null;
}

/**
 * Check Vercel CLI installation and authentication status.
 * @returns CLI status with installed and authenticated flags
 */
export async function checkVercelCliStatus(): Promise<VercelCliStatus> {
  return invoke<VercelCliStatus>('check_vercel_cli_status');
}

/**
 * Get the authenticated Vercel username.
 * @returns Vercel username
 * @throws If not authenticated
 */
export async function getVercelUsername(): Promise<string> {
  return invoke<string>('get_vercel_username');
}

/** A Vercel team/organization */
export interface VercelTeam {
  /** Team ID (e.g., team_xxxxx) */
  id: string;
  /** Team display name */
  name: string;
  /** Whether this is the user's current team */
  is_current: boolean;
}

/**
 * Get list of Vercel teams the user belongs to.
 * @returns Array of teams, empty if user has no teams
 */
export async function getVercelTeams(): Promise<VercelTeam[]> {
  return invoke<VercelTeam[]>('get_vercel_teams');
}

/** A Vercel project */
export interface VercelProject {
  /** Project ID/name */
  id: string;
  /** Project display name */
  name: string;
  /** Organization/team ID */
  orgId: string;
}

/**
 * List Vercel projects for a given scope (team/user).
 * @param scope - Team ID or empty string for personal account
 * @returns Array of projects
 */
export async function listVercelProjects(scope: string): Promise<VercelProject[]> {
  return invoke<VercelProject[]>('list_vercel_projects', { scope });
}

/**
 * Write .vercel/project.json to link a project to Vercel.
 * @param projectPath - Absolute path to the project directory
 * @param projectId - Vercel project ID/name
 * @param orgId - Vercel organization/team ID
 */
export async function writeVercelProjectJson(
  projectPath: string,
  projectId: string,
  orgId: string
): Promise<void> {
  return invoke('write_vercel_project_json', { projectPath, projectId, orgId });
}

/**
 * Get a project's Vercel connection status.
 * @param projectPath - Absolute path to the project directory
 * @returns Vercel connection status with URLs
 */
export async function getProjectVercelStatus(projectPath: string): Promise<ProjectVercelStatus> {
  return invoke<ProjectVercelStatus>('get_project_vercel_status', { projectPath });
}

/**
 * Install the Vercel CLI globally via npm.
 * Runs: npm install -g vercel
 */
export async function installVercelCli(): Promise<void> {
  return invoke('install_vercel_cli');
}

/** Options for linking a project to Vercel */
export interface LinkToVercelOptions {
  /** Absolute path to the project directory */
  projectPath: string;
  /** GitHub repository identifier (e.g., "username/repo-name") */
  githubRepo: string;
}

/**
 * Link a project to Vercel via GitHub integration.
 * Creates a new Vercel project connected to the GitHub repository.
 * @param options - Link configuration
 * @returns Deployment URL
 */
export async function linkToVercel(options: LinkToVercelOptions): Promise<string> {
  return invoke<string>('link_to_vercel', { options });
}

/** Options for deploying a project to Vercel */
export interface DeployToVercelOptions {
  /** Absolute path to the project directory */
  projectPath: string;
  /** Vercel project name */
  projectName: string;
  /** Optional GitHub repository for git integration */
  githubRepo?: string;
  /** Optional team/scope ID to deploy under */
  scope?: string;
}

/**
 * Deploy a project to Vercel.
 * @param options - Deployment configuration
 * @returns Deployment URL
 */
export async function deployToVercel(options: DeployToVercelOptions): Promise<string> {
  return invoke<string>('deploy_to_vercel', { options });
}

/** Information about a single Vercel deployment */
export interface VercelDeployment {
  /** Unique deployment ID */
  uid: string;
  /** Deployment URL */
  url: string;
  /** Deployment state */
  state: string;
  /** Target environment (production or null for preview) */
  target: 'production' | null;
  /** Creation timestamp (Unix ms) */
  created_at: number;
}

/** Status of both staging and production deployments */
export interface VercelDeploymentStatus {
  /** Latest staging deployment */
  staging: VercelDeployment | null;
  /** Latest production deployment */
  production: VercelDeployment | null;
  /** Preview/staging URL */
  preview_url: string | null;
  /** Production URL */
  production_url: string | null;
}

/**
 * Get deployment status for a project.
 * @param projectPath - Absolute path to the project directory
 * @returns Status of staging and production deployments
 */
export async function getVercelDeployments(projectPath: string): Promise<VercelDeploymentStatus> {
  return invoke<VercelDeploymentStatus>('get_vercel_deployments', { projectPath });
}
