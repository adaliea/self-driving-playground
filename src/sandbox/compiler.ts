import ts from 'typescript';

export interface CompileResult {
  ok: boolean;
  js: string;
  errors: string[];
}

export function compileUserCode(source: string): CompileResult {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      strict: true,
      esModuleInterop: false,
      isolatedModules: true,
      noImplicitUseStrict: false,
      sourceMap: false,
      inlineSourceMap: false,
      removeComments: false,
    },
    reportDiagnostics: true,
    fileName: 'autopilot.ts',
  });

  const errors =
    result.diagnostics?.map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
      if (!diagnostic.file || diagnostic.start === undefined) return message;
      const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      return `Line ${position.line + 1}, column ${position.character + 1}: ${message}`;
    }) ?? [];

  return {
    ok: errors.length === 0,
    js: result.outputText,
    errors,
  };
}
