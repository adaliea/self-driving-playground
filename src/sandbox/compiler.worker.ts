import { compileUserCode, type CompileResult } from './compiler';

interface CompileRequestMessage {
  type: 'compile';
  id: number;
  source: string;
}

type CompileResponseMessage =
  | {
      type: 'compile-result';
      id: number;
      result: CompileResult;
    }
  | {
      type: 'compile-error';
      id: number;
      message: string;
    };

function isCompileRequestMessage(value: unknown): value is CompileRequestMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as CompileRequestMessage).type === 'compile' &&
    typeof (value as CompileRequestMessage).id === 'number' &&
    typeof (value as CompileRequestMessage).source === 'string'
  );
}

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!isCompileRequestMessage(event.data)) return;

  try {
    postMessage({
      type: 'compile-result',
      id: event.data.id,
      result: compileUserCode(event.data.source),
    } satisfies CompileResponseMessage);
  } catch (error) {
    postMessage({
      type: 'compile-error',
      id: event.data.id,
      message: error instanceof Error ? error.message : String(error),
    } satisfies CompileResponseMessage);
  }
});
