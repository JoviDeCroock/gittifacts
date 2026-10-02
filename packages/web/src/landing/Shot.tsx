/**
 * Product screenshots (demo data, captured at 2x from the app's mock mode and encoded to
 * AVIF + WebP under public/landing/). Each shot has a light and a dark capture, and wide shots
 * have a phone-width crop for narrow screens. client.ts re-points the dark sources when the
 * visitor forces a theme.
 */

type Dims = Record<string, [number, number]>;
type Theme = { light: Dims; dark: Dims };

/** Encoded sizes: name → theme → width → [width, height]. */
const SHOTS = {
  "tour-phone": {
    light: { 340: [340, 736], 680: [680, 1472] },
    dark: { 340: [340, 736], 680: [680, 1472] },
  },
  "evidence-wide": {
    light: { 640: [640, 331], 1280: [1280, 663] },
    dark: { 640: [640, 338], 1280: [1280, 675] },
  },
  "evidence-narrow": {
    light: { 358: [358, 441], 716: [716, 882] },
    dark: { 358: [358, 449], 716: [716, 898] },
  },
  "rollout-wide": {
    light: { 640: [640, 268], 1280: [1280, 537] },
    dark: { 640: [640, 273], 1280: [1280, 546] },
  },
  "rollout-narrow": {
    light: { 358: [358, 340], 716: [716, 680] },
    dark: { 358: [358, 345], 716: [716, 690] },
  },
  "queue-wide": {
    light: { 640: [640, 162], 1280: [1280, 324] },
    dark: { 640: [640, 162], 1280: [1280, 324] },
  },
  "queue-narrow": {
    light: { 358: [358, 267], 716: [716, 534] },
    dark: { 358: [358, 268], 716: [716, 536] },
  },
} satisfies Record<string, Theme>;

export type ShotName = keyof typeof SHOTS;

const NARROW = "(max-width: 639px)";
const DARK = "(prefers-color-scheme: dark)";

function variant(name: ShotName, theme: keyof Theme) {
  const dims = SHOTS[name][theme] as Dims;
  const widths = Object.keys(dims)
    .map(Number)
    .sort((a, b) => a - b);
  const [w1, w2] = widths as [number, number];
  const [width, height] = dims[w1] as [number, number];
  const url = (w: number, ext: string) => `/landing/${name}-${theme}-${w}.${ext}`;
  const srcset = (ext: string) => `${url(w1, ext)} 1x, ${url(w2, ext)} 2x`;
  return { width, height, srcset, fallback: url(w1, "webp") };
}

interface ShotProps {
  name: ShotName;
  /** A phone-width crop used below 640px. */
  narrow?: ShotName;
  alt: string;
  class?: string;
}

export function Shot({ name, narrow, alt, class: cls }: ShotProps) {
  const sources: { media?: string; theme: "light" | "dark"; shot: ShotName; narrow: boolean }[] =
    [];
  if (narrow)
    sources.push({ media: `${NARROW} and ${DARK}`, theme: "dark", shot: narrow, narrow: true });
  sources.push({ media: DARK, theme: "dark", shot: name, narrow: false });
  if (narrow) sources.push({ media: NARROW, theme: "light", shot: narrow, narrow: true });
  const base = variant(name, "light");
  return (
    <picture class={["shot", cls ?? ""].join(" ")}>
      {sources.flatMap((s) => {
        const v = variant(s.shot, s.theme);
        return (["avif", "webp"] as const).map((ext) => (
          <source
            key={`${s.shot}-${s.theme}-${ext}`}
            type={`image/${ext}`}
            media={s.media}
            srcset={v.srcset(ext)}
            width={v.width}
            height={v.height}
            data-theme-src={s.theme}
            data-narrow={s.narrow ? "" : undefined}
          />
        ));
      })}
      <source
        type="image/avif"
        srcset={base.srcset("avif")}
        width={base.width}
        height={base.height}
      />
      <img
        src={base.fallback}
        srcset={base.srcset("webp")}
        width={base.width}
        height={base.height}
        alt={alt}
        loading="lazy"
        decoding="async"
      />
    </picture>
  );
}
