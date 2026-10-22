import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const COPIED_STYLE_ATTRIBUTE = 'data-popout-style';

// Closing waits a tick so StrictMode's simulated unmount/remount doesn't close a window still in use.
const pendingCloses = new WeakMap<Window, number>();

/**
 * Opens a same-origin browser window for `PopoutWindow` to render into.
 * Call this from a click handler so popup blockers treat it as user-initiated.
 * Returns undefined when the browser blocks the popup.
 */
export function openPopoutWindow(name: string, width = 1280, height = 820): Window | undefined {
  const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
  return window.open('', name, `popup,width=${width},height=${height},left=${left},top=${top}`) ?? undefined;
}

/**
 * Renders children into another window while keeping them in this React tree, so they
 * receive live props and state. Stylesheets are mirrored from the opener, including
 * Vite's dev-time style updates.
 */
export function PopoutWindow({ target, title, onClose, children }: {
  target: Window;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [container, setContainer] = useState<HTMLElement>();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    window.clearTimeout(pendingCloses.get(target));
    pendingCloses.delete(target);
    const popoutDocument = target.document;
    popoutDocument.title = title;
    popoutDocument.documentElement.lang = document.documentElement.lang;

    // Mirror stylesheets incrementally so unrelated head changes don't restyle the whole window.
    const copies = new Map<Element, HTMLElement>();
    popoutDocument.head.querySelectorAll(`[${COPIED_STYLE_ATTRIBUTE}]`).forEach((node) => node.remove());
    const syncStyles = () => {
      const originals = new Set(document.head.querySelectorAll('style, link[rel="stylesheet"]'));
      for (const [original, copy] of copies) {
        if (originals.has(original)) continue;
        copy.remove();
        copies.delete(original);
      }
      for (const original of originals) {
        const copy = copies.get(original);
        if (!copy) {
          const nextCopy = original.cloneNode(true) as HTMLElement;
          nextCopy.setAttribute(COPIED_STYLE_ATTRIBUTE, '');
          popoutDocument.head.appendChild(nextCopy);
          copies.set(original, nextCopy);
        } else if (original instanceof HTMLStyleElement && copy.textContent !== original.textContent) {
          copy.textContent = original.textContent;
        }
      }
    };
    syncStyles();
    const styleObserver = new MutationObserver(syncStyles);
    styleObserver.observe(document.head, { childList: true, subtree: true, characterData: true });

    // Reuse the root if this named window was already open, otherwise mount a fresh one.
    popoutDocument.body.replaceChildren();
    const root = popoutDocument.createElement('div');
    root.className = 'h-screen';
    popoutDocument.body.appendChild(root);
    setContainer(root);

    const handleTargetClosed = () => onCloseRef.current();
    const closeTarget = () => target.close();
    target.addEventListener('pagehide', handleTargetClosed);
    window.addEventListener('pagehide', closeTarget);

    return () => {
      styleObserver.disconnect();
      target.removeEventListener('pagehide', handleTargetClosed);
      window.removeEventListener('pagehide', closeTarget);
      pendingCloses.set(target, window.setTimeout(closeTarget));
    };
  }, [target, title]);

  return container ? createPortal(children, container) : null;
}
