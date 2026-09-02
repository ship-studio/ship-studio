/**
 * Project container detection (Docker).
 *
 * Wraps the `*_project_container(s)` Tauri commands. A container belongs to a
 * project only when a path-carrying label proves it (Docker Compose's
 * `working_dir` label or a devcontainer's `local_folder` label) — the backend
 * never guesses from name similarity, so everything surfaced here is reliably
 * the project's own.
 *
 * @module lib/containers
 */

import { invoke } from '@tauri-apps/api/core';

/** Availability of the Docker engine on this machine. */
export type ContainerEngineStatus = 'ok' | 'not-installed' | 'not-running';

/** A single host→container published port. */
export interface PortMapping {
  hostPort: number;
  containerPort: number;
  protocol: string;
}

/** A container attributed to the project. */
export interface ContainerInfo {
  /** Full (untruncated) container id. */
  id: string;
  name: string;
  image: string;
  /** Engine state: `running`, `exited`, `paused`, `restarting`, `created`… */
  state: string;
  /** Human status line from `docker ps`, e.g. "Up 2 hours". */
  status: string;
  /** Compose service name, when the container came from a compose file. */
  service: string | null;
  /** Compose project name, when applicable. */
  composeProject: string | null;
  ports: PortMapping[];
}

/** Result of a project container scan. */
export interface ProjectContainers {
  engine: ContainerEngineStatus;
  containers: ContainerInfo[];
}

/** Raw shape returned by the backend (snake_case fields). */
interface RawContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  service: string | null;
  compose_project: string | null;
  ports: { host_port: number; container_port: number; protocol: string }[];
}

/**
 * List the containers that belong to a project, plus engine availability
 * (so callers can tell "no containers" apart from "Docker isn't running").
 * @param projectPath - Absolute path to the project
 */
export async function listProjectContainers(projectPath: string): Promise<ProjectContainers> {
  const raw = await invoke<{ engine: ContainerEngineStatus; containers: RawContainerInfo[] }>(
    'list_project_containers',
    { projectPath }
  );
  return {
    engine: raw.engine,
    containers: raw.containers.map((c) => ({
      id: c.id,
      name: c.name,
      image: c.image,
      state: c.state,
      status: c.status,
      service: c.service,
      composeProject: c.compose_project,
      ports: c.ports.map((p) => ({
        hostPort: p.host_port,
        containerPort: p.container_port,
        protocol: p.protocol,
      })),
    })),
  };
}

/** Start a stopped container that belongs to the project. */
export async function startContainer(projectPath: string, containerId: string): Promise<void> {
  return invoke('start_project_container', { projectPath, containerId });
}

/** Stop a running container that belongs to the project. */
export async function stopContainer(projectPath: string, containerId: string): Promise<void> {
  return invoke('stop_project_container', { projectPath, containerId });
}

/** Restart a container that belongs to the project. */
export async function restartContainer(projectPath: string, containerId: string): Promise<void> {
  return invoke('restart_project_container', { projectPath, containerId });
}

/** True while the container can be stopped (i.e. the action is "stop"). */
export function isContainerRunning(container: Pick<ContainerInfo, 'state'>): boolean {
  return container.state === 'running' || container.state === 'restarting';
}

/**
 * Row label: the compose service name reads best ("db", "redis"); fall back
 * to the container name for devcontainers and anything unnamed-by-compose.
 */
export function containerLabel(container: Pick<ContainerInfo, 'name' | 'service'>): string {
  return container.service ?? container.name;
}

/**
 * Sidebar dot state for a container's engine state — same vocabulary as the
 * agent/terminal rows so the sidebar speaks one language.
 */
export function containerDotState(
  state: string
): 'idle' | 'active' | 'thinking' | 'attention' | 'muted' {
  switch (state) {
    case 'running':
      return 'active';
    case 'restarting':
      return 'attention';
    case 'paused':
      return 'idle';
    default: // created, exited, dead, removing
      return 'muted';
  }
}

/**
 * Compact meta text for a container row. Running containers show their
 * published host ports (":5432"); everything else shows the engine state.
 * Only data reported by Docker is shown — a port is never assumed.
 */
export function containerMeta(
  container: Pick<ContainerInfo, 'state' | 'ports'>
): string | undefined {
  if (!isContainerRunning(container)) return container.state;
  if (container.ports.length === 0) return undefined;
  return container.ports.map((p) => `:${p.hostPort}`).join(' ');
}
