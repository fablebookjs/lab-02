/**
 * Removes indentation introduced by TypeScript source layout while preserving
 * intentional indentation inside interpolated multiline values.
 */
export function dedent(
  template: TemplateStringsArray,
  ...values: unknown[]
): string {
  let segments = Array.from(template);
  const lastIndex = segments.length - 1;
  const finalSegment = segments[lastIndex];
  if (finalSegment === undefined) return '';
  segments[lastIndex] = finalSegment.replace(/\r?\n[\t ]*$/, '');

  const indentationWidths: number[] = [];
  for (const segment of segments) {
    for (const line of segment.split('\n').slice(1)) {
      const indentation = /^[\t ]+/.exec(line)?.[0];
      if (indentation !== undefined) {
        indentationWidths.push(indentation.length);
      } else if (line.length > 0 && !/^\s/.test(line)) {
        indentationWidths.push(0);
      }
    }
  }

  if (indentationWidths.length > 0) {
    const commonWidth = Math.min(...indentationWidths);
    const commonIndentation = new RegExp(`\n[\t ]{${commonWidth}}`, 'g');
    segments = segments.map((segment) =>
      segment.replace(commonIndentation, '\n'),
    );
  }

  let rendered = (segments[0] ?? '').replace(/^\r?\n/, '');
  for (const [index, value] of values.entries()) {
    const indentation = /(?:^|\n)( *)$/.exec(rendered)?.[1] ?? '';
    const interpolated =
      typeof value === 'string'
        ? value.replace(/\n/g, `\n${indentation}`)
        : String(value);
    rendered += `${interpolated}${segments[index + 1] ?? ''}`;
  }
  return rendered;
}
