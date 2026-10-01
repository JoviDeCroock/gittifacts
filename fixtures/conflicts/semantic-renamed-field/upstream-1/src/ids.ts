export function nextId(ids: readonly number[]): number {
  return ids.length === 0 ? 1 : Math.max(...ids) + 1;
}
