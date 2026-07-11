import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';

/** Writes a string into an agent terminal's PTY (keystrokes; include `\r` to submit). */
type AgentWriter = (data: string) => void;

export interface AgentBridge {
  /** Called by the focused agent terminal to register/replace its PTY writer. */
  registerAgent: (writer: AgentWriter) => void;
  /** Called when an agent terminal blurs/unmounts; only clears if it still owns the slot. */
  unregisterAgent: (writer: AgentWriter) => void;
  /** Whether an agent terminal is currently available to receive a prompt. */
  hasAgent: () => boolean;
  /** Inject `text` into the focused agent and submit it (appends a return). Returns
   *  false when no agent is connected, so callers can prompt the user to open one. */
  sendToAgent: (text: string) => boolean;
}

const AgentBridgeContext = createContext<AgentBridge | null>(null);

/**
 * A tiny bus between the visual editors ("Send to agent") and whichever agent
 * terminal is focused. The terminal owns its PTY session id internally, so instead
 * of plumbing that id across the tree, the focused terminal registers a writer here
 * and feature code calls `sendToAgent(prompt)`. Last registrant wins (the focused
 * tab), mirroring "inject into the terminal the user is looking at".
 */
export function AgentBridgeProvider({ children }: { children: ReactNode }) {
  const writerRef = useRef<AgentWriter | null>(null);

  const registerAgent = useCallback((writer: AgentWriter) => {
    writerRef.current = writer;
  }, []);

  const unregisterAgent = useCallback((writer: AgentWriter) => {
    // Only clear if this exact writer still owns the slot — a newly-focused tab may
    // have already taken over, and we mustn't wipe its registration.
    if (writerRef.current === writer) writerRef.current = null;
  }, []);

  const hasAgent = useCallback(() => writerRef.current !== null, []);

  const sendToAgent = useCallback((text: string) => {
    const writer = writerRef.current;
    if (!writer) return false;
    // `\r` submits the prompt in the agent's REPL (xterm treats CR as Enter).
    writer(text.endsWith('\r') ? text : `${text}\r`);
    return true;
  }, []);

  const value = useMemo<AgentBridge>(
    () => ({ registerAgent, unregisterAgent, hasAgent, sendToAgent }),
    [registerAgent, unregisterAgent, hasAgent, sendToAgent]
  );

  return <AgentBridgeContext.Provider value={value}>{children}</AgentBridgeContext.Provider>;
}

/** Stable no-op bridge for code paths rendered outside the provider (tests, stories). */
const NOOP_BRIDGE: AgentBridge = {
  registerAgent: () => {},
  unregisterAgent: () => {},
  hasAgent: () => false,
  sendToAgent: () => false,
};

/** Access the agent bridge. Returns a no-op bridge when no provider is in scope. */
export function useAgentBridge(): AgentBridge {
  return useContext(AgentBridgeContext) ?? NOOP_BRIDGE;
}
