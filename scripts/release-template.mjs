const placeholderPattern = /{{([a-z][a-z0-9_]*)}}/g;

export function renderMarkdownTemplate({ label, template, view }) {
  if (
    typeof label !== 'string' ||
    label.length === 0 ||
    typeof template !== 'string' ||
    template.trim().length === 0 ||
    view === null ||
    typeof view !== 'object' ||
    Array.isArray(view)
  ) {
    throw new Error('Markdown template input is invalid.');
  }

  const used = new Set();
  const rendered = template.replace(placeholderPattern, (_, name) => {
    if (!Object.hasOwn(view, name)) {
      throw new Error(`${label} uses unknown placeholder {{${name}}}.`);
    }
    used.add(name);
    return String(view[name]);
  });
  const unused = Object.keys(view).filter((name) => !used.has(name));
  if (unused.length > 0) {
    throw new Error(`${label} omits placeholders: ${unused.join(', ')}.`);
  }

  return `${rendered.replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
