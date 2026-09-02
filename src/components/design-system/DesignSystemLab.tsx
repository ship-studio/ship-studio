import { useRef, useState } from 'react';
import { Button, type ButtonSize, type ButtonVariant } from '../primitives/Button';
import { DockablePanel } from '../primitives/DockablePanel';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { EmptyState } from '../primitives/EmptyState';
import { IconButton } from '../primitives/IconButton';
import { MenuButton } from '../primitives/MenuButton';
import { MiddleTruncate } from '../primitives/MiddleTruncate';
import { ModalFrame } from '../primitives/ModalFrame';
import { PanelResizeHandle } from '../primitives/PanelResizeHandle';
import { PixelLoader } from '../primitives/PixelLoader';
import { PropertyField, type PropertyFieldVariant } from '../primitives/PropertyField';
import { Spinner } from '../primitives/Spinner';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../primitives/Tabs';
import { TextButton } from '../primitives/TextButton';
import { TextField } from '../primitives/TextField';
import { ToastList } from '../primitives/ToastList';
import { ToggleButton } from '../primitives/ToggleButton';
import { Tooltip } from '../primitives/Tooltip';
import { ValueField } from '../primitives/ValueField';
import { CopyIcon, InfoIcon, PlusIcon } from '@/components/icons';
import type { Toast } from '../../hooks/useToasts';
import '../../styles/features/design-system-lab.css';

type LabTheme = 'application' | 'recessed';
type LabDensity = 'comfortable' | 'compact';
type LabContent = 'short' | 'long' | 'localized';

const BUTTON_VARIANTS: readonly ButtonVariant[] = [
  'default',
  'primary',
  'secondary',
  'danger',
  'ghost',
  'warning',
  'variable',
];
const BUTTON_SIZES: readonly ButtonSize[] = ['compact', 'default', 'medium', 'large'];
const PROPERTY_VARIANTS: readonly PropertyFieldVariant[] = ['value', 'select', 'variable'];

const THEME_OPTIONS = [
  { value: 'application' as const, label: 'Application' },
  { value: 'recessed' as const, label: 'Recessed' },
];
const DENSITY_OPTIONS = [
  { value: 'comfortable' as const, label: 'Comfortable' },
  { value: 'compact' as const, label: 'Compact' },
];
const CONTENT_OPTIONS = [
  { value: 'short' as const, label: 'Short' },
  { value: 'long' as const, label: 'Long' },
  { value: 'localized' as const, label: 'Localized' },
];

const INITIAL_TOASTS: Toast[] = [
  { id: 1, type: 'success', message: 'Saved successfully' },
  { id: 2, type: 'info', message: 'A new preview is available' },
  { id: 3, type: 'error', message: 'The sample request failed; copy the details' },
];

function labCopy(content: LabContent) {
  if (content === 'localized') return 'Abrir proyecto';
  if (content === 'long') return 'Open the selected project in the current workspace';
  return 'Open project';
}

