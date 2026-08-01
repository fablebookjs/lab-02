/*
 * Adapted from ts-dedent v2.3.0:
 * https://github.com/tamino-martinius/node-ts-dedent/blob/v2.3.0/src/index.ts
 *
 * MIT License
 *
 * Copyright (c) 2018 Tamino Martinius
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Removes common indentation from a string or tagged template literal.
 *
 * @remarks
 * Multiline interpolations inherit the indentation at their insertion point.
 * Use this for readable source-level text templates, not for arbitrary Markdown
 * normalization after rendering.
 *
 * @example
 * ```ts
 * dedent`
 *   heading
 *     ${'first\nsecond'}
 * `;
 * ```
 */
export function dedent(
  template: TemplateStringsArray | string,
  ...values: unknown[]
): string {
  let strings = Array.from(typeof template === 'string' ? [template] : template);

  const finalString = strings.at(-1);
  if (finalString === undefined) return '';
  strings[strings.length - 1] = finalString.replace(
    /\r?\n([\t ]*)$/,
    '',
  );

  const indentLengths = strings.reduce<number[]>((lengths, value) => {
    const matches = value.match(/\n([\t ]+|(?!\s).)/g);
    return matches === null
      ? lengths
      : lengths.concat(
          matches.map((match) => match.match(/[\t ]/g)?.length ?? 0),
        );
  }, []);

  if (indentLengths.length > 0) {
    const pattern = new RegExp(
      `\n[\t ]{${Math.min(...indentLengths)}}`,
      'g',
    );
    strings = strings.map((value) => value.replace(pattern, '\n'));
  }

  strings[0] = (strings[0] ?? '').replace(/^\r?\n/, '');

  let result = strings[0] ?? '';
  values.forEach((value, index) => {
    const indentationMatch = result.match(/(?:^|\n)( *)$/);
    const indentation = indentationMatch?.[1] ?? '';
    const interpolated =
      typeof value === 'string' && value.includes('\n')
        ? value
            .split('\n')
            .map((line, lineIndex) =>
              lineIndex === 0 ? line : `${indentation}${line}`,
            )
            .join('\n')
        : value;
    result += `${String(interpolated)}${strings[index + 1] ?? ''}`;
  });

  return result;
}
