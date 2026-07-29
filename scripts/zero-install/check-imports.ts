import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export type ImportBoundaryDiagnostic = {
  code: string;
  column: number;
  file: string;
  line: number;
  reason: string;
  specifier?: string;
};

type Zone = 'github' | 'shared';
type Source = { canonical: string; logical: string; zone: Zone };

const executableExtensions = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.tsx']);
const alternateLoaders = new Set(['createRequire', 'register', 'registerHooks']);

const isWithin = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

function enumerate(
  directory: string,
  zone: Zone,
  sources: Source[],
  unsupported: Array<{ logical: string; zone: Zone }>,
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const logical = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      enumerate(logical, zone, sources, unsupported);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      sources.push({ canonical: realpathSync(logical), logical, zone });
    } else if (executableExtensions.has(extname(entry.name))) {
      unsupported.push({ logical, zone });
    }
  }
}

function point(sourceFile: ts.SourceFile, node: ts.Node): { column: number; line: number } {
  const location = sourceFile.getLineAndCharacterOfPosition(Math.max(0, node.getStart(sourceFile)));
  return { column: location.character + 1, line: location.line + 1 };
}

export function checkZeroInstallImports(
  scriptsRootInput: string,
): ImportBoundaryDiagnostic[] {
  const scriptsRoot = resolve(scriptsRootInput);
  const sharedRoot = resolve(scriptsRoot, 'shared');
  const githubRoot = resolve(scriptsRoot, 'github');
  const canonicalShared = realpathSync(sharedRoot);
  const canonicalGithub = realpathSync(githubRoot);
  const sources: Source[] = [];
  const unsupported: Array<{ logical: string; zone: Zone }> = [];
  enumerate(sharedRoot, 'shared', sources, unsupported);
  enumerate(githubRoot, 'github', sources, unsupported);
  const knownTargets = new Set(sources.map(({ canonical }) => canonical));
  const diagnostics: ImportBoundaryDiagnostic[] = [];
  const seen = new Set<string>();

  const add = (
    source: Source,
    sourceFile: ts.SourceFile | undefined,
    node: ts.Node | undefined,
    code: string,
    reason: string,
    specifier?: string,
  ): void => {
    const location = sourceFile && node ? point(sourceFile, node) : { column: 1, line: 1 };
    const diagnostic: ImportBoundaryDiagnostic = {
      code,
      column: location.column,
      file: relative(dirname(scriptsRoot), source.logical),
      line: location.line,
      reason,
      ...(specifier === undefined ? {} : { specifier }),
    };
    const key = `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}:${code}:${specifier ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push(diagnostic);
  };

  for (const source of unsupported) {
    add(
      { canonical: source.logical, ...source },
      undefined,
      undefined,
      'UNSUPPORTED_SOURCE',
      'zero-install executable sources must use the explicit .ts runtime contract',
    );
  }

  const inspectSpecifier = (
    source: Source,
    sourceFile: ts.SourceFile,
    node: ts.Node,
    specifier: string,
  ): void => {
    if (specifier.startsWith('node:')) return;
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
      add(
        source,
        sourceFile,
        node,
        'RUNTIME_SPECIFIER',
        'runtime imports must use node:* or an allowed relative .ts target',
        specifier,
      );
      return;
    }
    if (!specifier.endsWith('.ts')) {
      add(
        source,
        sourceFile,
        node,
        'EXPLICIT_TS_EXTENSION',
        'relative runtime imports must name an explicit .ts file',
        specifier,
      );
      return;
    }

    const logicalTarget = resolve(dirname(source.logical), specifier);
    let canonicalTarget: string;
    try {
      lstatSync(logicalTarget);
      canonicalTarget = realpathSync(logicalTarget);
      if (!statSync(canonicalTarget).isFile()) throw new Error('not a file');
    } catch {
      add(
        source,
        sourceFile,
        node,
        'MISSING_TARGET',
        'relative runtime import does not resolve to a file',
        specifier,
      );
      return;
    }

    const allowed =
      isWithin(canonicalShared, canonicalTarget) ||
      (source.zone === 'github' && isWithin(canonicalGithub, canonicalTarget));
    if (!allowed) {
      add(
        source,
        sourceFile,
        node,
        'ZONE_ESCAPE',
        `${source.zone} runtime import resolves outside its allowed zero-install zone`,
        specifier,
      );
    } else if (!knownTargets.has(canonicalTarget)) {
      add(
        source,
        sourceFile,
        node,
        'UNKNOWN_TARGET',
        'relative runtime import is not an enumerated zero-install .ts file',
        specifier,
      );
    }
  };

  for (const source of sources) {
    const canonicalZone = source.zone === 'shared' ? canonicalShared : canonicalGithub;
    if (!isWithin(canonicalZone, source.canonical)) {
      add(
        source,
        undefined,
        undefined,
        'SOURCE_ESCAPE',
        `${source.zone} source resolves outside its declared zero-install directory`,
      );
    }

    const sourceFile = ts.createSourceFile(
      source.logical,
      readFileSync(source.logical, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const parseDiagnostics = (
      sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }
    ).parseDiagnostics;
    for (const parseDiagnostic of parseDiagnostics ?? []) {
      const start = parseDiagnostic.start ?? 0;
      const location = sourceFile.getLineAndCharacterOfPosition(start);
      diagnostics.push({
        code: 'PARSE_ERROR',
        column: location.character + 1,
        file: relative(dirname(scriptsRoot), source.logical),
        line: location.line + 1,
        reason: ts.flattenDiagnosticMessageText(parseDiagnostic.messageText, '\n'),
      });
    }

    const visit = (node: ts.Node): void => {
      if (
        ts.isAwaitExpression(node) ||
        (ts.isForOfStatement(node) && node.awaitModifier !== undefined)
      ) {
        let parent: ts.Node | undefined = node.parent;
        while (parent !== undefined && parent !== sourceFile && !ts.isFunctionLike(parent)) {
          parent = parent.parent;
        }
        if (parent === sourceFile) {
          add(
            source,
            sourceFile,
            node,
            'TOP_LEVEL_AWAIT',
            'the synchronous github-script require bridge cannot load top-level await',
          );
        }
      }

      if (ts.isImportDeclaration(node)) {
        if (!node.importClause?.isTypeOnly) {
          if (ts.isStringLiteralLike(node.moduleSpecifier)) {
            inspectSpecifier(source, sourceFile, node.moduleSpecifier, node.moduleSpecifier.text);
            if (node.moduleSpecifier.text === 'node:module') {
              const bindings = node.importClause?.namedBindings;
              if (bindings && ts.isNamedImports(bindings)) {
                for (const element of bindings.elements) {
                  const imported = (element.propertyName ?? element.name).text;
                  if (!element.isTypeOnly && alternateLoaders.has(imported)) {
                    add(
                      source,
                      sourceFile,
                      element,
                      'ALTERNATE_LOADER',
                      `${imported} is outside the import-graph guarantee`,
                      imported,
                    );
                  }
                }
              }
            }
          } else {
            add(source, sourceFile, node, 'UNKNOWN_IMPORT', 'static import is not understood');
          }
        }
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
        if (ts.isStringLiteralLike(node.moduleSpecifier)) {
          inspectSpecifier(source, sourceFile, node.moduleSpecifier, node.moduleSpecifier.text);
        } else {
          add(source, sourceFile, node, 'UNKNOWN_EXPORT', 'export target is not understood');
        }
      } else if (ts.isImportEqualsDeclaration(node)) {
        add(source, sourceFile, node, 'IMPORT_EQUALS', 'import-equals is forbidden');
      } else if (ts.isImportTypeNode(node)) {
        add(
          source,
          sourceFile,
          node,
          'TYPE_IMPORT_FORM',
          'use declaration-level import type or export type',
        );
      } else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const argument = node.arguments[0];
          if (
            argument &&
            (ts.isStringLiteralLike(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
          ) {
            inspectSpecifier(source, sourceFile, argument, argument.text);
          } else {
            add(
              source,
              sourceFile,
              node,
              'UNKNOWN_DYNAMIC_IMPORT',
              'dynamic import targets must be plain string literals',
            );
          }
        } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          add(source, sourceFile, node, 'REQUIRE_CALL', 'require(...) is forbidden');
        } else if (
          ts.isIdentifier(node.expression) &&
          (node.expression.text === 'eval' || node.expression.text === 'Function')
        ) {
          add(
            source,
            sourceFile,
            node,
            'ALTERNATE_LOADER',
            `${node.expression.text} is outside the import-graph guarantee`,
            node.expression.text,
          );
        }
      } else if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Function'
      ) {
        add(
          source,
          sourceFile,
          node,
          'ALTERNATE_LOADER',
          'Function construction is outside the import-graph guarantee',
          'Function',
        );
      } else if (ts.isPropertyAccessExpression(node)) {
        const name = node.name.text;
        if (
          alternateLoaders.has(name) ||
          (name === 'getBuiltinModule' &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === 'process')
        ) {
          add(
            source,
            sourceFile,
            node,
            'ALTERNATE_LOADER',
            `${name} is outside the import-graph guarantee`,
            name,
          );
        }
      } else if (
        ts.isIdentifier(node) &&
        node.text === 'require' &&
        !(
          (ts.isCallExpression(node.parent) && node.parent.expression === node) ||
          (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
          (ts.isPropertyAssignment(node.parent) && node.parent.name === node)
        )
      ) {
        add(
          source,
          sourceFile,
          node,
          'REQUIRE_REFERENCE',
          'the require identifier may not be captured or aliased',
          'require',
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return diagnostics.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.code.localeCompare(right.code),
  );
}

export function formatImportBoundaryDiagnostic(
  diagnostic: ImportBoundaryDiagnostic,
): string {
  const specifier =
    diagnostic.specifier === undefined ? '' : ` ${JSON.stringify(diagnostic.specifier)}`;
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.code}${specifier} — ${diagnostic.reason}`;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const diagnostics = checkZeroInstallImports(join(repositoryRoot, 'scripts'));
  for (const diagnostic of diagnostics) console.error(formatImportBoundaryDiagnostic(diagnostic));
  if (diagnostics.length > 0) {
    console.error(
      `${diagnostics.length} zero-install import violation${diagnostics.length === 1 ? '' : 's'}.`,
    );
    process.exitCode = 1;
  } else {
    console.log('The zero-install TypeScript import graph is closed.');
  }
}
