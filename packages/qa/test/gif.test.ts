import { describe, expect, it } from "vitest";
import { GIF_ENCODER_SOURCE, REPLAY_PAGE_SCRIPT } from "../src/index.js";

type Encode = (
  frames: { rgba: Uint8ClampedArray }[],
  w: number,
  h: number,
  delayCs: number,
) => Uint8Array;
const gifEncode = new Function(`${GIF_ENCODER_SOURCE}; return gifEncode;`)() as Encode;

/** Minimal GIF LZW decoder for one image's sub-blocks (enough to check the encoder round-trips). */
function decodeFrames(gif: Uint8Array): number[][] {
  let p = 13 + 768;
  const frames: number[][] = [];
  while (p < gif.length) {
    const tag = gif[p];
    if (tag === 0x3b) break;
    if (tag === 0x21) {
      p += 2;
      while (gif[p] !== 0) p += (gif[p] as number) + 1;
      p++;
      continue;
    }
    expect(tag).toBe(0x2c);
    p += 10;
    const min = gif[p++] as number;
    const data: number[] = [];
    while (gif[p] !== 0) {
      const len = gif[p] as number;
      data.push(...gif.subarray(p + 1, p + 1 + len));
      p += len + 1;
    }
    p++;
    const clear = 1 << min;
    let size = min + 1;
    let dict: number[][] = [];
    const reset = () => {
      dict = Array.from({ length: clear + 2 }, (_, i) => [i]);
      size = min + 1;
    };
    reset();
    const out: number[] = [];
    let bit = 0;
    let prev: number[] | null = null;
    for (;;) {
      let code = 0;
      for (let i = 0; i < size; i++, bit++)
        code |= (((data[bit >> 3] as number) >> (bit & 7)) & 1) << i;
      if (code === clear) {
        reset();
        prev = null;
        continue;
      }
      if (code === clear + 1) break;
      const entry: number[] =
        code < dict.length
          ? (dict[code] as number[])
          : [...(prev as number[]), (prev as number[])[0] as number];
      out.push(...entry);
      if (prev !== null && dict.length < 4096) dict.push([...prev, entry[0] as number]);
      if (dict.length === 1 << size && size < 12) size++;
      prev = entry;
    }
    frames.push(out);
  }
  return frames;
}

describe("GIF encoder (runs in the QA browser)", () => {
  it("writes a looping GIF89a whose frames decode back to the quantized pixels", () => {
    const w = 40;
    const h = 30;
    const frame = (seed: number) => {
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        rgba[i * 4] = (i * seed) % 256;
        rgba[i * 4 + 1] = (i * 7 + seed) % 256;
        rgba[i * 4 + 2] = i % 3 === 0 ? 255 : 0;
        rgba[i * 4 + 3] = 255;
      }
      return { rgba };
    };
    const frames = [frame(3), frame(11)];
    const gif = gifEncode(frames, w, h, 90);
    expect(String.fromCharCode(...gif.subarray(0, 6))).toBe("GIF89a");
    expect(gif[gif.length - 1]).toBe(0x3b);
    expect(new TextDecoder().decode(gif)).toContain("NETSCAPE2.0");
    const decoded = decodeFrames(gif);
    expect(decoded).toHaveLength(2);
    frames.forEach((f, n) => {
      const want = Array.from(
        { length: w * h },
        (_, p) =>
          Math.round((f.rgba[p * 4] as number) / 51) * 42 +
          Math.round((f.rgba[p * 4 + 1] as number) / 42.5) * 6 +
          Math.round((f.rgba[p * 4 + 2] as number) / 51),
      );
      expect(decoded[n]).toEqual(want);
    });
  });

  it("handles a frame large enough to fill and clear the code table", () => {
    const w = 320;
    const h = 200;
    const rgba = new Uint8ClampedArray(w * h * 4).map((_, i) => (i * 2654435761) % 251);
    const gif = gifEncode([{ rgba }], w, h, 50);
    expect(decodeFrames(gif)[0]).toHaveLength(w * h);
  });

  it("the page script is plain JS a browser can evaluate (no bundler helpers)", () => {
    expect(() => new Function(`return (${REPLAY_PAGE_SCRIPT});`)).not.toThrow();
    expect(REPLAY_PAGE_SCRIPT).not.toContain("__name");
  });
});
