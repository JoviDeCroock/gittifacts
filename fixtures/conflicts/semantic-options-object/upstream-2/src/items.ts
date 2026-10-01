const ITEMS = ["apple", "banana", "cherry", "date", "elderberry"];

export interface ListOptions {
  limit?: number;
  offset?: number;
}

export function listItems(options: ListOptions = {}): string[] {
  const { limit = ITEMS.length, offset = 0 } = options;
  return ITEMS.slice(offset, offset + limit);
}
