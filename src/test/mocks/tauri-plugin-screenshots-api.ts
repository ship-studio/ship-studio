/**
 * Mock for tauri-plugin-screenshots-api package
 */
export const screenshot = () => Promise.resolve(new Uint8Array());

export default { screenshot };
