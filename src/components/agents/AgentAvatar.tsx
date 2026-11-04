/**
 * An agent's face: one rounded tile in one of eleven colours, with one of
 * fourteen expressions. Identity lives in the face, not the silhouette.
 *
 * @module components/agents/AgentAvatar
 */

import type { ComponentType, SVGProps } from 'react';
import DotsFace from '@/assets/graphics/agents/agent-avatar-dots.svg?react';
import HappyFace from '@/assets/graphics/agents/agent-avatar-happy.svg?react';
import VisorFace from '@/assets/graphics/agents/agent-avatar-visor.svg?react';
import CyclopsFace from '@/assets/graphics/agents/agent-avatar-cyclops.svg?react';
import GlassesFace from '@/assets/graphics/agents/agent-avatar-glasses.svg?react';
import WinkFace from '@/assets/graphics/agents/agent-avatar-wink.svg?react';
import SleepyFace from '@/assets/graphics/agents/agent-avatar-sleepy.svg?react';
import SquareFace from '@/assets/graphics/agents/agent-avatar-square.svg?react';
import SurprisedFace from '@/assets/graphics/agents/agent-avatar-surprised.svg?react';
import PlusFace from '@/assets/graphics/agents/agent-avatar-plus.svg?react';
import TrioFace from '@/assets/graphics/agents/agent-avatar-trio.svg?react';
import SmirkFace from '@/assets/graphics/agents/agent-avatar-smirk.svg?react';
import BrowsFace from '@/assets/graphics/agents/agent-avatar-brows.svg?react';
import ShadesFace from '@/assets/graphics/agents/agent-avatar-shades.svg?react';

/** Index order is persisted (`shape` in the registry). Append only. */
export const AVATAR_SHAPES: ComponentType<SVGProps<SVGSVGElement>>[] = [
  DotsFace,
  HappyFace,
  VisorFace,
  CyclopsFace,
  GlassesFace,
  WinkFace,
  SleepyFace,
  SquareFace,
  SurprisedFace,
  PlusFace,
  TrioFace,
  SmirkFace,
  BrowsFace,
  ShadesFace,
];

interface AgentAvatarProps {
  shape: number;
  color: string;
  size?: number;
  /** Pulses while the agent works, so a glance at the sidebar says who's busy. */
  working?: boolean;
  className?: string;
}

export function AgentAvatar({
  shape,
  color,
  size = 32,
  working = false,
  className,
}: AgentAvatarProps) {
  const Shape = AVATAR_SHAPES[shape] ?? AVATAR_SHAPES[0];
  return (
    <span
      className={`agent-avatar${working ? ' agent-avatar--working' : ''}${className ? ` ${className}` : ''}`}
      data-color={color}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <Shape width={size} height={size} />
    </span>
  );
}
