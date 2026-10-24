import ts from 'typescript';
import { toolboxLibrarySource } from '../toolbox/library';
import {
  TOOLBOX_INSPECTORS,
  type InspectionManifest,
  type RuntimeBindingMetadata,
  type ToolboxCallMetadata,
  type ToolboxInspectorName,
} from './inspection';

export interface CompileWarning {
  message: string;
  /** Offset and length of the code the warning is about, in the user's source. */
  start: number;
  length: number;
}

export interface CompileResult {
  ok: boolean;
  js: string;
  errors: string[];
  /** Likely mistakes that still compile and run. */
  warnings: CompileWarning[];
  inspection: InspectionManifest;
}

const compilerOptions: ts.TranspileOptions['compilerOptions'] = {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.CommonJS,
  strict: true,
  esModuleInterop: true,
  isolatedModules: true,
  noImplicitUseStrict: false,
  sourceMap: false,
  inlineSourceMap: false,
  removeComments: false,
};

export function compileUserCode(source: string): CompileResult {
  const toolboxResult = transpile(toolboxLibrarySource, 'autopilot-toolbox.ts');
  const userResult = transpileInstrumentedUserCode(source);
  const errors = [
    ...formatDiagnostics(toolboxResult.diagnostics, 'Toolbox'),
    ...formatDiagnostics(userResult.diagnostics),
  ];

  return {
    ok: errors.length === 0,
    js: `${toolboxResult.outputText}\n${userResult.outputText}`,
    errors,
    warnings: userResult.warnings,
    inspection: userResult.inspection,
  };
}

interface InstrumentedTranspileOutput {
  outputText: string;
  diagnostics: readonly ts.Diagnostic[];
  warnings: CompileWarning[];
  inspection: InspectionManifest;
}

const toolboxInspectorNames = new Set<string>(TOOLBOX_INSPECTORS);
const traceValueIdentifier = '__playgroundTraceValue';
const tracePostfixIdentifier = '__playgroundTracePostfix';
const traceToolboxCallIdentifier = '__playgroundTraceToolboxCall';

