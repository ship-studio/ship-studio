import { useState, useEffect } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { detectClientEditor } from '../lib/client-editor';
import { UsersIcon } from './icons';
import { Button } from './primitives/Button';
import { ModalFrame } from './primitives/ModalFrame';

const DASHBOARD_URL = 'https://www.ship.studio/dashboard/projects';

interface ClientEditorButtonProps {
  projectPath: string;
}

export function ClientEditorButton({ projectPath }: ClientEditorButtonProps) {
  const [hasEditor, setHasEditor] = useState<boolean | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    void detectClientEditor(projectPath)
      .then(setHasEditor)
      .catch(() => setHasEditor(false));
  }, [projectPath]);

  if (hasEditor === null) return null;

  if (hasEditor) {
    return (
      <button
        className="toolbar-icon-btn"
        data-education-id="client-editor-button"
        onClick={() => void openUrl(DASHBOARD_URL)}
        title="Manage client editor"
      >
        <UsersIcon size={12} />
      </button>
    );
  }

  return (
    <>
      <button
        className="toolbar-icon-btn"
        data-education-id="client-editor-button"
        onClick={() => {
          setStep(0);
          setShowModal(true);
        }}
        title="Add client editing"
      >
        <UsersIcon size={12} />
        <span>Add Clients</span>
      </button>

      <ModalFrame
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        className="client-editor-modal"
        ariaLabel="Client Editor"
      >
        {step === 0 && (
          <>
            <div className="client-editor-modal-icon">
              <UsersIcon size={24} />
            </div>
            <h3>
              Client Editor <span style={{ fontWeight: 400, opacity: 0.5 }}>Beta</span>
            </h3>
            <p>
              Let your clients update text, images, and metadata directly on their live site — no
              code, no CMS, no training required.
            </p>
            <p>
              Works with any stack. You add one script tag, and they get an inline editing
              experience that commits changes straight to your repo.
            </p>
            <p className="client-editor-pricing">
              <strong>$10/month per client seat.</strong> Your developer seat is free for now, but
              this may change in the future.
            </p>
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setShowModal(false)}>
                Close
              </Button>
              <Button variant="primary" onClick={() => setStep(1)}>
                Continue
              </Button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h3>How it works</h3>
            <div className="client-editor-steps">
              <div className="client-editor-step">
                <span className="client-editor-step-num">1</span>
                <div>
                  <strong>Enable the editor</strong>
                  <p>Connect your project and enter your site URL on the Ship Studio dashboard.</p>
                </div>
              </div>
              <div className="client-editor-step">
                <span className="client-editor-step-num">2</span>
                <div>
                  <strong>Add the script tag</strong>
                  <p>
                    Drop a single {'<script>'} tag into your layout. It's invisible to visitors —
                    only activates when your client opens the editor.
                  </p>
                </div>
              </div>
              <div className="client-editor-step">
                <span className="client-editor-step-num">3</span>
                <div>
                  <strong>Invite your client</strong>
                  <p>
                    They'll get a branded email with a link to start editing. Edits become PRs in
                    your repo automatically.
                  </p>
                </div>
              </div>
            </div>
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setStep(0)}>
                Back
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setShowModal(false);
                  void openUrl(DASHBOARD_URL);
                }}
              >
                Get Started
              </Button>
            </div>
          </>
        )}
      </ModalFrame>
    </>
  );
}
