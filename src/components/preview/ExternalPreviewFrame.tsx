/** Sandboxed surface for URLs outside the project's local dev-server origin. */
export function ExternalPreviewFrame({ url, reloadToken }: { url: string; reloadToken: number }) {
  return (
    <iframe
      key={`${url}:${reloadToken}`}
      className="preview-external-frame"
      title={`External preview: ${url}`}
      src={url}
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
    />
  );
}
