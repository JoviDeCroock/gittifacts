/**
 * The palette (⌘K, Ctrl+K or /): go anywhere, act on what's in view, or hand it to an agent.
 *
 * Two hands. "Do it myself" runs the command. "Hand to an agent" copies the agent twin, the MCP
 * call (Enter) or CLI command (Shift+Enter), and lists the acts a product rule keeps human with
 * that rule, so delegating never guesses at what an agent may do.
 */
import { signal, useComputed, useSignal } from "@preact/signals";
import { useLocation } from "preact-iso";
import { useEffect, useRef } from "preact/hooks";
import { cliCommand } from "../lib/cli.js";
import { type Command, cliArgs, commandsFor, forMode, match, mcpText, type Mode, type RepoRef } from "../lib/commands.js";
import { themePref } from "../state/prefs.js";
import { Icon } from "./Icon.js";

export const paletteOpen = signal(false);
/** Repos the sidebar already loaded; the palette lists them as places. */
export const paletteRepos = signal<RepoRef[]>([]);

const MODE_KEY = "gf:palette-mode";
function readMode(): Mode {
  try {
    return window.localStorage.getItem(MODE_KEY) === "agent" ? "agent" : "me";
  } catch {
    return "me";
  }
}
function writeMode(m: Mode): void {
  try {
    window.localStorage.setItem(MODE_KEY, m);
  } catch {
    /* storage unavailable: the mode lasts for this page */
  }
}

