/** Min-heap ordered by (at, seq): deterministic tie-breaking for the discrete-event loop. */
export class EventHeap<T> {
  private readonly items: { at: number; seq: number; v: T }[] = [];
  private seq = 0;

  get size(): number {
    return this.items.length;
  }

  push(at: number, v: T): void {
    const item = { at, seq: this.seq++, v };
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const pi = a[p];
      if (pi === undefined || pi.at < item.at || (pi.at === item.at && pi.seq < item.seq)) break;
      a[i] = pi;
      i = p;
    }
    a[i] = item;
  }

  pop(): { at: number; v: T } | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (top === undefined || last === undefined) return undefined;
    if (a.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        const cur = (k: number) => (k === i ? last : a[k]);
        const less = (x: number, y: number): boolean => {
          const ax = cur(x);
          const ay = cur(y);
          if (ax === undefined || ay === undefined) return false;
          return ax.at < ay.at || (ax.at === ay.at && ax.seq < ay.seq);
        };
        if (l < a.length && less(l, m)) m = l;
        if (r < a.length && less(r, m)) m = r;
        if (m === i) break;
        const mv = a[m];
        if (mv === undefined) break;
        a[i] = mv;
        i = m;
      }
      a[i] = last;
    }
    return { at: top.at, v: top.v };
  }
}