function transpileInstrumentedUserCode(source: string): InstrumentedTranspileOutput {
  const fileName = 'autopilot.ts';
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
  const bindings: RuntimeBindingMetadata[] = [];
  const toolboxCalls: ToolboxCallMetadata[] = [];
  const bindingIdsBySymbol = new Map<ts.Symbol, string>();
  const bindingMetadataById = new Map<string, RuntimeBindingMetadata>();
  const toolboxCallIdsByStart = new Map<number, string>();
  const warnings: CompileWarning[] = [];
  let outputText = '';

  const options: ts.CompilerOptions = {
    ...compilerOptions,
    noLib: true,
  };
  const host: ts.CompilerHost = {
    fileExists: (candidate) => candidate === fileName,
    getCanonicalFileName: (candidate) => candidate,
    getCurrentDirectory: () => '',
    getDefaultLibFileName: () => 'lib.d.ts',
    getNewLine: () => '\n',
    getSourceFile: (candidate) => (candidate === fileName ? sourceFile : undefined),
    readFile: (candidate) => (candidate === fileName ? source : undefined),
    useCaseSensitiveFileNames: () => true,
    writeFile: (candidate, text) => {
      if (candidate.endsWith('.js')) outputText = text;
    },
  };
  const program = ts.createProgram([fileName], options, host);
  const checker = program.getTypeChecker();

  const registerBindingName = (name: ts.BindingName, sourceCallId?: string): void => {
    if (ts.isIdentifier(name)) {
      const symbol = checker.getSymbolAtLocation(name);
      if (!symbol || bindingIdsBySymbol.has(symbol)) return;
      const id = bindingIdFor(name);
      const metadata: RuntimeBindingMetadata = {
        id,
        name: name.text,
        declaration: spanFor(name),
        sourceCallId,
      };
      bindingIdsBySymbol.set(symbol, id);
      bindingMetadataById.set(id, metadata);
      bindings.push(metadata);
      return;
    }

    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) registerBindingName(element.name, sourceCallId);
    }
  };

  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const directCall = node.initializer && directToolboxCall(node.initializer, checker);
      const callId = directCall ? registerToolboxCall(directCall) : undefined;
      registerBindingName(node.name, callId);
    } else if (ts.isParameter(node)) {
      registerBindingName(node.name);
    } else if (ts.isCallExpression(node)) {
      const directCall = directToolboxCall(node, checker);
      if (directCall) registerToolboxCall(directCall);
    }
    ts.forEachChild(node, collect);
  };

  const registerToolboxCall = (call: ts.CallExpression): string => {
    const start = call.getStart(sourceFile);
    const existing = toolboxCallIdsByStart.get(start);
    if (existing) return existing;
    const name = (call.expression as ts.Identifier).text as ToolboxInspectorName;
    if (name === 'createPidController' && enclosingFunction(call)) {
      warnings.push({
        message:
          'This creates a new PID controller every time the function runs, so it forgets its integral and previous error, and I and D stay at 0. Create it once, above "export function autopilot".',
        start,
        length: call.getEnd() - start,
      });
    }
    const id = `c:${start}`;
    toolboxCallIdsByStart.set(start, id);
    toolboxCalls.push({ id, name, span: spanFor(call.expression) });
    return id;
  };

  collect(sourceFile);

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const { factory } = context;

    const captureCall = (id: string, expression: ts.Expression): ts.CallExpression =>
      factory.createCallExpression(factory.createIdentifier(traceValueIdentifier), undefined, [
        factory.createStringLiteral(id),
        expression,
      ]);

    const captureStatementsFor = (name: ts.BindingName): ts.Statement[] => {
      const result: ts.Statement[] = [];
      for (const identifier of bindingIdentifiers(name)) {
        const id = bindingIdAt(identifier, checker, bindingIdsBySymbol);
        if (!id) continue;
        result.push(factory.createExpressionStatement(captureCall(id, factory.createIdentifier(identifier.text))));
      }
      return result;
    };

    const visitor: ts.Visitor = (node) => {
      if (ts.isVariableStatement(node)) {
        const visited = ts.visitEachChild(node, visitor, context) as ts.VariableStatement;
        const trailing = node.declarationList.declarations.flatMap((declaration) => {
          if (ts.isIdentifier(declaration.name) && declaration.initializer) return [];
          return captureStatementsFor(declaration.name);
        });
        return trailing.length > 0 ? [visited, ...trailing] : visited;
      }

      if (ts.isVariableDeclaration(node)) {
        const visitedInitializer = node.initializer
          ? (ts.visitNode(node.initializer, visitor) as ts.Expression)
          : undefined;
        if (!ts.isIdentifier(node.name) || !visitedInitializer) {
          return factory.updateVariableDeclaration(
            node,
            node.name,
            node.exclamationToken,
            node.type,
            visitedInitializer,
          );
        }
        const id = bindingIdAt(node.name, checker, bindingIdsBySymbol);
        return factory.updateVariableDeclaration(
          node,
          node.name,
          node.exclamationToken,
          node.type,
          id ? captureCall(id, visitedInitializer) : visitedInitializer,
        );
      }

      if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind) && ts.isIdentifier(node.left)) {
        const id = bindingIdAt(node.left, checker, bindingIdsBySymbol);
        const visited = ts.visitEachChild(node, visitor, context) as ts.BinaryExpression;
        return id ? captureCall(id, visited) : visited;
      }

      if (ts.isPrefixUnaryExpression(node) && isUpdateOperator(node.operator) && ts.isIdentifier(node.operand)) {
        const id = bindingIdAt(node.operand, checker, bindingIdsBySymbol);
        const visited = ts.visitEachChild(node, visitor, context) as ts.PrefixUnaryExpression;
        return id ? captureCall(id, visited) : visited;
      }

      if (ts.isPostfixUnaryExpression(node) && isUpdateOperator(node.operator) && ts.isIdentifier(node.operand)) {
        const id = bindingIdAt(node.operand, checker, bindingIdsBySymbol);
        const visited = ts.visitEachChild(node, visitor, context) as ts.PostfixUnaryExpression;
        if (!id) return visited;
        return factory.createCallExpression(factory.createIdentifier(tracePostfixIdentifier), undefined, [
          factory.createStringLiteral(id),
          factory.createArrowFunction(
            undefined,
            undefined,
            [],
            undefined,
            factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
            factory.createIdentifier(node.operand.text),
          ),
          visited,
        ]);
      }

      if (ts.isCallExpression(node) && directToolboxCall(node, checker)) {
        const id = toolboxCallIdsByStart.get(node.getStart(sourceFile));
        const visited = ts.visitEachChild(node, visitor, context) as ts.CallExpression;
        if (!id || !ts.isIdentifier(visited.expression)) return visited;
        return factory.createCallExpression(factory.createIdentifier(traceToolboxCallIdentifier), undefined, [
          factory.createStringLiteral(id),
          factory.createStringLiteral(visited.expression.text),
          factory.createIdentifier(visited.expression.text),
          factory.createArrayLiteralExpression(visited.arguments, false),
        ]);
      }

      if (ts.isFunctionLike(node)) {
        const visited = ts.visitEachChild(node, visitor, context);
        return prependParameterCaptures(visited, node.parameters, captureStatementsFor, factory);
      }

      return ts.visitEachChild(node, visitor, context);
    };

    return (file) => ts.visitNode(file, visitor) as ts.SourceFile;
  };

  program.emit(sourceFile, host.writeFile, undefined, false, { before: [transformer] });
  const diagnostics = [...program.getOptionsDiagnostics(), ...program.getSyntacticDiagnostics(sourceFile)];

  return {
    outputText,
    diagnostics,
    warnings,
    inspection: { bindings, toolboxCalls },
  };

  function spanFor(node: ts.Node): { start: number; length: number } {
    const start = node.getStart(sourceFile);
    return { start, length: node.getEnd() - start };
  }

  function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | undefined {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isFunctionLike(current)) return current;
    }
    return undefined;
  }

  function bindingIdFor(identifier: ts.Identifier): string {
    return `b:${identifier.getStart(sourceFile)}`;
  }
}

