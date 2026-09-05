/**
 * TEMPORARY development harness — not part of the app. Mounts the real
 * PreviewCanvas with the real stylesheets inside a box the size of the real
 * preview pane, so the canvas can be driven and measured in a browser.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { PreviewCanvas, type CanvasZoom } from './components/preview/PreviewCanvas';
import { DEVICE_HEIGHTS } from './lib/previewCanvas';

const FRAMES = [
  { id: 'desktop', label: 'Desktop', width: 1440 },
  { id: 'laptop', label: 'Laptop', width: 1024 },
  { id: 'tablet', label: 'Tablet', width: 768 },
  { id: 'mobile', label: 'Mobile', width: 375 },
].map((frame) => ({ ...frame, height: DEVICE_HEIGHTS[frame.id] ?? 800 }));

function Lab() {
  const [zoom, setZoom] = useState<CanvasZoom>('fit');
  const [active, setActive] = useState('desktop');
  const [paneWidth, setPaneWidth] = useState(813);
  const [paneHeight, setPaneHeight] = useState(645);

  return (
    <div style={{ padding: 16, background: '#101010', minHeight: '100vh' }}>
      <div style={{ color: '#ddd', font: '12px monospace', marginBottom: 8 }}>
        pane{' '}
        <input
          id="pw"
          value={paneWidth}
          onChange={(event) => setPaneWidth(Number(event.target.value) || 0)}
          style={{ width: 60 }}
        />
        ×
        <input
          id="ph"
          value={paneHeight}
          onChange={(event) => setPaneHeight(Number(event.target.value) || 0)}
          style={{ width: 60 }}
        />{' '}
        · zoom {String(zoom)} · active {active}
      </div>
      {/* The real preview pane: a flex column whose viewport centres its child. */}
      <div
        className="preview-container"
        id="pane"
        style={{
          width: paneWidth,
          height: paneHeight,
          display: 'flex',
          flexDirection: 'column',
          border: '1px solid #444',
        }}
      >
        <div className="preview-viewport">
          <PreviewCanvas
            frames={FRAMES}
            url="http://localhost:4599/"
            navSignal="/"
            activeFrameId={active}
            reloadToken={0}
            zoom={zoom}
            onZoomChange={setZoom}
            onActivateFrame={(id) => setActive(id)}
            onActiveFrameElement={() => {}}
          />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('lab')!).render(<Lab />);
