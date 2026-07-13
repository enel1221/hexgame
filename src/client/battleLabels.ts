export function formatTypeMultiplier(multiplierPermille: number): string {
  return `x${(multiplierPermille / 1000).toFixed(2)}`;
}
