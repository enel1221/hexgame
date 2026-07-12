import type { EngineSnapshot, MatchConfig } from "../shared/types";

export type CheckpointEncoding = "json" | "base64" | "gzip-base64";

export type RecipientLocalConfig = Pick<
  MatchConfig,
  "playerName" | "graphics" | "sound" | "colorPatterns" | "fullCounts" | "debug"
>;

/** Keep deterministic host state while restoring this recipient's seat and presentation prefs. */
export function localizeCheckpointForRecipient(
  snapshot: EngineSnapshot,
  localPlayerId: number,
  localConfig: RecipientLocalConfig,
): EngineSnapshot {
  return {
    ...snapshot,
    state: {
      ...snapshot.state,
      config: {
        ...snapshot.state.config,
        ...localConfig,
        localPlayerId,
      },
    },
    pendingCommands: [],
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}

async function compressJson(value: string): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") {
    throw new Error("This browser cannot create compact multiplayer checkpoints");
  }
  const compressed = new Blob([value]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

async function decompressJson(bytes: Uint8Array): Promise<string> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot restore compact multiplayer checkpoints");
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const decompressed = new Blob([copy]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(decompressed).text();
}

/** Compress the strict snapshot envelope before crossing the relay frame boundary. */
export async function encodeCheckpoint(snapshot: EngineSnapshot): Promise<{
  encoding: "gzip-base64";
  payload: string;
}> {
  const compressed = await compressJson(JSON.stringify(snapshot));
  return { encoding: "gzip-base64", payload: bytesToBase64(compressed) };
}

/** Decode only; strict schema, reference, and hash validation remains in parseEngineSnapshot. */
export async function decodeCheckpointPayload(
  encoding: CheckpointEncoding,
  payload: string,
): Promise<unknown> {
  if (encoding === "json") return JSON.parse(payload) as unknown;
  if (encoding === "base64") {
    return JSON.parse(new TextDecoder().decode(base64ToBytes(payload))) as unknown;
  }
  return JSON.parse(await decompressJson(base64ToBytes(payload))) as unknown;
}
