import Editor, { loader, type BeforeMount, type OnMount } from '@monaco-editor/react';
import { Code2, FileCode2 } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import type { editor } from 'monaco-editor';
import * as monacoEditor from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import type { ControllerExample } from '../toolbox';
import { publicAutopilotDts } from '../types/publicDts';

type MonacoWorkerGlobal = typeof self & {
  MonacoEnvironment?: {
    getWorker: (_workerId: string, label: string) => Worker;
  };
};

(self as MonacoWorkerGlobal).MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) => {
    if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker();
    return new EditorWorker();
  },
};

loader.config({ monaco: monacoEditor });

interface EditorPanelProps {
  code: string;
  examples: ControllerExample[];
  selectedExampleId: string;
  compileErrors: string[];
  codeStatus: string;
  toolbox: ReactNode;
  onCodeChange: (code: string) => void;
  onLoadExample: (id: string) => void;
}

export function EditorPanel({
  code,
  examples,
  selectedExampleId,
  compileErrors,
  codeStatus,
  toolbox,
  onCodeChange,
  onLoadExample,
}: EditorPanelProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const beforeMount: BeforeMount = (monaco) => {
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2020,
      module: monaco.languages.typescript.ModuleKind.CommonJS,
      allowNonTsExtensions: true,
      strict: true,
      noEmit: true,
      isolatedModules: true,
    });
    monaco.languages.typescript.typescriptDefaults.addExtraLib(publicAutopilotDts, 'ts:autopilot-api.d.ts');
    monaco.editor.defineTheme('autopilot-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '72838a' },
        { token: 'keyword', foreground: '89a9ff' },
        { token: 'number', foreground: 'f7c86d' },
        { token: 'string', foreground: '82dec1' },
      ],
      colors: {
        'editor.background': '#071013',
        'editor.foreground': '#d7e5e4',
        'editorLineNumber.foreground': '#395057',
        'editorLineNumber.activeForeground': '#6df7d1',
        'editor.selectionBackground': '#26484d',
        'editorCursor.foreground': '#6df7d1',
      },
    });
  };

  const onMount: OnMount = (editorInstance) => {
    editorRef.current = editorInstance;
  };

  return (
    <section className="flex min-h-[420px] min-w-0 flex-col overflow-hidden bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <Code2 className="text-mint" size={18} />
          <h2 className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-100">Autopilot.ts</h2>
        </div>
        <div className="flex items-center gap-2">
          {toolbox}
          <label className="flex items-center gap-2 rounded-md border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-slate-400">
            <FileCode2 size={14} />
            <select
              value={selectedExampleId}
              onChange={(event) => onLoadExample(event.target.value)}
              className="max-w-56 bg-transparent text-slate-100 outline-none"
            >
              {examples.map((example) => (
                <option key={example.id} value={example.id} className="bg-panel text-slate-100">
                  {example.title}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="min-h-[420px] flex-1 overflow-hidden">
        <Editor
          height="100%"
          language="typescript"
          theme="autopilot-dark"
          value={code}
          beforeMount={beforeMount}
          onMount={onMount}
          onChange={(value) => onCodeChange(value ?? '')}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineHeight: 20,
            fontLigatures: false,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            padding: { top: 14, bottom: 14 },
            smoothScrolling: true,
            automaticLayout: true,
            bracketPairColorization: { enabled: true },
          }}
        />
      </div>

      <div className="border-t border-white/10 px-4 py-2 text-xs">
        {compileErrors.length > 0 ? (
          <span className="text-red-200">{compileErrors.length} compile issue{compileErrors.length === 1 ? '' : 's'}</span>
        ) : (
          <span className="text-mint">{codeStatus}</span>
        )}
      </div>
    </section>
  );
}
