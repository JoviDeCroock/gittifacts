/**
 * Small evidence renderings shared by the tour and the evidence page.
 */
import type { EvidenceItem } from "@app/evidence";
import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { artifactUrl } from "../api/client.js";
import { type ItemSummary, itemAnchor, summarize } from "../lib/evidence.js";
import { pct } from "../lib/lanes.js";
import type { Tone } from "../lib/vocab.js";
import { Icon, type IconId } from "./Icon.js";
import { Segmented } from "./ui.js";
import "../styles/evidence-bits.css";

const KIND_ICON: Record<EvidenceItem["kind"], IconId> = {
  "red-green": "test-tube",
  "test-run": "list-checks",
  coverage: "layers",
  mutation: "test-tube",
  "public-api": "file-code",
  dependencies: "package",
  "sensitive-paths": "lock",
  preview: "external-link",
  screenshots: "image",
  "agent-trace": "route",
  transform: "check-circle",
  "llm-judgment": "comment",
  "conflict-resolution": "git-merge",
  quarantine: "triangle-alert",
  "qa-run": "monitor",
};

const TONE_MARK: Record<Tone, string> = { ok: "ok", warn: "warn", danger: "danger", neutral: "neutral", action: "neutral" };

export function EvidenceChip({ item, changeId }: { item: EvidenceItem; changeId: string }) {
  const s: ItemSummary = summarize(item);
  return (
    <a class={`ev-chip ev-chip--${TONE_MARK[s.tone]}`} href={`/changes/${changeId}/evidence#${itemAnchor(item.id)}`}>
      <Icon name={KIND_ICON[item.kind]} size={15} />
      <span class="ev-chip__label">{s.label}</span>
      <span class="ev-chip__value">{s.value}</span>
    </a>
  );
}

export function MissingChip({ id }: { id: string }) {
  return (
    <span class="ev-chip ev-chip--danger" title="The walkthrough cites evidence that is not in the signed bundle.">
      <Icon name="shield-alert" size={15} />
      <span class="ev-chip__label">{id}</span>
      <span class="ev-chip__value">Not in bundle</span>
    </span>
  );
}

export function kindIcon(kind: EvidenceItem["kind"]): IconId {
  return KIND_ICON[kind];
}

// ---------------------------------------------------------------- red → green list

const OUTCOME: Record<string, { label: string; cls: string }> = {
  pass: { label: "pass", cls: "ok" },
  fail: { label: "fail", cls: "danger" },
  error: { label: "error", cls: "danger" },
  missing: { label: "missing", cls: "neutral" },
};

