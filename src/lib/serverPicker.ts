export const SERVER_PICKER_EVENT = 'ship:pick-server-directory';

export interface ServerPickerRequest {
  title: string;
  resolve: (path: string | null) => void;
}

export function pickServerDirectory(title: string): Promise<string | null> {
  return new Promise((resolve) => {
    window.dispatchEvent(
      new CustomEvent<ServerPickerRequest>(SERVER_PICKER_EVENT, { detail: { title, resolve } })
    );
  });
}
