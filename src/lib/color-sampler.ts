import { invoke } from '@tauri-apps/api/core';

export interface ColorSamplerSupport {
  available: boolean;
  reason: string | null;
}

export function getColorSamplerSupport(): Promise<ColorSamplerSupport> {
  return invoke<ColorSamplerSupport>('get_color_sampler_support');
}

export function sampleScreenColor(): Promise<string | null> {
  return invoke<string | null>('sample_screen_color');
}
