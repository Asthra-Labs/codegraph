let vectorFallbackCount = 0;

export function resetVectorFallbackCount(): void {
  vectorFallbackCount = 0;
}

export function incrementVectorFallbackCount(): void {
  vectorFallbackCount += 1;
}

export function getVectorFallbackCount(): number {
  return vectorFallbackCount;
}
