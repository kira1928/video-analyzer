/**
 * Yields to the main thread to allow the browser to paint UI updates.
 * This is useful for ensuring UI changes are rendered before a long-running task.
 * It uses `requestAnimationFrame` and `setTimeout(0)` to resolve the promise
 * *after* the next paint cycle.
 *
 * @returns A promise that resolves after the next browser paint.
 */
export function yieldToMain(): Promise<void> {
  return new Promise(resolve => {
    const hasRaf =
      typeof requestAnimationFrame === 'function';
    const isDocumentHidden =
      typeof document !== 'undefined' && (document as any).hidden === true;

    if (!hasRaf || isDocumentHidden) {
      // Fallback for environments without requestAnimationFrame or when
      // the document is hidden, where rAF can be heavily throttled.
      setTimeout(resolve, 0);
      return;
    }
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}
