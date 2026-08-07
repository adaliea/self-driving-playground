import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import type { RuntimeInspectionStore } from '../sandbox';
import {
  resolveRuntimeHoverTarget,
  runtimeHoverForTarget,
  type RuntimeHoverTarget,
} from './runtimeHover';

const WIDGET_ID = 'autopilot.runtimeLiveValue';
const WIDGET_GAP = 12;

interface RuntimeWidgetLayout {
  width: number;
  height: number;
  verticalScrollbarWidth: number;
  horizontalScrollbarHeight: number;
}

export function runtimeValueWidgetCoordinates(
  layout: RuntimeWidgetLayout,
  widgetWidth: number,
  widgetHeight: number,
): monaco.editor.IOverlayWidgetPositionCoordinates {
  return {
    top: Math.max(WIDGET_GAP, layout.height - widgetHeight - layout.horizontalScrollbarHeight - WIDGET_GAP),
    left: Math.max(WIDGET_GAP, layout.width - widgetWidth - layout.verticalScrollbarWidth - WIDGET_GAP),
  };
}

export class RuntimeValueWidget implements monaco.editor.IOverlayWidget, monaco.IDisposable {
  private readonly domNode: HTMLDivElement;
  private readonly contentNode: HTMLDivElement;
  private readonly disposables: monaco.IDisposable[] = [];
  private hoveredPosition: monaco.Position | undefined;
  private target: RuntimeHoverTarget | undefined;
  private resolvedPositionKey: string | undefined;
  private resolvedVersion: number | undefined;
  private resolvingVersion: number | undefined;
  private renderedMarkdown: string | undefined;
  private resolutionSequence = 0;
  private readonly resizeObserver: ResizeObserver | undefined;

  constructor(
    private readonly monacoApi: typeof monaco,
    private readonly editor: monaco.editor.ICodeEditor,
    private readonly store: RuntimeInspectionStore,
    private readonly inspectableModelUri: string,
  ) {
    this.domNode = document.createElement('div');
    this.domNode.className = 'runtime-live-value-widget';
    this.domNode.hidden = true;
    this.domNode.setAttribute('role', 'status');
    this.domNode.setAttribute('aria-label', 'Live runtime value');
    this.domNode.setAttribute('aria-live', 'off');

    const title = document.createElement('div');
    title.className = 'runtime-live-value-title';
    const indicator = document.createElement('span');
    indicator.className = 'runtime-live-value-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    const titleText = document.createElement('span');
    titleText.textContent = 'Live value';
    title.append(indicator, titleText);

    this.contentNode = document.createElement('div');
    this.contentNode.className = 'runtime-live-value-content';
    this.domNode.append(title, this.contentNode);

    this.editor.addOverlayWidget(this);
    this.resizeObserver = typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(() => {
          if (!this.domNode.hidden) this.editor.layoutOverlayWidget(this);
        });
    this.resizeObserver?.observe(this.domNode);
    this.disposables.push(
      this.editor.onMouseMove((event) => this.handleMouseMove(event)),
      this.editor.onMouseLeave(() => this.hide()),
      this.editor.onDidChangeModel(() => this.reset()),
      this.editor.onDidChangeModelContent(() => this.reset()),
      this.editor.onDidScrollChange(() => this.hide()),
      this.editor.onDidLayoutChange(() => this.editor.layoutOverlayWidget(this)),
      { dispose: this.store.subscribe(() => this.handleStoreUpdate()) },
    );
  }

  getId(): string {
    return WIDGET_ID;
  }

  getDomNode(): HTMLElement {
    return this.domNode;
  }

  getPosition(): monaco.editor.IOverlayWidgetPosition {
    return {
      preference: runtimeValueWidgetCoordinates(
        this.editor.getLayoutInfo(),
        this.domNode.offsetWidth,
        this.domNode.offsetHeight,
      ),
    };
  }

  dispose(): void {
    this.resolutionSequence += 1;
    this.resizeObserver?.disconnect();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.editor.removeOverlayWidget(this);
  }

  private handleMouseMove(event: monaco.editor.IEditorMouseEvent): void {
    if (event.target.type === this.monacoApi.editor.MouseTargetType.CONTENT_WIDGET) return;
    if (event.target.type !== this.monacoApi.editor.MouseTargetType.CONTENT_TEXT || !event.target.position) {
      this.hide();
      return;
    }

    const model = this.editor.getModel();
    if (!model || model.uri.toString() !== this.inspectableModelUri) {
      this.hide();
      return;
    }

    const nextPosition = event.target.position;
    const state = this.store.getState();
    const positionKey = `${model.uri}:${state.version ?? 'none'}:${nextPosition.lineNumber}:${nextPosition.column}`;
    if (positionKey === this.resolvedPositionKey) return;
    this.hoveredPosition = nextPosition;
    this.resolvedPositionKey = positionKey;
    void this.resolveCurrentTarget();
  }

