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

type Zone = 'api' | 'github' | 'shared';
type AnalyzedSource = { canonical: string; logical: string; zone: Zone };

const executableExtensions = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.tsx']);
const alternateLoaders = new Set(['createRequire', 'register', 'registerHooks']);
const zones: readonly Zone[] = ['api', 'github', 'shared'];
const allowedTargets: Readonly<Record<Zone, readonly Zone[]>> = {
  api: ['api', 'shared'],
  github: ['github', 'shared'],
  shared: ['shared'],
};

const isWithin = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

function enumerate(
  directory: string,
  zone: Zone,
  sources: AnalyzedSource[],
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

const hasNamedImport = (
  sourceFile: ts.SourceFile,
  module: string,
  name: string,
): boolean =>
  sourceFile.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== module
    ) {
      return false;
    }
    const bindings = statement.importClause?.namedBindings;
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (element) =>
          (element.propertyName ?? element.name).text === name && element.name.text === name,
      )
    );
  });

const hasSupportedApiPathTable = (sourceFile: ts.SourceFile): boolean =>
  sourceFile.statements.some((statement) => {
    if (!ts.isVariableStatement(statement)) return false;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) return false;
    const declaration = statement.declarationList.declarations.find(
      (candidate) =>
        ts.isIdentifier(candidate.name) &&
        candidate.name.text === 'supportedWorkspacePackageApiPaths',
    );
    if (
      declaration === undefined ||
      declaration.initializer === undefined ||
      !ts.isArrayLiteralExpression(declaration.initializer)
    ) {
      return false;
    }
    const versions = declaration.initializer.elements.flatMap((element) => {
      if (!ts.isStringLiteralLike(element)) return [];
      const match = /^scripts\/api\/v([1-9][0-9]*)\/workspace-packages\.ts$/.exec(element.text);
      const version = match?.[1];
      return version === undefined ? [] : [Number(version)];
    });
    return (
      versions.length === declaration.initializer.elements.length &&
      versions.length > 0 &&
      versions.every((version, index) => index === 0 || version < (versions[index - 1] ?? 0))
    );
  });

const releasePackageSetLoader = (node: ts.Node): ts.FunctionDeclaration | undefined => {
  let parent: ts.Node | undefined = node.parent;
  while (parent !== undefined) {
    if (ts.isFunctionLike(parent)) {
      return ts.isFunctionDeclaration(parent) && parent.name?.text === 'loadReleasePackageSet'
        ? parent
        : undefined;
    }
    parent = parent.parent;
  }
  return undefined;
};

const supportedApiPathLoop = (
  node: ts.Node,
  loader: ts.FunctionDeclaration,
): ts.ForOfStatement | undefined => {
  let parent: ts.Node | undefined = node.parent;
  while (parent !== undefined && parent !== loader) {
    if (ts.isForOfStatement(parent)) {
      const declarations = ts.isVariableDeclarationList(parent.initializer)
        ? parent.initializer.declarations
        : undefined;
      const declaration = declarations?.[0];
      if (
        declarations?.length === 1 &&
        declaration !== undefined &&
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === 'relativeEntrypoint' &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === 'supportedWorkspacePackageApiPaths'
      ) {
        return parent;
      }
    }
    parent = parent.parent;
  }
  return undefined;
};

