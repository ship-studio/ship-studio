/** Updater plugin; the harness never has an update available. */
export function check(): Promise<null> {
  return Promise.resolve(null);
}