/** Renders the development-only catalogue of live design-system primitives. */
export function DesignSystemLab() {
  const [theme, setTheme] = useState<LabTheme>('application');
  const [density, setDensity] = useState<LabDensity>('comfortable');
  const [content, setContent] = useState<LabContent>('short');
  const [pressed, setPressed] = useState(false);
  const [menuChoice, setMenuChoice] = useState('Choose an item');
  const [activeTab, setActiveTab] = useState('states');
  const [value, setValue] = useState('12px');
  const [panelWidth, setPanelWidth] = useState(240);
  const [showDockedPanel, setShowDockedPanel] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [toasts, setToasts] = useState(INITIAL_TOASTS);
  const focusFieldRef = useRef<HTMLInputElement>(null);
  const text = labCopy(content);

  const closeLab = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('designSystemLab');
    window.history.replaceState({}, '', url);
    setShowDockedPanel(false);
  };

  return (
    <section
      className="ss-design-system-lab"
      data-lab-theme={theme}
      data-lab-density={density}
      aria-label="Ship Studio development design-system lab"
    >
      <header className="ss-design-system-lab__header">
        <div>
          <p className="ss-design-system-lab__eyebrow">Development only</p>
          <h1 className="ss-design-system-lab__title">Primitive lab</h1>
          <p className="ss-design-system-lab__intro">
            Real Ship Studio primitives, tokens, states, and accessibility contracts.
          </p>
        </div>
        <Button
          variant="ghost"
          size="compact"
          onClick={closeLab}
          aria-label="Close design-system lab"
        >
          Close
        </Button>
      </header>

      <div className="ss-design-system-lab__controls" aria-label="Lab test dimensions">
        <div className="ss-design-system-lab__control">
          <span className="ss-design-system-lab__label">Surface theme</span>
          <Tabs
            value={theme}
            mode="navigation"
            onValueChange={(next) => setTheme(next as LabTheme)}
            size="compact"
          >
            <TabsList aria-label="Surface theme">
              {THEME_OPTIONS.map((option) => (
                <TabsTab key={option.value} value={option.value}>
                  {option.label}
                </TabsTab>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <div className="ss-design-system-lab__control">
          <span className="ss-design-system-lab__label">Density</span>
          <Tabs
            value={density}
            mode="navigation"
            onValueChange={(next) => setDensity(next as LabDensity)}
            size="compact"
          >
            <TabsList aria-label="Density">
              {DENSITY_OPTIONS.map((option) => (
                <TabsTab key={option.value} value={option.value}>
                  {option.label}
                </TabsTab>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <div className="ss-design-system-lab__control">
          <span className="ss-design-system-lab__label">Content</span>
          <Tabs
            value={content}
            mode="navigation"
            onValueChange={(next) => setContent(next as LabContent)}
            size="compact"
          >
            <TabsList aria-label="Content length and language">
              {CONTENT_OPTIONS.map((option) => (
                <TabsTab key={option.value} value={option.value}>
                  {option.label}
                </TabsTab>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>

      <div className="ss-design-system-lab__body">
        <section className="ss-design-system-lab__section" aria-labelledby="lab-actions-title">
          <div className="ss-design-system-lab__section-heading">
            <div>
              <p className="ss-design-system-lab__eyebrow">Actions</p>
              <h2 id="lab-actions-title">Button family</h2>
            </div>
            <span className="ss-design-system-lab__hint">Tab through for focus-visible states</span>
          </div>
          <div className="ss-design-system-lab__stack">
            <div className="ss-design-system-lab__button-grid">
              {BUTTON_VARIANTS.map((variant) => (
                <Button key={variant} variant={variant} size="medium">
                  {variant}
                </Button>
              ))}
            </div>
            <div className="ss-design-system-lab__button-grid">
              {BUTTON_SIZES.map((size) => (
                <Button key={size} variant="secondary" size={size}>
                  {size}
                </Button>
              ))}
            </div>
            <div className="ss-design-system-lab__inline-row">
              <IconButton
                variant="secondary"
                size="medium"
                icon={<PlusIcon size={16} />}
                aria-label="Add item"
              />
              <ToggleButton
                variant="secondary"
                size="medium"
                pressed={pressed}
                onClick={() => setPressed((current) => !current)}
              >
                {pressed ? 'Pressed' : 'Toggle'}
              </ToggleButton>
              <TextButton variant="accent" onClick={() => undefined}>
                {text}
              </TextButton>
            </div>
          </div>
        </section>

        <section className="ss-design-system-lab__section" aria-labelledby="lab-inputs-title">
          <div className="ss-design-system-lab__section-heading">
            <div>
              <p className="ss-design-system-lab__eyebrow">Inputs</p>
              <h2 id="lab-inputs-title">Fields and property controls</h2>
            </div>
            <Button
              size="compact"
              variant="secondary"
              onClick={() => focusFieldRef.current?.focus()}
            >
              Focus field
            </Button>
          </div>
          <div className="ss-design-system-lab__field-grid">
            <label className="ss-design-system-lab__field-label">
              Default
              <TextField
                ref={focusFieldRef}
                aria-label="Default project name"
                value={content === 'localized' ? 'Nombre del proyecto' : 'Project name'}
                onChange={() => undefined}
              />
            </label>
            <label className="ss-design-system-lab__field-label">
              Compact / code
              <TextField
                className="ss-text-field--compact ss-text-field--code"
                aria-label="Command"
                defaultValue="pnpm check:all"
              />
            </label>
            <label className="ss-design-system-lab__field-label">
              Invalid
              <TextField
                aria-label="Invalid project name"
                value=""
                invalid
                onChange={() => undefined}
              />
            </label>
            <label className="ss-design-system-lab__field-label">
              Disabled
              <TextField aria-label="Disabled project name" value={text} disabled readOnly />
            </label>
          </div>
          <div className="ss-design-system-lab__inline-row">
            {PROPERTY_VARIANTS.map((variant) => (
              <PropertyField key={variant} variant={variant} aria-label={`${variant} property`}>
                {variant}
              </PropertyField>
            ))}
            <ValueField
              aria-label="Spacing value"
              value={value}
              variant="length"
              onCommit={(nextValue) => {
                setValue(nextValue);
                return true;
              }}
            />
          </div>
        </section>

        <section className="ss-design-system-lab__section" aria-labelledby="lab-navigation-title">
          <div className="ss-design-system-lab__section-heading">
            <div>
              <p className="ss-design-system-lab__eyebrow">Navigation</p>
              <h2 id="lab-navigation-title">Menus, segmented choices, and tabs</h2>
            </div>
            <span className="ss-design-system-lab__hint">
              Arrow keys and Escape are part of the contract
            </span>
          </div>
          <div className="ss-design-system-lab__inline-row">
            <Dropdown
              align="left"
              trigger={(props) => (
                <MenuButton size="medium" expanded={props['aria-expanded']} {...props}>
                  Menu
                </MenuButton>
              )}
            >
              <DropdownItem onSelect={() => setMenuChoice('Open')}>Open</DropdownItem>
              <DropdownItem onSelect={() => setMenuChoice('Duplicate')}>Duplicate</DropdownItem>
              <DropdownDivider />
              <DropdownItem variant="danger" onSelect={() => setMenuChoice('Delete')}>
                Delete
              </DropdownItem>
            </Dropdown>
            <span className="ss-design-system-lab__readout">{menuChoice}</span>
          </div>
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList aria-label="Primitive lab panels" appearance="underline">
              <TabsTab value="states">States</TabsTab>
              <TabsTab value="guidance">Guidance</TabsTab>
              <TabsTab value="disabled" disabled>
                Disabled
              </TabsTab>
            </TabsList>
            <TabsPanel value="states">
              <p className="ss-design-system-lab__panel-copy">
                Active tab content stays visible and keyboard reachable.
              </p>
            </TabsPanel>
            <TabsPanel value="guidance">
              <p className="ss-design-system-lab__panel-copy">
                Tabs can drive compact choices as well as panel navigation.
              </p>
            </TabsPanel>
          </Tabs>
        </section>

        <section className="ss-design-system-lab__section" aria-labelledby="lab-status-title">
          <div className="ss-design-system-lab__section-heading">
            <div>
              <p className="ss-design-system-lab__eyebrow">Status and overlays</p>
              <h2 id="lab-status-title">Loading, empty, tooltip, toast, and modal contracts</h2>
            </div>
            <Tooltip content="The tooltip uses the shared app provider">
              <IconButton
                variant="ghost"
                size="compact"
                icon={<InfoIcon size={14} />}
                aria-label="Tooltip example"
              />
            </Tooltip>
          </div>
          <div className="ss-design-system-lab__spinner-row" aria-label="Spinner sizes">
            <span>
              <Spinner size="sm" /> sm
            </span>
            <span>
              <Spinner size="md" /> md
            </span>
            <span>
              <Spinner size="lg" /> lg
            </span>
          </div>
          <div className="ss-design-system-lab__pixel-loader-showcase" aria-label="Pixel loaders">
            <span>
              <PixelLoader size="lg" variant="ripple" /> Ripple
            </span>
            <span>
              <PixelLoader size="lg" variant="ripple-isolated" /> Isolated ripple
            </span>
            <span>
              <PixelLoader size="lg" variant="ripple-decay" /> Decay ripple
            </span>
            <span>
              <PixelLoader size="lg" variant="ripple-quad" /> 2×2 core
            </span>
            <span>
              <PixelLoader size="lg" variant="ripple-quad-tight" /> 2×2 core tight
            </span>
            <span>
              <PixelLoader size="lg" variant="scan" /> Scan
            </span>
            <span>
              <PixelLoader size="lg" variant="spark" /> Spark
            </span>
          </div>
          <EmptyState
            icon={<InfoIcon size={24} />}
            title={content === 'localized' ? 'Sin resultados' : 'No results'}
            description={
              content === 'long'
                ? 'This intentionally long description checks wrapping, readable line length, and empty-state spacing across the available surface.'
                : 'Try another search.'
            }
            action={<Button size="compact">Reset search</Button>}
          />
          <div className="ss-design-system-lab__inline-row">
            <Button
              variant="secondary"
              size="compact"
              onClick={() =>
                setToasts((current) => [
                  ...current,
                  { id: Date.now(), type: 'info', message: text },
                ])
              }
            >
              Add toast
            </Button>
            <Button variant="secondary" size="compact" onClick={() => setModalOpen(true)}>
              Open modal
            </Button>
            <Button variant="ghost" size="compact" onClick={() => setToasts([])}>
              Clear toasts
            </Button>
          </div>
          <ToastList
            toasts={toasts}
            onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))}
          />
          <ModalFrame
            isOpen={modalOpen}
            onClose={() => setModalOpen(false)}
            title="Primitive lab modal"
            ariaLabel="Primitive lab modal"
          >
            <p className="ss-design-system-lab__panel-copy">
              Focus is trapped here until Escape or the close button is used.
            </p>
            <Button variant="primary" onClick={() => setModalOpen(false)}>
              Close modal
            </Button>
          </ModalFrame>
        </section>

        <section className="ss-design-system-lab__section" aria-labelledby="lab-layout-title">
          <div className="ss-design-system-lab__section-heading">
            <div>
              <p className="ss-design-system-lab__eyebrow">Layout and typography</p>
              <h2 id="lab-layout-title">Resizing, docking, truncation, and token themes</h2>
            </div>
            <span className="ss-design-system-lab__readout">Panel value: {panelWidth}</span>
          </div>
          <div className="ss-design-system-lab__resize-demo">
            <span className="ss-design-system-lab__resize-demo-content">
              Keyboard-resize this separator
            </span>
            <PanelResizeHandle
              value={panelWidth}
              min={160}
              max={360}
              label="Resize lab panel"
              onResize={setPanelWidth}
              onResizeBy={(delta) =>
                setPanelWidth((current) => Math.min(360, Math.max(160, current + delta)))
              }
            />
          </div>
          <div className="ss-design-system-lab__truncate-demo">
            <MiddleTruncate
              text={
                content === 'long'
                  ? 'A very long project path that should preserve the beginning and the end while the middle gives way'
                  : '/Users/martin/ShipStudio/project'
              }
              aria-label="Project path preview"
            />
          </div>
          <div className="ss-design-system-lab__inline-row">
            <ToggleButton
              variant="secondary"
              size="compact"
              pressed={showDockedPanel}
              onClick={() => setShowDockedPanel((current) => !current)}
            >
              {showDockedPanel ? 'Hide docked panel' : 'Show docked panel'}
            </ToggleButton>
            <span className="ss-design-system-lab__hint">
              The DockablePanel stays mounted while visibility changes.
            </span>
          </div>
          <DockablePanel
            docked
            visible={showDockedPanel}
            ariaLabel="Primitive lab docked panel"
            positionKey="shipstudio.design-system-lab.position"
            sizeKey="shipstudio.design-system-lab.size"
            floatingSize={{ width: 240, height: 160 }}
            initialPosition={() => ({ left: 40, top: 40 })}
            resizable={false}
          >
            <div className="ss-design-system-lab__docked-content">
              <strong>Docked panel</strong>
              <span>Stateful content remains mounted.</span>
            </div>
          </DockablePanel>
          <div className="ss-design-system-lab__token-grid" aria-label="Semantic token themes">
            {[
              ['app', 'surface-app'],
              ['panel', 'surface-panel'],
              ['control', 'surface-control'],
              ['selected', 'surface-selected'],
              ['recessed', 'surface-recessed'],
              ['accent', 'accent-active'],
            ].map(([key, token]) => (
              <div
                className={`ss-design-system-lab__token ss-design-system-lab__token--${key}`}
                key={token}
              >
                <span className="ss-design-system-lab__token-swatch" aria-hidden="true" />
                <span>{token}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="ss-design-system-lab__section" aria-labelledby="lab-content-title">
          <div className="ss-design-system-lab__section-heading">
            <div>
              <p className="ss-design-system-lab__eyebrow">Typography</p>
              <h2 id="lab-content-title">Semantic text roles under pressure</h2>
            </div>
          </div>
          <div className="ss-design-system-lab__type-samples">
            <h3>Heading treatment balances short titles</h3>
            <p className="ss-design-system-lab__body-copy">
              {content === 'localized'
                ? 'Los estilos de texto deben seguir roles semánticos y conservar una lectura clara en todos los idiomas.'
                : content === 'long'
                  ? 'This paragraph deliberately includes enough content to inspect readable wrapping, supporting copy rhythm, and the difference between semantic body roles and component labels.'
                  : 'Body copy uses the semantic text role rather than a raw primitive font size.'}
            </p>
            <span className="ss-design-system-lab__label">Label / button / menu item</span>
            <code className="ss-design-system-lab__code">
              var(--font-size-body-md) → semantic role
            </code>
          </div>
          <div className="ss-design-system-lab__lab-note">
            <CopyIcon size={14} />
            <span>
              Use this lab to inspect real wrapping, focus, density, and state combinations before
              changing a primitive.
            </span>
          </div>
        </section>
      </div>
    </section>
  );
}
