/**
 * Shared primitives. Every control ships default, hover, focus, active, disabled and loading.
 */
import type { Lane, TourVerdict } from "@app/domain";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import { describeError } from "../api/client.js";
import type { PrincipalKind } from "../api/types.js";
import { LANES } from "../lib/lanes.js";
import { type StatusMeta, type Tone, VERDICT } from "../lib/vocab.js";
import { Icon, type IconId } from "./Icon.js";

// ---------------------------------------------------------------- button

type ButtonVariant = "primary" | "secondary" | "quiet" | "danger" | "danger-outline";

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "icon" | "size" | "type"> {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  icon?: IconId;
  busy?: boolean;
  busyLabel?: string;
  disabled?: boolean;
  type?: "button" | "submit";
  wide?: boolean;
  children?: ComponentChildren;
}

export function Button({ variant = "secondary", size = "md", icon, busy, busyLabel, disabled, type = "button", wide, children, class: cls, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      class={["btn", `btn--${variant}`, `btn--${size}`, wide ? "btn--wide" : "", cls ?? ""].join(" ")}
      disabled={disabled || busy}
      aria-busy={busy ? "true" : undefined}
    >
      {busy ? <Icon name="loader" class="spin" /> : icon ? <Icon name={icon} /> : null}
      <span>{busy && busyLabel ? busyLabel : children}</span>
    </button>
  );
}

interface LinkButtonProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "icon" | "size" | "href" | "role"> {
  href: string;
  variant?: ButtonVariant;
  size?: "md" | "sm";
  icon?: IconId;
  children?: ComponentChildren;
}

export function LinkButton({ href, variant = "secondary", size = "md", icon, children, class: cls, ...rest }: LinkButtonProps) {
  return (
    <a {...rest} href={href} class={["btn", `btn--${variant}`, `btn--${size}`, cls ?? ""].join(" ")}>
      {icon ? <Icon name={icon} /> : null}
      <span>{children}</span>
    </a>
  );
}

// ---------------------------------------------------------------- status chip

export function StatusChip({ meta, class: cls }: { meta: StatusMeta; class?: string }) {
  return (
    <span class={`chip chip--${meta.tone} ${cls ?? ""}`}>
      <Icon name={meta.icon} size={14} />
      {meta.label}
    </span>
  );
}

export function ToneText({ tone, children }: { tone: Tone; children: ComponentChildren }) {
  return <span class={`tone tone--${tone}`}>{children}</span>;
}

// ---------------------------------------------------------------- lane tag

const TAG_SIZES = { sm: [31, 18], md: [37, 22], lg: [47, 28] } as const;

interface LaneTagProps {
  lane: Lane | null;
  /** Lane 0 computed while shadow mode routes it to a human: dashed outline. */
  shadow?: boolean;
  size?: keyof typeof TAG_SIZES;
  /** Show "Lane 1 · Glance" beside the tag. */
  label?: boolean | "name";
}

/**
 * The lane tag: a die-cut tag with a punched hole, a flat printed band and the lane numeral.
 * Colour is never alone: numeral, shape (dashed = shadow) and the label carry the same meaning.
 */
