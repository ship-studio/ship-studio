/**
 * PhoneQr — the pairing QR code, drawn on a canvas from the module matrix
 * the Mac computed. Ink and paper come from the element's own CSS (`color`
 * and `background-color`), so the colours stay tokens; the paper is light
 * in both themes because phone cameras read dark-on-light most reliably.
 *
 * @module components/phone/PhoneQr
 */

import { useEffect, useRef } from 'react';

/** Blank modules around the code, as the QR spec asks for. */
const QUIET_ZONE = 4;

interface PhoneQrProps {
  size: number;
  /** Row by row, `1` for a dark module. */
  modules: string;
  /** Rendered width and height in CSS pixels. */
  pixels?: number;
  label: string;
}

export function PhoneQr({ size, modules, pixels = 228, label }: PhoneQrProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(pixels * ratio);
    canvas.height = Math.round(pixels * ratio);
    const style = getComputedStyle(canvas);
    const total = size + QUIET_ZONE * 2;
    const unit = canvas.width / total;
    ctx.fillStyle = style.backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = style.color;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (modules[y * size + x] !== '1') continue;
        // Whole device pixels on both edges, so neighbouring modules never
        // leave a hairline between them.
        const left = Math.round((x + QUIET_ZONE) * unit);
        const top = Math.round((y + QUIET_ZONE) * unit);
        const right = Math.round((x + QUIET_ZONE + 1) * unit);
        const bottom = Math.round((y + QUIET_ZONE + 1) * unit);
        ctx.fillRect(left, top, right - left, bottom - top);
      }
    }
  }, [size, modules, pixels]);

  return (
    <canvas
      ref={canvasRef}
      className="phone-qr"
      style={{ width: pixels, height: pixels }}
      role="img"
      aria-label={label}
    />
  );
}
