/** Native screenshot plugin; inert in the browser harness. */
export function screenshot(): Promise<Uint8Array> {
  return Promise.resolve(new Uint8Array());
}
export default { screenshot };