function transpile(source: string, fileName: string): ts.TranspileOutput {
  return ts.transpileModule(source, {
    compilerOptions,
    reportDiagnostics: true,
    fileName,
  });
}

function directToolboxCall(node: ts.Expression, checker: ts.TypeChecker): ts.CallExpression | undefined {
  if (!ts.isCallExpression(node) || node.questionDotToken || !ts.isIdentifier(node.expression)) return undefined;
  if (!toolboxInspectorNames.has(node.expression.text)) return undefined;
  return checker.getSymbolAtLocation(node.expression) ? undefined : node;
}

function bindingIdAt(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
  ids: ReadonlyMap<ts.Symbol, string>,
): string | undefined {
  const symbol = checker.getSymbolAtLocation(identifier);
  return symbol ? ids.get(symbol) : undefined;
}

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name),
  );
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isUpdateOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.PlusPlusToken || kind === ts.SyntaxKind.MinusMinusToken;
}

function prependParameterCaptures(
  node: ts.Node,
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  captureStatementsFor: (name: ts.BindingName) => ts.Statement[],
  factory: ts.NodeFactory,
): ts.Node {
  const captures = parameters.flatMap((parameter) => captureStatementsFor(parameter.name));
  if (captures.length === 0) return node;

  const prepend = (body: ts.Block): ts.Block => factory.updateBlock(body, [...captures, ...body.statements]);
  if (ts.isFunctionDeclaration(node) && node.body) {
    return factory.updateFunctionDeclaration(
      node,
      node.modifiers,
      node.asteriskToken,
      node.name,
      node.typeParameters,
      node.parameters,
      node.type,
      prepend(node.body),
    );
  }
  if (ts.isFunctionExpression(node)) {
    return factory.updateFunctionExpression(
      node,
      node.modifiers,
      node.asteriskToken,
      node.name,
      node.typeParameters,
      node.parameters,
      node.type,
      prepend(node.body),
    );
  }
  if (ts.isArrowFunction(node) && ts.isBlock(node.body)) {
    return factory.updateArrowFunction(
      node,
      node.modifiers,
      node.typeParameters,
      node.parameters,
      node.type,
      node.equalsGreaterThanToken,
      prepend(node.body),
    );
  }
  if (ts.isMethodDeclaration(node) && node.body) {
    return factory.updateMethodDeclaration(
      node,
      node.modifiers,
      node.asteriskToken,
      node.name,
      node.questionToken,
      node.typeParameters,
      node.parameters,
      node.type,
      prepend(node.body),
    );
  }
  return node;
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[] | undefined, label?: string): string[] {
  return (
    diagnostics?.map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
      const prefix = label ? `${label}: ` : '';
      if (!diagnostic.file || diagnostic.start === undefined) return `${prefix}${message}`;
      const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      return `${prefix}Line ${position.line + 1}, column ${position.character + 1}: ${message}`;
    }) ?? []
  );
}
