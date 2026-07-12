/** Serializes async message work while allowing a failed item to leave the queue usable. */
export class OrderedAsyncQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue(task: () => void | Promise<void>): Promise<void> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }

  whenIdle(): Promise<void> {
    return this.tail;
  }
}
