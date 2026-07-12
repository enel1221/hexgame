import { BALANCE } from "../../shared/balance";
import type { GameEvent, GameState } from "../../shared/types";

export type EventInput = Omit<GameEvent, "id" | "tick">;

export function emitEvent(state: GameState, event: EventInput): GameEvent {
  const created: GameEvent = {
    id: state.nextEntityId,
    tick: state.tick,
    ...event,
  };
  state.nextEntityId += 1;
  state.events.push(created);
  if (state.events.length > BALANCE.maxRecentEvents) {
    state.events.splice(0, state.events.length - BALANCE.maxRecentEvents);
  }
  return created;
}
