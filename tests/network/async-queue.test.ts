import { describe, expect, it } from "vitest";
import { OrderedAsyncQueue } from "../../src/client/asyncQueue";

describe("ordered async room-message queue", () => {
  it("preserves arrival order across a yielding decode and survives rejection", async () => {
    const queue = new OrderedAsyncQueue();
    const observed: string[] = [];
    let releaseDecode!: () => void;
    const decoding = new Promise<void>((resolve) => {
      releaseDecode = resolve;
    });

    const sync = queue.enqueue(async () => {
      observed.push("sync:start");
      await decoding;
      observed.push("sync:restore");
    });
    const live = queue.enqueue(() => {
      observed.push("live:command");
    });

    await Promise.resolve();
    expect(observed).toEqual(["sync:start"]);
    releaseDecode();
    await Promise.all([sync, live]);
    expect(observed).toEqual(["sync:start", "sync:restore", "live:command"]);

    await expect(queue.enqueue(() => Promise.reject(new Error("bad frame")))).rejects.toThrow(
      "bad frame",
    );
    await queue.enqueue(() => {
      observed.push("after:error");
    });
    await queue.whenIdle();
    expect(observed.at(-1)).toBe("after:error");
  });
});