function editable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/** ⌘K / Ctrl+K anywhere, `/` outside text fields. */
export function usePaletteShortcut(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        paletteOpen.value = !paletteOpen.value;
      } else if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !editable(e.target) && !paletteOpen.value) {
        e.preventDefault();
        paletteOpen.value = true;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** The trigger in the sidebar and the phone top bar. */
export function PaletteButton({ compact = false }: { compact?: boolean }) {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  if (compact) {
    return (
      <button type="button" class="icon-btn" aria-label="Search, act or hand to an agent" aria-haspopup="dialog" onClick={() => (paletteOpen.value = true)} data-testid="palette-open">
        <Icon name="search" size={21} />
      </button>
    );
  }
  return (
    <button type="button" class="palette-trigger" aria-haspopup="dialog" onClick={() => (paletteOpen.value = true)} data-testid="palette-open">
      <Icon name="search" size={16} />
      <span class="palette-trigger__label">Search or act</span>
      <kbd class="kbd" aria-label={mac ? "Command K" : "Control K"}>{mac ? "⌘K" : "Ctrl K"}</kbd>
    </button>
  );
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function TwinPane({ cmd, copied, onCopy }: { cmd: Command | null; copied: string | null; onCopy: (kind: "mcp" | "cli") => void }) {
  if (!cmd) return null;
  if (!cmd.twin) {
    return (
      <div class="palette__twin palette__twin--person" data-testid="palette-twin">
        <Icon name="shield-check" size={16} />
        <p>{cmd.personOnly ?? "No agent equivalent yet."}</p>
      </div>
    );
  }
  const mcp = mcpText(cmd.twin);
  const cli = cliCommand(cliArgs(cmd.twin));
  return (
    <div class="palette__twin" data-testid="palette-twin">
      <div class="palette__twinrow">
        <span class="palette__twinlabel">MCP</span>
        <code class="palette__code" data-testid="palette-mcp">{mcp}</code>
        <button type="button" class="btn btn--quiet btn--sm" onClick={() => onCopy("mcp")} aria-label="Copy the MCP call">
          <Icon name={copied === "mcp" ? "check" : "copy"} size={15} />
        </button>
      </div>
      <div class="palette__twinrow">
        <span class="palette__twinlabel">CLI</span>
        <code class="palette__code">gittifacts {cliArgs(cmd.twin)}</code>
        <button type="button" class="btn btn--quiet btn--sm" onClick={() => onCopy("cli")} aria-label="Copy the CLI command" title={cli}>
          <Icon name={copied === "cli" ? "check" : "copy"} size={15} />
        </button>
      </div>
    </div>
  );
}

export function Palette() {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const { path, route } = useLocation();
  const query = useSignal("");
  const mode = useSignal<Mode>(readMode());
  const active = useSignal(0);
  const copied = useSignal<"mcp" | "cli" | null>(null);
  const status = useSignal("");
  const closing = useSignal(false);

  const list = useComputed(() => match(forMode(commandsFor(path, paletteRepos.value), mode.value, path), query.value));
  const items = list.value;
  const current = items[Math.min(active.value, items.length - 1)] ?? null;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (paletteOpen.value && !d.open) {
      query.value = "";
      active.value = 0;
      copied.value = null;
      status.value = "";
      d.showModal();
      input.current?.focus();
    } else if (!paletteOpen.value && d.open && !closing.value) {
      closing.value = true;
      const done = () => {
        closing.value = false;
        d.close();
      };
      // Leave with the exit animation when there is one; a fallback timer when it never fires.
      const t = window.setTimeout(done, 260);
      d.addEventListener("animationend", () => (window.clearTimeout(t), done()), { once: true });
    }
  }, [paletteOpen.value]);

  // Close on navigation.
  useEffect(() => {
    paletteOpen.value = false;
  }, [path]);

  function close() {
    paletteOpen.value = false;
  }

  async function handOff(cmd: Command, kind: "mcp" | "cli") {
    if (!cmd.twin) return;
    const text = kind === "mcp" ? mcpText(cmd.twin) : cliCommand(cliArgs(cmd.twin));
    const ok = await copy(text);
    copied.value = ok ? kind : null;
    status.value = ok ? `Copied the ${kind === "mcp" ? "MCP call" : "CLI command"}. Paste it to your agent.` : "Couldn't copy. Select the text and copy it.";
  }

  function run(cmd: Command, shift = false) {
    if (mode.value === "agent") {
      if (cmd.twin) void handOff(cmd, shift ? "cli" : "mcp");
      return;
    }
    const act = cmd.act;
    if (!act) return;
    close();
    if (act.kind === "go") {
      if (act.server) window.location.assign(act.href);
      else route(act.href);
    } else if (act.kind === "theme") {
      themePref.value = act.value;
    } else {
      window.dispatchEvent(new CustomEvent("gf:command", { detail: act.name }));
    }
  }

  function setMode(m: Mode) {
    mode.value = m;
    writeMode(m);
    active.value = 0;
    copied.value = null;
    status.value = "";
    input.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent) {
    const n = items.length;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      active.value = n ? (active.value + 1) % n : 0;
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      active.value = n ? (active.value - 1 + n) % n : 0;
    } else if (e.key === "Enter" && current) {
      e.preventDefault();
      // ⌘/Ctrl+Enter hands any command to an agent without switching modes.
      if ((e.metaKey || e.ctrlKey) && current.twin) void handOff(current, e.shiftKey ? "cli" : "mcp");
      else run(current, e.shiftKey);
    }
  }

  // The active row stays in view while arrowing through a long list.
  useEffect(() => {
    ref.current?.querySelector(`[data-index="${active.value}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active.value]);

  let lastGroup = "";
  const agent = mode.value === "agent";
  return (
    <dialog
      ref={ref}
      class={`palette ${closing.value ? "is-closing" : ""} ${agent ? "palette--agent" : ""}`}
      aria-label="Search, act or hand to an agent"
      onCancel={(e) => (e.preventDefault(), close())}
      onClick={(e) => e.target === ref.current && close()}
      data-testid="palette"
      data-mode={mode.value}
    >
      <div class="palette__head">
        <Icon name="search" size={18} />
        <input
          ref={input}
          class="palette__input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={current ? `pal-${current.id}` : undefined}
          aria-autocomplete="list"
          placeholder={agent ? "What should your agent do?" : "Go to, act, or search"}
          value={query.value}
          onInput={(e) => ((query.value = e.currentTarget.value), (active.value = 0))}
          onKeyDown={onKeyDown}
          autocomplete="off"
          spellcheck={false}
        />
        <div class="palette__modes" role="radiogroup" aria-label="Who does it">
          {(["me", "agent"] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode.value === m} class="palette__mode" onClick={() => setMode(m)} data-testid={`palette-mode-${m}`}>
              <Icon name={m === "me" ? "user" : "bot"} size={15} />
              <span>{m === "me" ? "Myself" : "An agent"}</span>
            </button>
          ))}
        </div>
      </div>
      <ul id="palette-list" class="palette__list" role="listbox" aria-label={agent ? "Hand to an agent" : "Commands"}>
        {items.length === 0 ? <li class="palette__empty">Nothing matches “{query.value}”.</li> : null}
        {items.map((c, i) => {
          const head = c.group !== lastGroup ? c.group : null;
          lastGroup = c.group;
          const locked = agent && !c.twin;
          return [
            head ? (
              <li key={`g-${head}`} class="palette__group" role="presentation">
                {head}
              </li>
            ) : null,
            <li
              key={c.id}
              id={`pal-${c.id}`}
              role="option"
              aria-selected={c === current}
              aria-disabled={locked ? "true" : undefined}
              class={`palette__item ${c === current ? "is-active" : ""} ${locked ? "is-locked" : ""}`}
              data-index={i}
              data-command={c.id}
              onPointerMove={() => active.value !== i && (active.value = i)}
              onClick={() => ((active.value = i), run(c))}
            >
              <Icon name={c.icon} size={17} />
              <span class="palette__label">{c.label}</span>
              {agent ? (
                c.twin ? <code class="palette__tool">{c.twin.tool}</code> : <span class="palette__person"><Icon name="lock" size={13} /> Only a person</span>
              ) : c.keys ? (
                <span class="palette__keys">{c.keys.map((k) => <kbd key={k} class="kbd">{k}</kbd>)}</span>
              ) : null}
            </li>,
          ];
        })}
      </ul>
      {agent ? <TwinPane cmd={current} copied={copied.value} onCopy={(k) => current && void handOff(current, k)} /> : null}
      <p class="palette__foot">
        <span class="sr-only" role="status">{status.value}</span>
        <span aria-hidden="true">{status.value || (agent ? "↵ copy MCP call · ⇧↵ copy CLI · esc close" : "↵ run · ⌘↵ copy for an agent · esc close")}</span>
      </p>
    </dialog>
  );
}
