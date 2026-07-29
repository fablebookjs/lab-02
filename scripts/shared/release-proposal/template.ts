const placeholderPattern = /{{([a-z][a-z0-9_]*)}}/g;

type RenderMarkdownTemplateOptions = {
  label: string;
  template: string;
  view: Record<string, unknown>;
};

export function renderMarkdownTemplate({
  label,
  template,
  view,
}: RenderMarkdownTemplateOptions): string {
  if (
    label.length === 0 ||
    template.trim().length === 0
  ) {
    throw new Error('Markdown template input is invalid.');
  }

  const used = new Set<string>();
  const rendered = template.replace(placeholderPattern, (_, name: string) => {
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
