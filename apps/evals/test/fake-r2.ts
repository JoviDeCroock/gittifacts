/** The slice of R2Bucket the ResultStore uses, in memory (unit tests). */
export class FakeBucket {
  readonly objects = new Map<string, string>();
  readonly writes: string[] = [];

  async get(key: string) {
    const v = this.objects.get(key);
    if (v === undefined) return null;
    return { json: async () => JSON.parse(v) as unknown, text: async () => v };
  }

  async put(key: string, value: string) {
    this.objects.set(key, value);
    this.writes.push(key);
    return {};
  }

  async list(opts: { prefix?: string; delimiter?: string; cursor?: string }) {
    const prefix = opts.prefix ?? "";
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    if (!opts.delimiter) {
      return { objects: keys.map((key) => ({ key })), delimitedPrefixes: [], truncated: false };
    }
    const prefixes = new Set<string>();
    const objects: { key: string }[] = [];
    for (const k of keys) {
      const rest = k.slice(prefix.length);
      const i = rest.indexOf(opts.delimiter);
      if (i >= 0) prefixes.add(prefix + rest.slice(0, i + 1));
      else objects.push({ key: k });
    }
    return { objects, delimitedPrefixes: [...prefixes], truncated: false };
  }

  asR2(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}
