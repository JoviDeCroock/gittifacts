const ITEMS = ["apple", "banana", "cherry", "date", "elderberry"];

export function listItems(limit = ITEMS.length): string[] {
  return ITEMS.slice(0, limit);
}
