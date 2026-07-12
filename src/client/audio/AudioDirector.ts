import type { GameEvent, GameEventType, GameState } from "@/src/shared/types";

interface ToneSpec {
  frequency: number;
  endFrequency: number;
  duration: number;
  gain: number;
  wave: OscillatorType;
}

const TONES: Partial<Record<GameEventType, ToneSpec>> = {
  order: { frequency: 310, endFrequency: 440, duration: 0.12, gain: 0.035, wave: "triangle" },
  "battle-started": {
    frequency: 92,
    endFrequency: 68,
    duration: 0.22,
    gain: 0.055,
    wave: "sawtooth",
  },
  reinforcement: {
    frequency: 430,
    endFrequency: 690,
    duration: 0.18,
    gain: 0.045,
    wave: "triangle",
  },
  capture: { frequency: 260, endFrequency: 520, duration: 0.32, gain: 0.055, wave: "triangle" },
  "construction-complete": {
    frequency: 520,
    endFrequency: 760,
    duration: 0.22,
    gain: 0.035,
    wave: "sine",
  },
  elimination: { frequency: 160, endFrequency: 55, duration: 0.55, gain: 0.065, wave: "sawtooth" },
  victory: { frequency: 330, endFrequency: 880, duration: 0.72, gain: 0.075, wave: "triangle" },
};

export class AudioDirector {
  private context: AudioContext | null = null;
  private enabled: boolean;
  private lastEventId = -1;
  private lastBattleImpactTick = -100;
  private lastTurretTick = -100;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled && this.context) void this.context.suspend();
    else if (enabled && this.context?.state === "suspended") void this.context.resume();
  }

  unlock(): void {
    if (!this.enabled) return;
    this.context ??= new AudioContext();
    if (this.context.state === "suspended") void this.context.resume();
  }

  playSelection(): void {
    this.play({ frequency: 620, endFrequency: 720, duration: 0.07, gain: 0.022, wave: "sine" });
  }

  consume(events: GameEvent[], state?: GameState, localPlayerId = 0): void {
    for (const event of events) {
      if (event.id <= this.lastEventId) continue;
      this.lastEventId = event.id;
      const tone =
        event.type === "victory" && event.playerId !== localPlayerId
          ? TONES.elimination
          : TONES[event.type];
      if (tone) this.play(tone);
    }
    if (!state || state.battles.length === 0) return;
    if (state.tick - this.lastBattleImpactTick >= 18) {
      this.lastBattleImpactTick = state.tick;
      this.play({ frequency: 118, endFrequency: 74, duration: 0.09, gain: 0.022, wave: "square" });
    }
    const defendedByTurret = state.battles.some((battle) => {
      const structure = state.map.tiles[battle.tileId]?.structure;
      return structure?.type === "turret" && structure.status !== "constructing";
    });
    if (defendedByTurret && state.tick - this.lastTurretTick >= 26) {
      this.lastTurretTick = state.tick;
      this.play({
        frequency: 210,
        endFrequency: 52,
        duration: 0.16,
        gain: 0.038,
        wave: "sawtooth",
      });
    }
  }

  destroy(): void {
    if (this.context) void this.context.close();
    this.context = null;
  }

  private play(spec: ToneSpec): void {
    if (!this.enabled) return;
    this.context ??= new AudioContext();
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    const filter = this.context.createBiquadFilter();
    oscillator.type = spec.wave;
    oscillator.frequency.setValueAtTime(spec.frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(20, spec.endFrequency),
      now + spec.duration,
    );
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(1800, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(spec.gain, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + spec.duration);
    oscillator.connect(filter).connect(gain).connect(this.context.destination);
    oscillator.start(now);
    oscillator.stop(now + spec.duration + 0.02);
  }
}
