/**
 * Yields to the main thread to allow the browser to process UI updates and other tasks.
 * This is a more efficient and reliable way to prevent long-running tasks from blocking
 * the UI than using `setTimeout(..., 0)`.
 *
 * @returns A promise that resolves on the next animation frame.
 */
export function yieldToMain(): Promise<void> {
  return new Promise(resolve => {
    requestAnimationFrame(() => resolve());
  });
}
