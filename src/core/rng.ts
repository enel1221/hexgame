/** xmur3 + mulberry32, kept integer-only after string hashing. */
export function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let index = 0; index < seed.length; index += 1) {
    h = Math.imul(h ^ seed.charCodeAt(index), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

export class SeededRng {
  private state: number;

  constructor(seed: string | number) {
    this.state = typeof seed === "string" ? hashSeed(seed) : seed >>> 0;
  }

  nextUint(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error("maxExclusive must be a positive integer");
    }
    return this.nextUint() % maxExclusive;
  }

  range(minInclusive: number, maxExclusive: number): number {
    return minInclusive + this.int(maxExclusive - minInclusive);
  }

  chance(permille: number): boolean {
    return this.int(1000) < permille;
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new Error("Cannot pick from an empty array");
    return values[this.int(values.length)]!;
  }

  shuffle<T>(values: readonly T[]): T[] {
    const output = [...values];
    for (let index = output.length - 1; index > 0; index -= 1) {
      const swap = this.int(index + 1);
      [output[index], output[swap]] = [output[swap]!, output[index]!];
    }
    return output;
  }

  fork(label: string): SeededRng {
    return new SeededRng(`${this.state}:${label}`);
  }
}
