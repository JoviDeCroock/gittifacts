/**
 * The gittifacts mark: the lane tag silhouette (chamfered end, punched hole) with three printed
 * lines. No runtime dependencies, so the prerendered landing page can use it too.
 */
export function BrandMark({ size = 22 }: { size?: number }) {
  const w = Math.round(size * 1.45);
  return (
    <svg
      class="brand-mark"
      width={w}
      height={size}
      viewBox="0 0 32 22"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M7.5 1 H29 Q31 1 31 3 V19 Q31 21 29 21 H7.5 L1 14.2 V7.8 Z M11.4 11 a2.2 2.2 0 1 0 -4.4 0 a2.2 2.2 0 1 0 4.4 0 Z"
        fill-rule="evenodd"
      />
      <path d="M16 7.2 h10.5 M16 11 h10.5 M16 14.8 h6.5" class="brand-mark__lines" />
    </svg>
  );
}
