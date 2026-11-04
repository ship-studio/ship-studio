/**
 * Fails `tsc` when the companion's copy of a desktop type drifts from the
 * desktop's own (src/lib/agents.ts, src/lib/git.ts, src/lib/errors.ts).
 * Type-only: nothing here exists at runtime, and the package's index doesn't
 * export it, so the Expo app never sees the desktop imports.
 *
 * Checked by `pnpm typecheck` (which includes this package's tsconfig).
 */

import type * as Desktop from '../../../src/lib/agents';
import type { FileDiff as DesktopFileDiff } from '../../../src/lib/git';
import type { CommandError as DesktopCommandError } from '../../../src/lib/errors';
import type * as Wire from './model';
import type { CommandError } from './frames';

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type Conformance = [
  Assert<Same<Wire.Agent, Desktop.Agent>>,
  Assert<Same<Wire.AgentMessage, Desktop.AgentMessage>>,
  Assert<Same<Wire.AgentsOverview, Desktop.AgentsOverview>>,
  Assert<Same<Wire.AgentStatus, Desktop.AgentStatus>>,
  Assert<Same<Wire.Approval, Desktop.Approval>>,
  Assert<Same<Wire.Attachment, Desktop.Attachment>>,
  Assert<Same<Wire.SharedFile, Desktop.SharedFile>>,
  Assert<Same<Wire.CheckIn, Desktop.CheckIn>>,
  Assert<Same<Wire.SchedulePreview, Desktop.SchedulePreview>>,
  Assert<Same<Wire.NewAgentInput, Desktop.NewAgentInput>>,
  Assert<Same<Wire.UpdateAgentInput, Desktop.UpdateAgentInput>>,
  Assert<Same<Wire.SearchHit, Desktop.SearchHit>>,
  Assert<Same<Wire.UsageSummary, Desktop.UsageSummary>>,
  Assert<Same<Wire.PasteImportPreview, Desktop.PasteImportPreview>>,
  Assert<Same<Wire.ImportSummary, Desktop.ImportSummary>>,
  Assert<Same<Wire.FileDiff, DesktopFileDiff>>,
  Assert<Same<CommandError, DesktopCommandError>>,
  Assert<Same<typeof Wire.MAX_ATTACHMENTS, typeof Desktop.MAX_ATTACHMENTS>>,
  Assert<Same<typeof Wire.MAX_ATTACHMENT_BYTES, typeof Desktop.MAX_ATTACHMENT_BYTES>>,
];