  private handleStoreUpdate(): void {
    if (!this.hoveredPosition) return;
    const version = this.store.getState().version;
    if (this.resolvedVersion !== version) {
      if (this.resolvingVersion === version) return;
      this.resolvedPositionKey = undefined;
      void this.resolveCurrentTarget();
      return;
    }
    this.renderTarget();
  }

  private async resolveCurrentTarget(): Promise<void> {
    const model = this.editor.getModel();
    const position = this.hoveredPosition;
    const sequence = ++this.resolutionSequence;
    const requestedVersion = this.store.getState().version;
    this.resolvingVersion = requestedVersion;
    if (!model || !position || model.uri.toString() !== this.inspectableModelUri) {
      this.resolvingVersion = undefined;
      this.hide();
      return;
    }

    const target = await resolveRuntimeHoverTarget(this.monacoApi, model, position, this.store);
    if (sequence !== this.resolutionSequence || !samePosition(this.hoveredPosition, position) || this.editor.getModel() !== model) return;
    this.resolvingVersion = undefined;
    if (this.store.getState().version !== requestedVersion) {
      this.resolvedPositionKey = undefined;
      void this.resolveCurrentTarget();
      return;
    }
    this.resolvedVersion = requestedVersion;
    this.target = target;
    this.renderTarget();
  }

  private renderTarget(): void {
    if (!this.target) {
      this.hideWidgetOnly();
      return;
    }

    const hover = runtimeHoverForTarget(this.monacoApi, this.target, this.store);
    const markdown = hover?.contents[0]?.value;
    if (!markdown) {
      this.hideWidgetOnly();
      return;
    }

    const wasHidden = this.domNode.hidden;
    this.domNode.hidden = false;
    this.domNode.dataset.running = String(this.store.getState().running);
    if (markdown !== this.renderedMarkdown) {
      this.renderedMarkdown = markdown;
      renderRuntimeMarkdown(this.contentNode, markdown);
    }
    if (wasHidden) this.editor.layoutOverlayWidget(this);
  }

  private hide(): void {
    this.resolutionSequence += 1;
    this.hoveredPosition = undefined;
    this.target = undefined;
    this.resolvedPositionKey = undefined;
    this.resolvedVersion = undefined;
    this.resolvingVersion = undefined;
    this.hideWidgetOnly();
  }

  private reset(): void {
    this.renderedMarkdown = undefined;
    this.hide();
  }

  private hideWidgetOnly(): void {
    this.domNode.hidden = true;
  }
}

function samePosition(left: monaco.Position | undefined, right: monaco.Position): boolean {
  return left?.lineNumber === right.lineNumber && left.column === right.column;
}

export function renderRuntimeMarkdown(container: HTMLElement, markdown: string): void {
  const lines = markdown.split('\n');
  const fragment = document.createDocumentFragment();

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line || line === '---') {
      index += 1;
      continue;
    }

    if (line === '```ts' || line === '```') {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && lines[index] !== '```') code.push(lines[index++]);
      index += 1;
      const pre = document.createElement('pre');
      pre.className = 'runtime-live-value-code';
      pre.textContent = code.join('\n');
      fragment.append(pre);
      continue;
    }

    if (line.startsWith('|') && index + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[index + 1])) {
      const table = document.createElement('table');
      table.className = 'runtime-live-value-table';
      const headers = parseTableRow(line);
      index += 2;
      while (index < lines.length && lines[index].startsWith('|')) {
        const cells = parseTableRow(lines[index++]);
        const row = document.createElement('tr');
        cells.forEach((cell, cellIndex) => {
          const element = document.createElement(cellIndex === 0 ? 'th' : 'td');
          element.textContent = unescapeMarkdown(cell);
          row.append(element);
        });
        table.append(row);
      }
      table.setAttribute('aria-label', headers.map(unescapeMarkdown).join(' and '));
      fragment.append(table);
      continue;
    }

    const paragraph = document.createElement('div');
    paragraph.className = line.startsWith('**') ? 'runtime-live-value-heading' : 'runtime-live-value-line';
    appendInlineMarkdown(paragraph, line);
    fragment.append(paragraph);
    index += 1;
  }

  container.replaceChildren(fragment);
}

function parseTableRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let index = 1; index < line.length - 1; index += 1) {
    const character = line[index];
    if (character === '|' && line[index - 1] !== '\\') {
      cells.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

function appendInlineMarkdown(container: HTMLElement, value: string): void {
  let remaining = value;
  let bold = false;
  while (remaining.length > 0) {
    const marker = remaining.indexOf('**');
    const chunk = marker < 0 ? remaining : remaining.slice(0, marker);
    if (chunk) {
      const node = bold ? document.createElement('strong') : document.createTextNode('');
      node.textContent = unescapeMarkdown(chunk.replace(/^_|_$/g, ''));
      container.append(node);
    }
    if (marker < 0) break;
    bold = !bold;
    remaining = remaining.slice(marker + 2);
  }
}

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([\\`*_{}[\]()#+.!|-])/g, '$1');
}
