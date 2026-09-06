/** Guard batch pastes against setup/permission menus and busy agent sessions. */
export function assertPromptReady(screen: string, thinking: boolean): void {
  if (thinking) throw new Error('This agent is busy. Wait for its prompt before sending comments.');
  const visible = screen.replace(/\s+/g, ' ');
  if (
    /trust (?:this |the )?(?:folder|directory|workspace)|accessing workspace|enter to confirm|select (?:a )?login|sign in to continue|log in to continue|allow once|allow always|do you want to proceed/i.test(
      visible
    )
  ) {
    throw new Error(
      'Finish the setup or permission prompt in the terminal, then send your comments. They are still pending.'
    );
  }
}

/** Strip terminal control bytes; keep newlines inside the bracketed paste. */
export function bracketedPrompt(text: string): string {
  const clean = Array.from(text)
    .filter(
      (char) =>
        char === '\n' || char === '\t' || (char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
    )
    .join('');
  return `\x1b[200~${clean}\x1b[201~`;
}
