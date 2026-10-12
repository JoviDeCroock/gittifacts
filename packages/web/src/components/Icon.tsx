/**
 * One icon system: Lucide (ISC), rendered from its icon nodes at one stroke weight.
 */

import {
  Activity,
  Archive,
  ArrowUpRight,
  BadgeCheck,
  Ban,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleQuestionMark,
  CircleX,
  Clock,
  CodeXml,
  Copy,
  ExternalLink,
  Eye,
  FileCode,
  FileText,
  Flag,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Globe,
  type IconNode,
  Image,
  Info,
  KeyRound,
  Layers,
  ListChecks,
  ListOrdered,
  LoaderCircle,
  Lock,
  LogOut,
  Menu,
  MessageSquareText,
  Minus,
  Monitor,
  Moon,
  Package,
  Pause,
  Plug,
  Plus,
  Power,
  Rocket,
  RotateCw,
  Route,
  ScrollText,
  Search,
  Send,
  Server,
  ShieldAlert,
  ShieldCheck,
  Signature,
  Sun,
  TestTubeDiagonal,
  Timer,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
  User,
  Webhook,
  X,
} from "lucide";
import { h } from "preact";

const ICONS = {
  "arrow-up-right": ArrowUpRight,
  ban: Ban,
  "badge-check": BadgeCheck,
  bot: Bot,
  check: Check,
  "chevron-down": ChevronDown,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  "chevron-up": ChevronUp,
  "check-circle": CircleCheck,
  "circle-dashed": CircleDashed,
  "circle-dot": CircleDot,
  help: CircleQuestionMark,
  "x-circle": CircleX,
  clock: Clock,
  copy: Copy,
  "external-link": ExternalLink,
  eye: Eye,
  "file-code": FileCode,
  "file-text": FileText,
  flag: Flag,
  "git-branch": GitBranch,
  "git-merge": GitMerge,
  "git-commit": GitCommitHorizontal,
  folder: Folder,
  code: CodeXml,
  activity: Activity,
  image: Image,
  info: Info,
  key: KeyRound,
  layers: Layers,
  "list-checks": ListChecks,
  "list-ordered": ListOrdered,
  loader: LoaderCircle,
  lock: Lock,
  "log-out": LogOut,
  menu: Menu,
  comment: MessageSquareText,
  minus: Minus,
  monitor: Monitor,
  moon: Moon,
  package: Package,
  pause: Pause,
  plug: Plug,
  plus: Plus,
  power: Power,
  redo: RotateCw,
  rocket: Rocket,
  route: Route,
  "scroll-text": ScrollText,
  search: Search,
  send: Send,
  server: Server,
  "shield-alert": ShieldAlert,
  "shield-check": ShieldCheck,
  signature: Signature,
  sun: Sun,
  "test-tube": TestTubeDiagonal,
  timer: Timer,
  trash: Trash2,
  "triangle-alert": TriangleAlert,
  undo: Undo2,
  upload: Upload,
  user: User,
  webhook: Webhook,
  globe: Globe,
  archive: Archive,
  x: X,
} satisfies Record<string, IconNode>;

export type IconId = keyof typeof ICONS;

interface IconProps {
  name: IconId;
  size?: number;
  /** When set, the icon is announced; otherwise it is decorative. */
  label?: string;
  class?: string;
}

export function Icon({ name, size = 18, label, class: cls }: IconProps) {
  const node = ICONS[name];
  return h(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.9,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      class: cls ? `icon ${cls}` : "icon",
      role: label ? "img" : undefined,
      "aria-label": label,
      "aria-hidden": label ? undefined : "true",
      focusable: "false",
    },
    node.map(([tag, attrs]) => h(tag, attrs)),
  );
}

/** GitHub mark from Octicons (MIT). Used only on the "Continue with GitHub" button. */
export function GitHubMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      class="icon"
    >
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}
