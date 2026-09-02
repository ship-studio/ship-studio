const CSS_VARIABLE_TOKEN = /(?:var\(\s*--[\w-]+(?:\s*,\s*[^()]*(?:\([^)]*\)[^()]*)*)?\)|--[\w-]+)/g;

/** Render CSS values while highlighting custom-property references. */
export function CssValueText({ value }: { value: string }) {
  const parts = value.split(CSS_VARIABLE_TOKEN);
  const matches = value.match(CSS_VARIABLE_TOKEN) ?? [];

  return (
    <span className="ss-css-value-text">
      {parts.reduce<React.ReactNode[]>((output, part, index) => {
        if (part) output.push(part);
        const variable = matches[index];
        if (variable) {
          output.push(
            <span key={`variable-${index}`} className="ss-css-variable">
              {variable}
            </span>
          );
        }
        return output;
      }, [])}
    </span>
  );
}
