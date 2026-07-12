import { describe, expect, it, vi } from "vitest";
import { bindWebGlContextRecovery } from "../../src/client/render/contextRecovery";

describe("WebGL context recovery binding", () => {
  it("prevents context disposal and emits one lost/restored transition", () => {
    const canvas = new EventTarget();
    const onLost = vi.fn();
    const onRestored = vi.fn();
    const unbind = bindWebGlContextRecovery(canvas, { onLost, onRestored });

    const lost = new Event("webglcontextlost", { cancelable: true });
    expect(canvas.dispatchEvent(lost)).toBe(false);
    expect(lost.defaultPrevented).toBe(true);
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(onLost).toHaveBeenCalledTimes(1);

    canvas.dispatchEvent(new Event("webglcontextrestored"));
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(onRestored).toHaveBeenCalledTimes(1);

    unbind();
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(onLost).toHaveBeenCalledTimes(1);
  });
});
