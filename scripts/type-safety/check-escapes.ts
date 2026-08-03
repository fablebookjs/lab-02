import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

type EscapeKind =
  | 'explicit any'
  | 'non-null assertion'
  | 'type assertion'
  | 'TypeScript suppression';

type TypeEscapeDiagnostic = {
  column: number;
  file: string;
  kind: EscapeKind;
  line: number;
  reason: string;
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const typescriptFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  });

const justification = (lines: string[], line: number): string | null => {
  const nearby = [lines[line - 1], lines[line]]
    .filter((value): value is string => value !== undefined)
    .join('\n');
  const match = /type-escape:\s*(\S[^\r\n]*)/.exec(nearby);
  return match?.[1]?.trim() || null;
};

const diagnostics: TypeEscapeDiagnostic[] = [];
const accepted: Array<TypeEscapeDiagnostic & { justification: string }> = [];

const inspect = (file: string): void => {
  const source = readFileSync(file, 'utf8');
  const lines = source.split(/\r?\n/);
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const add = (node: ts.Node, kind: EscapeKind, reason: string): void => {
    const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const diagnostic: TypeEscapeDiagnostic = {
      column: point.character + 1,
      file: relative(repositoryRoot, file),
      kind,
      line: point.line + 1,
      reason,
    };
    const explanation = justification(lines, diagnostic.line);
    if (explanation === null) diagnostics.push(diagnostic);
    else accepted.push({ ...diagnostic, justification: explanation });
  };

  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      add(node, 'explicit any', 'replace any with a real type or defend the narrow escape');
    } else if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      add(node, 'type assertion', 'narrow or validate the value before using it');
    } else if (ts.isNonNullExpression(node)) {
      add(node, 'non-null assertion', 'prove the value exists with control flow');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const match of source.matchAll(/@ts-(ignore|nocheck|expect-error)\b/g)) {
    const start = match.index;
    const point = sourceFile.getLineAndCharacterOfPosition(start);
    const directive = match[1] ?? 'unknown';
    const diagnostic: TypeEscapeDiagnostic = {
      column: point.character + 1,
      file: relative(repositoryRoot, file),
      kind: 'TypeScript suppression',
      line: point.line + 1,
      reason:
        directive === 'expect-error'
          ? 'explain why the expected compiler error is unavoidable'
          : `@ts-${directive} is forbidden`,
    };
    if (directive === 'ignore' || directive === 'nocheck') {
      diagnostics.push(diagnostic);
      continue;
    }
    const explanation = justification(lines, diagnostic.line);
    if (explanation === null) diagnostics.push(diagnostic);
    else accepted.push({ ...diagnostic, justification: explanation });
  }
};

for (const root of ['.agents', 'scripts', 'test']) {
  for (const file of typescriptFiles(join(repositoryRoot, root))) inspect(file);
}

for (const diagnostic of diagnostics) {
  console.error(
    `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.kind} — ${diagnostic.reason}`,
  );
}

if (diagnostics.length > 0) {
  console.error(
    `${diagnostics.length} unjustified TypeScript escape${diagnostics.length === 1 ? '' : 's'}.`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `TypeScript escapes are controlled (${accepted.length} justified, ${diagnostics.length} unjustified).`,
  );
}
