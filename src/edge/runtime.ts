export type SqlPrimitive = string | number | ArrayBuffer | null;

export interface SqlCursor<Row> extends Iterable<Row> {
  toArray(): Row[];
}

export interface SqlStorage {
  exec<Row = Record<string, SqlPrimitive>>(
    query: string,
    ...bindings: SqlPrimitive[]
  ): SqlCursor<Row>;
}

export interface DurableStorage {
  readonly sql: SqlStorage;
  transactionSync<Result>(callback: () => Result): Result;
  setAlarm(timestamp: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface HibernatingWebSocket extends WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface DurableState {
  readonly storage: DurableStorage;
  blockConcurrencyWhile<Result>(callback: () => Promise<Result>): Promise<Result>;
  acceptWebSocket(socket: HibernatingWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): HibernatingWebSocket[];
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

export interface MultiplayerEnv {
  ROOMS: DurableObjectNamespace;
  ALLOWED_ORIGINS?: string;
  ROOM_TTL_SECONDS?: string;
  COMMAND_LEAD_TICKS?: string;
}

export interface HibernatingWebSocketPair {
  0: HibernatingWebSocket;
  1: HibernatingWebSocket;
}

export function createWebSocketPair(): HibernatingWebSocketPair {
  // WebSocketPair is supplied by the Workers runtime, not the browser DOM lib.
  const workerGlobal = globalThis as typeof globalThis & {
    WebSocketPair: { new (): HibernatingWebSocketPair };
  };
  return new workerGlobal.WebSocketPair();
}
