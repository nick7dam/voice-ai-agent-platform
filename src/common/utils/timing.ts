export function nowIso(): string {
  return new Date().toISOString();
}

export function elapsedMs(startedAt: bigint): number {
  return Number((process.hrtime.bigint() - startedAt) / BigInt(1_000_000));
}
