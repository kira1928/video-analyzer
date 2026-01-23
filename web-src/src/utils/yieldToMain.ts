/**
 * Yields to the main thread to allow the browser to process UI updates and other tasks.
 * This is a more efficient and reliable way to prevent long-running tasks from blocking
 * the UI than using `setTimeout(..., 0)`.
 *
 * @returns A promise that resolves on the next animation frame.
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
