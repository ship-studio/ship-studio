declare module 'node:fs' {
  export function readFileSync(file: string, encoding: 'utf8'): string;
}

declare module 'node:path' {
  export function resolve(...paths: string[]): string;
}

declare module 'jsdom' {
  export interface JSDOMWindow extends Window {
    close(): void;
  }

  export class JSDOM {
    constructor(html?: string);
    readonly window: JSDOMWindow;
  }
}
