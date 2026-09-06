const MAX_MS = 3_600_000;

export function defaultBackoff(attempt: number): number {
  const base = 2 ** attempt * 1000;
  return Math.min(base + Math.random() * 1000, MAX_MS);
}
