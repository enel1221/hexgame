export type RendererContextStatus = "lost" | "restored";

export interface ContextRecoveryHandlers {
  onLost(): void;
  onRestored(): void;
}

/**
 * Bind the browser's cancelable WebGL recovery events with duplicate-event
 * suppression. Returning an unbind function keeps renderer teardown exact.
 */
export function bindWebGlContextRecovery(
  canvas: EventTarget,
  handlers: ContextRecoveryHandlers,
): () => void {
  let lost = false;
  const onLost = (event: Event): void => {
    event.preventDefault();
    if (lost) return;
    lost = true;
    handlers.onLost();
  };
  const onRestored = (): void => {
    if (!lost) return;
    lost = false;
    handlers.onRestored();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  return () => {
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
  };
}