export function LaneTag({ lane, shadow = false, size = "md", label = false }: LaneTagProps) {
  const [w, h] = TAG_SIZES[size];
  const variant = lane === null ? "none" : shadow ? "shadow" : `l${lane}`;
  const meta = lane === null ? null : LANES[lane];
  const spoken = meta ? `${meta.name}, ${meta.short.toLowerCase()}${shadow ? ", shadow mode" : ""}` : "Not routed yet";
  const r = h / 2;
  const notch = h * 0.3;
  const holeR = Math.max(1.6, h * 0.1);
  const holeX = notch + holeR + h * 0.08;
  const numX = (holeX + holeR + w) / 2 + 0.5;
  // Tag outline with chamfered left end and a punched hole (even-odd fill).
  const body = `M${notch} 0.75 H${w - 3} Q${w - 0.75} 0.75 ${w - 0.75} 3 V${h - 3} Q${w - 0.75} ${h - 0.75} ${w - 3} ${h - 0.75} H${notch} L0.75 ${h - notch} V${notch} Z`;
  const hole = `M${holeX + holeR} ${r} a${holeR} ${holeR} 0 1 0 ${-2 * holeR} 0 a${holeR} ${holeR} 0 1 0 ${2 * holeR} 0 Z`;
  return (
    <span class={`lane-tag lane-tag--${variant} lane-tag--${size}`} title={label ? undefined : spoken}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={spoken}>
        <path class="lane-tag__body" d={`${body} ${hole}`} fill-rule="evenodd" />
        <text class="lane-tag__num" x={numX} y={r} dy="0.36em" text-anchor="middle">
          {lane === null ? "–" : lane}
        </text>
      </svg>
      {label && meta ? (
        <span class="lane-tag__label" aria-hidden="true">
          {meta.name}
          {label === true ? <span class="lane-tag__short"> · {shadow ? "Shadow" : meta.short}</span> : null}
        </span>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------- verdict

export function VerdictMark({ verdict, size = 20 }: { verdict: TourVerdict; size?: number }) {
  return (
    <svg class={`verdict-mark verdict-mark--${verdict}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {verdict === "proven" ? (
        <>
          <circle cx="12" cy="12" r="9.5" class="vm-fill" />
          <path d="m7.6 12.4 3 3 5.8-6" class="vm-on" />
        </>
      ) : verdict === "unproven" ? (
        <>
          <circle cx="12" cy="12" r="8.6" class="vm-ring" />
          <path d="M8.5 12h7" class="vm-ink" />
        </>
      ) : (
        <>
          <path d="M12 2.8 22.2 20.6H1.8Z" class="vm-fill" stroke-linejoin="round" />
          <path d="M12 9v5.2" class="vm-on" />
          <circle cx="12" cy="17.4" r="1.25" class="vm-dot" />
        </>
      )}
    </svg>
  );
}

export function VerdictBadge({ verdict, size = "md" }: { verdict: TourVerdict; size?: "sm" | "md" }) {
  const meta = VERDICT[verdict];
  return (
    <span class={`verdict verdict--${verdict} verdict--${size}`} title={meta.explain}>
      <VerdictMark verdict={verdict} size={size === "sm" ? 16 : 18} />
      <span>{meta.label}</span>
    </span>
  );
}

// ---------------------------------------------------------------- people and agents

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase();
}

/** People are circles with initials; agents are squares with a bot glyph; the platform is a server. */
export function Avatar({ kind, name, size = 24 }: { kind: PrincipalKind; name: string; size?: number }) {
  if (kind === "human") {
    return (
      <span class="avatar avatar--human" style={{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px` }} aria-hidden="true">
        {initials(name)}
      </span>
    );
  }
  return (
    <span class={`avatar avatar--${kind}`} style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true">
      <Icon name={kind === "agent" ? "bot" : "server"} size={Math.round(size * 0.66)} />
    </span>
  );
}

export function Who({ kind, name, owner, size = 22, compact = false }: { kind: PrincipalKind; name: string; owner?: string | null; size?: number; compact?: boolean }) {
  const spoken = kind === "agent" ? `Agent ${name}${owner ? `, run by ${owner}` : ""}` : kind === "system" ? `Platform: ${name}` : name;
  return (
    <span class={`who who--${kind}`} aria-label={spoken}>
      <Avatar kind={kind} name={name} size={size} />
      <span class="who__name" aria-hidden="true">
        {name}
        {!compact && kind === "agent" ? <span class="who__role"> agent{owner ? ` of ${owner}` : ""}</span> : null}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------- segmented control

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: { id: T; label: string; count?: number }[];
  onChange: (value: T) => void;
  size?: "md" | "sm";
}

export function Segmented<T extends string>({ label, value, options, onChange, size = "md" }: SegmentedProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent, index: number) => {
    let next = index;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (index + 1) % options.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    else return;
    e.preventDefault();
    const opt = options[next];
    if (!opt) return;
    onChange(opt.id);
    ref.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  };
  return (
    <div class={`segmented segmented--${size}`} role="radiogroup" aria-label={label} ref={ref}>
      {options.map((o, i) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          tabIndex={o.id === value ? 0 : -1}
          class="segmented__opt"
          onClick={() => onChange(o.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {o.label}
          {o.count !== undefined ? <span class="segmented__count tnum">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- meter (measurement with threshold)

interface MeterProps {
  value: number;
  threshold?: number;
  label: string;
  tone?: Tone;
  /** Shown beside the threshold tick. */
  thresholdLabel?: string;
}

export function Meter({ value, threshold, label, tone = "neutral", thresholdLabel }: MeterProps) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div class={`meter meter--${tone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} aria-label={label}>
      <div class="meter__track">
        <div class="meter__fill" style={{ inlineSize: `${v * 100}%` }} />
        {threshold !== undefined ? (
          <div class="meter__tick" style={{ insetInlineStart: `${Math.max(0, Math.min(1, threshold)) * 100}%` }}>
            {thresholdLabel ? <span class="meter__tick-label tnum">{thresholdLabel}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- states

export function Skeleton({ lines = 3, block = false }: { lines?: number; block?: boolean }) {
  return (
    <div class={`skeleton ${block ? "skeleton--block" : ""}`} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} class="skeleton__line" style={{ inlineSize: `${[92, 76, 84, 60, 70][i % 5]}%` }} />
      ))}
    </div>
  );
}

export function Loading({ label, lines = 4 }: { label: string; lines?: number }) {
  return (
    <div class="loading" role="status" aria-live="polite">
      <span class="sr-only">{label}</span>
      <Skeleton lines={lines} />
    </div>
  );
}

export function ErrorState({ error, what, onRetry }: { error: unknown; what: string; onRetry?: () => void }) {
  const copy = describeError(error, what);
  return (
    <div class="state state--error" role="alert">
      <Icon name="triangle-alert" size={22} />
      <div class="state__text">
        <h2 class="state__title">{copy.title}</h2>
        <p>{copy.detail}</p>
      </div>
      {copy.retry && onRetry ? (
        <Button variant="secondary" size="sm" icon="undo" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: IconId; title: string; children?: ComponentChildren; action?: ComponentChildren }) {
  return (
    <div class="state state--empty">
      <Icon name={icon} size={22} />
      <div class="state__text">
        <h2 class="state__title">{title}</h2>
        {children ? <div class="state__body">{children}</div> : null}
      </div>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------- misc

export function Hash({ value, head = 8, tail = 6, full = false }: { value: string; head?: number; tail?: number; full?: boolean }) {
  const shown = full || value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${tail > 0 ? value.slice(-tail) : ""}`;
  return (
    <code class="hash" title={value}>
      {shown}
    </code>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const done = useRef<HTMLSpanElement>(null);
  return (
    <button
      type="button"
      class="btn btn--quiet btn--sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          if (done.current) done.current.textContent = "Copied";
        } catch {
          if (done.current) done.current.textContent = "Select and copy";
        }
      }}
    >
      <Icon name="copy" />
      <span ref={done} aria-live="polite">
        {label}
      </span>
    </button>
  );
}
