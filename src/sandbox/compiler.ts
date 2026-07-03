import ts from 'typescript';
import { toolboxLibrarySource } from '../toolbox/library';

export interface CompileResult {
  ok: boolean;
  js: string;
  errors: string[];
}

const compilerOptions: ts.TranspileOptions['compilerOptions'] = {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.CommonJS,
  strict: true,
  esModuleInterop: false,
  isolatedModules: true,
  noImplicitUseStrict: false,
  sourceMap: false,
  inlineSourceMap: false,
  removeComments: false,
};

export function compileUserCode(source: string): CompileResult {
  const toolboxResult = transpile(toolboxLibrarySource, 'autopilot-toolbox.ts');
  const userResult = transpile(source, 'autopilot.ts');
  const errors = [
    ...formatDiagnostics(toolboxResult.diagnostics, 'Toolbox'),
    ...formatDiagnostics(userResult.diagnostics),
  ];

  return {
    ok: errors.length === 0,
    js: `${toolboxResult.outputText}\n${userResult.outputText}`,
    errors,
  };
}

function transpile(source: string, fileName: string): ts.TranspileOutput {
  return ts.transpileModule(source, {
    compilerOptions,
    reportDiagnostics: true,
    fileName,
  });
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