export function RedGreenList({ item, compact = false }: { item: Extract<EvidenceItem, { kind: "red-green" }>; compact?: boolean }) {
  if (item.tests.length === 0) {
    return <p class="rg-empty">No new or changed tests. Nothing here was shown to fail before the change.</p>;
  }
  return (
    <table class={`rg ${compact ? "rg--compact" : ""}`}>
      <thead>
        <tr>
          <th scope="col">Test</th>
          <th scope="col">main</th>
          <th scope="col">change</th>
        </tr>
      </thead>
      <tbody>
        {item.tests.map((t) => {
          const b = item.base.results.find((r) => r.id === t.id)?.outcome ?? "missing";
          const h = item.head.results.find((r) => r.id === t.id)?.outcome ?? "missing";
          const ob = OUTCOME[b] ?? OUTCOME.missing!;
          const oh = OUTCOME[h] ?? OUTCOME.missing!;
          return (
            <tr key={t.id}>
              <th scope="row">
                <span class="rg__name">{t.name}</span>
                {!compact ? <span class="rg__file">{t.file}</span> : null}
              </th>
              <td>
                <span class={`outcome outcome--${ob.cls}`}>
                  <Icon name={b === "pass" ? "check" : b === "missing" ? "minus" : "x"} size={14} />
                  {ob.label}
                </span>
              </td>
              <td>
                <span class={`outcome outcome--${oh.cls}`}>
                  <Icon name={h === "pass" ? "check" : h === "missing" ? "minus" : "x"} size={14} />
                  {oh.label}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------- screenshots (registered pair)

function useArtifact(ref: string | undefined) {
  const url = useSignal<string | null>(null);
  useEffect(() => {
    let live = true;
    if (!ref) return;
    artifactUrl(ref).then((u) => {
      if (live) url.value = u || null;
    });
    return () => {
      live = false;
    };
  }, [ref, url]);
  return url.value;
}

type Shot = Extract<EvidenceItem, { kind: "screenshots" }>["shots"][number];

function ShotImage({ refId, alt }: { refId: string | undefined; alt: string }) {
  const url = useArtifact(refId);
  if (!refId) return <div class="shot__none">No capture</div>;
  if (!url) return <div class="shot__none" aria-busy="true" />;
  return <img src={url} alt={alt} loading="lazy" decoding="async" />;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed to load"));
    img.src = url;
  });
}

/**
 * Registered difference: both captures drawn at the same scale, changed pixels marked in carmine
 * over a faded copy of the "after" frame. Computed in the browser from the two images.
 */
function DiffFrame({ beforeRef, afterRef, label }: { beforeRef: string | undefined; afterRef: string | undefined; label: string }) {
  const before = useArtifact(beforeRef);
  const after = useArtifact(afterRef);
  const canvas = useRef<HTMLCanvasElement>(null);
  const ratio = useSignal<number | null>(null);
  const failed = useSignal(false);
  useEffect(() => {
    if (!before || !after || !canvas.current) return;
    let live = true;
    Promise.all([loadImage(before), loadImage(after)]).then(
      ([a, b]) => {
        const c = canvas.current;
        if (!live || !c) return;
        const w = Math.min(a.naturalWidth, b.naturalWidth);
        const h = Math.min(a.naturalHeight, b.naturalHeight);
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(a, 0, 0, w, h);
        const pa = ctx.getImageData(0, 0, w, h).data;
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(b, 0, 0, w, h);
        const out = ctx.getImageData(0, 0, w, h);
        const pb = out.data;
        let changed = 0;
        const hit = new Uint8Array(w * h);
        for (let i = 0, px = 0; i < pb.length; i += 4, px++) {
          const d = Math.abs(pa[i]! - pb[i]!) + Math.abs(pa[i + 1]! - pb[i + 1]!) + Math.abs(pa[i + 2]! - pb[i + 2]!);
          if (d > 48) {
            hit[px] = 1;
            changed++;
          }
        }
        for (let px = 0; px < w * h; px++) {
          const i = px * 4;
          const near = hit[px] || hit[px - 1] || hit[px + 1] || hit[px - w] || hit[px + w];
          if (near) {
            pb[i] = 200;
            pb[i + 1] = 40;
            pb[i + 2] = 50;
            pb[i + 3] = 255;
          } else {
            const g = 0.299 * pb[i]! + 0.587 * pb[i + 1]! + 0.114 * pb[i + 2]!;
            const v = 255 - (255 - g) * 0.28;
            pb[i] = v;
            pb[i + 1] = v;
            pb[i + 2] = v;
          }
        }
        ctx.putImageData(out, 0, 0);
        ratio.value = changed / (w * h);
      },
      () => {
        if (live) failed.value = true;
      },
    );
    return () => {
      live = false;
    };
  }, [before, after, ratio, failed]);
  if (!beforeRef || !afterRef) return <div class="shot__none">Needs both captures</div>;
  return (
    <>
      <canvas ref={canvas} class="shot__canvas" role="img" aria-label={`${label}: changed pixels marked in red`} />
      {failed.value ? <p class="shot__none">Could not compare the captures.</p> : null}
      {ratio.value !== null ? <span class="sr-only">{pct(ratio.value, 1)} of pixels changed</span> : null}
    </>
  );
}

export function ShotPair({ shot }: { shot: Shot }) {
  const side = useSignal<"before" | "after" | "diff">("after");
  const label = `${shot.route} on ${shot.viewport}`;
  return (
    <figure class={`shot shot--${shot.viewport}`}>
      <figcaption class="shot__head">
        <span class="shot__route">
          <code>{shot.route}</code> · {shot.viewport}
        </span>
        {shot.diffRatio !== undefined ? <span class="shot__diff tnum">{pct(shot.diffRatio, 1)} of pixels differ</span> : null}
      </figcaption>
      <div class="shot__toggle">
        <Segmented
          label={`Show ${label} before, after, or the difference`}
          size="sm"
          value={side.value}
          options={[
            { id: "before", label: "Before" },
            { id: "after", label: "After" },
            { id: "diff", label: "Difference" },
          ]}
          onChange={(v) => (side.value = v)}
        />
      </div>
      <div class="shot__frames" data-show={side.value}>
        <div class="shot__frame shot__frame--before">
          <span class="shot__tag">Before · main</span>
          <div class="shot__img">
            <ShotImage refId={shot.beforeRef} alt={`${label}, before the change`} />
          </div>
        </div>
        <div class="shot__frame shot__frame--after">
          <span class="shot__tag">After · this change</span>
          <div class="shot__img">
            <ShotImage refId={shot.afterRef} alt={`${label}, after the change`} />
          </div>
        </div>
        <div class="shot__frame shot__frame--diff">
          <span class="shot__tag">Difference</span>
          <div class="shot__img">
            <DiffFrame beforeRef={shot.beforeRef} afterRef={shot.afterRef} label={label} />
          </div>
        </div>
      </div>
    </figure>
  );
}
