import { parseEngineSnapshot, SnapshotValidationError } from "../core/engine";
import type { EngineSnapshot } from "../shared/types";

export const LOCAL_SAVE_KEY = "hex-dominion-save";

export interface SaveStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

/** Read untrusted browser data and remove it atomically when it is unusable. */
export function readLocalSnapshot(storage: SaveStorage): EngineSnapshot | null {
  const raw = storage.getItem(LOCAL_SAVE_KEY);
  if (!raw) return null;
  try {
    return parseEngineSnapshot(JSON.parse(raw) as unknown);
  } catch (reason) {
    storage.removeItem(LOCAL_SAVE_KEY);
    const detail =
      reason instanceof SnapshotValidationError ? reason.message : "The save is not valid JSON";
    throw new SnapshotValidationError(
      `The local campaign was invalid and has been removed. ${detail}`,
    );
  }
}
