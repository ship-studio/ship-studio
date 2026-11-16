import type { BackgroundLayerKind } from '../../lib/cssBackgroundImage';

export const DEFAULT_COLOR = '#8b5cf6';
export const LINEAR_ANGLE_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:deg|rad|turn)$/i;
export const RADIAL_EXTENTS = [
  'closest-side',
  'farthest-side',
  'closest-corner',
  'farthest-corner',
] as const;

export function normalizeDegrees(value: number): number {
  return ((Math.round(value) % 360) + 360) % 360;
}

export function angleDegrees(value: string): number {
  const angle = value.trim().toLowerCase();
  const directions: Record<string, number> = {
    'to top': 0,
    'to top right': 45,
    'to right top': 45,
    'to right': 90,
    'to bottom right': 135,
    'to right bottom': 135,
    'to bottom': 180,
    'to bottom left': 225,
    'to left bottom': 225,
    'to left': 270,
    'to top left': 315,
    'to left top': 315,
  };
  if (directions[angle] !== undefined) return directions[angle];
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(deg|rad|turn)$/i.exec(angle);
  if (!match) return 90;
  const numeric = Number(match[1]);
  return normalizeDegrees(
    match[2].toLowerCase() === 'rad'
      ? (numeric * 180) / Math.PI
      : match[2].toLowerCase() === 'turn'
        ? numeric * 360
        : numeric
  );
}

export function reverseStopPosition(position: string): string {
  const percent = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))%$/.exec(position.trim());
  if (!percent) return position;
  const reversed = 100 - Number(percent[1]);
  return `${Number.isInteger(reversed) ? reversed : Number(reversed.toFixed(4))}%`;
}

export function parseRadialPrelude(prelude: string): {
  shape: 'circle' | 'ellipse';
  extent: string;
  position: string;
  x: string;
  y: string;
} {
  const parts = /^(.+?)\s+at\s+(.+)$/i.exec(prelude.trim());
  const geometry = (parts?.[1] ?? prelude).trim();
  const position = (parts?.[2] ?? 'center center').trim();
  const shape = /\bcircle\b/i.test(geometry) ? 'circle' : 'ellipse';
  const extent =
    RADIAL_EXTENTS.find((item) => geometry.toLowerCase().includes(item)) ??
    (geometry.replace(/\b(?:circle|ellipse)\b/i, '').trim() || 'farthest-corner');
  const coordinates = position.split(/\s+/);
  const xMap: Record<string, string> = { left: '0%', center: '50%', right: '100%' };
  const yMap: Record<string, string> = { top: '0%', center: '50%', bottom: '100%' };
  const x =
    xMap[coordinates[0]] ??
    (/^-?(?:\d+(?:\.\d*)?|\.\d+)%$/.test(coordinates[0]) ? coordinates[0] : '50%');
  const y =
    yMap[coordinates[1] ?? coordinates[0]] ??
    (/^-?(?:\d+(?:\.\d*)?|\.\d+)%$/.test(coordinates[1] ?? '') ? coordinates[1] : '50%');
  return { shape, extent, position, x, y };
}

export function gradientValue(
  kind: BackgroundLayerKind,
  prelude: string,
  stops: Array<{ color: string; position: string }>,
  repeating = false
) {
  const name = `${repeating ? 'repeating-' : ''}${kind === 'radial' ? 'radial' : 'linear'}-gradient`;
  const body = [
    prelude,
    ...stops.map((stop) => `${stop.color}${stop.position ? ` ${stop.position}` : ''}`),
  ]
    .filter(Boolean)
    .join(', ');
  return `${name}(${body})`;
}

export function initialValue(kind: BackgroundLayerKind): string {
  if (kind === 'linear') return 'linear-gradient(90deg, #8b5cf6 0%, #ec4899 100%)';
  if (kind === 'radial') return 'radial-gradient(circle at center, #8b5cf6 0%, #ec4899 100%)';
  if (kind === 'solid') return `linear-gradient(${DEFAULT_COLOR}, ${DEFAULT_COLOR})`;
  return '';
}