const loopDerivesSelectedEntrypoint = (loop: ts.ForOfStatement): boolean => {
  let matches = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer;
      const firstArgument =
        initializer !== undefined && ts.isCallExpression(initializer)
          ? initializer.arguments[0]
          : undefined;
      const secondArgument =
        initializer !== undefined && ts.isCallExpression(initializer)
          ? initializer.arguments[1]
          : undefined;
      if (
        node.name.text === 'selectedEntrypoint' &&
        initializer !== undefined &&
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === 'join' &&
        initializer.arguments.length === 2 &&
        firstArgument !== undefined &&
        ts.isIdentifier(firstArgument) &&
        firstArgument.text === 'snapshotRoot' &&
        secondArgument !== undefined &&
        ts.isIdentifier(secondArgument) &&
        secondArgument.text === 'relativeEntrypoint'
      ) {
        matches += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(loop.statement);
  return matches === 1;
};

const isAllowedReleasePackageSetImport = (
  scriptsRoot: string,
  source: AnalyzedSource,
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
): boolean => {
  const logical = relative(scriptsRoot, source.logical).split(sep).join('/');
  const loader = releasePackageSetLoader(node);
  if (
    source.zone !== 'shared' ||
    logical !== 'shared/package-publication/package-set.ts' ||
    loader === undefined ||
    loader.parameters.length !== 2
  ) {
    return false;
  }
  const snapshotParameter = loader.parameters[0];
  const versionParameter = loader.parameters[1];
  if (
    snapshotParameter === undefined ||
    !ts.isIdentifier(snapshotParameter.name) ||
    snapshotParameter.name.text !== 'snapshotRoot' ||
    versionParameter === undefined ||
    !ts.isIdentifier(versionParameter.name) ||
    versionParameter.name.text !== 'expectedVersion' ||
    !hasNamedImport(sourceFile, 'node:path', 'join') ||
    !hasNamedImport(sourceFile, 'node:url', 'pathToFileURL') ||
    !hasSupportedApiPathTable(sourceFile)
  ) {
    return false;
  }
  const loop = supportedApiPathLoop(node, loader);
  if (loop === undefined || !loopDerivesSelectedEntrypoint(loop)) return false;

  const argument = node.arguments[0];
  if (
    node.arguments.length !== 1 ||
    argument === undefined ||
    !ts.isPropertyAccessExpression(argument) ||
    argument.name.text !== 'href' ||
    !ts.isCallExpression(argument.expression) ||
    !ts.isIdentifier(argument.expression.expression) ||
    argument.expression.expression.text !== 'pathToFileURL' ||
    argument.expression.arguments.length !== 1
  ) {
    return false;
  }
  const selectedEntrypoint = argument.expression.arguments[0];
  return (
    selectedEntrypoint !== undefined &&
    ts.isIdentifier(selectedEntrypoint) &&
    selectedEntrypoint.text === 'selectedEntrypoint'
  );
};

export function checkZeroInstallImports(
  scriptsRootInput: string,
): ImportBoundaryDiagnostic[] {
  const scriptsRoot = resolve(scriptsRootInput);
  const roots: Record<Zone, string> = {
    api: resolve(scriptsRoot, 'api'),
    github: resolve(scriptsRoot, 'github'),
    shared: resolve(scriptsRoot, 'shared'),
  };
  const canonicalRoots: Record<Zone, string> = {
    api: realpathSync(roots.api),
    github: realpathSync(roots.github),
    shared: realpathSync(roots.shared),
  };
  const sources: AnalyzedSource[] = [];
  const unsupported: Array<{ logical: string; zone: Zone }> = [];
  for (const zone of zones) enumerate(roots[zone], zone, sources, unsupported);
  const knownTargets = new Set(sources.map(({ canonical }) => canonical));
  const diagnostics: ImportBoundaryDiagnostic[] = [];
  const seen = new Set<string>();

  const add = (
    source: AnalyzedSource,
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
    source: AnalyzedSource,
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

    const allowed = allowedTargets[source.zone].some((zone) =>
      isWithin(canonicalRoots[zone], canonicalTarget),
    );
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
    const canonicalZone = canonicalRoots[source.zone];
    if (!isWithin(canonicalZone, source.canonical)) {
      add(
        source,
        undefined,
        undefined,
        'SOURCE_ESCAPE',
        `${source.zone} source resolves outside its declared zero-install directory`,
      );
    }

    const sourceText = readFileSync(source.logical, 'utf8');
    const sourceFile = ts.createSourceFile(
      source.logical,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const parseDiagnostics = ts.transpileModule(sourceText, {
      compilerOptions: {
        module: ts.ModuleKind.NodeNext,
        target: ts.ScriptTarget.Latest,
      },
      fileName: source.logical,
      reportDiagnostics: true,
    }).diagnostics;
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
            'zero-install modules must not use top-level await',
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
          } else if (isAllowedReleasePackageSetImport(scriptsRoot, source, sourceFile, node)) {
            // The selected entrypoint is the sole computed import in the zero-install graph.
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

function formatImportBoundaryDiagnostic(
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
