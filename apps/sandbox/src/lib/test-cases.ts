/**
 * Which test cases a change added or modified, read from the head test file's syntax tree.
 *
 * A test (`it`/`test` and their `.only`/`.concurrent`/`.fails` forms) is changed when a changed
 * line falls inside it. A changed line inside a suite but outside every test (shared setup,
 * helpers, hooks) changes every test of that suite; at the top level, every test of the file.
 * Imports, blank lines and comments are ignored. When a changed region involves a test whose
 * title isn't a static string (`it.each`, template literals with substitutions, computed
 * titles), the whole file is used instead: we would rather run too many tests than miss one.
 */
import type * as TS from "typescript";
import { lazyTs as ts } from "./typescript.js";

export interface StaticTestCase {
  /** Describe titles and the test title. */
  path: string[];
  start: number;
  end: number;
}

interface Block {
  kind: "test" | "suite";
  /** Null when the title is not a static string. */
  title: string | null;
  start: number;
  end: number;
  children: Block[];
  /** `.skip`/`.todo`/`x*`: never runs, so never "changed". */
  inert: boolean;
}

const TEST_FNS = new Set(["it", "test", "xit", "xtest", "fit", "bench"]);
const SUITE_FNS = new Set(["describe", "suite", "context", "xdescribe", "fdescribe"]);
const INERT = new Set(["skip", "todo", "skipIf", "runIf"]);

interface Callee {
  root: string;
  modifiers: string[];
  /** `it.each(table)("title", ...)`: dynamic title. */
  each: boolean;
}

function calleeOf(expr: TS.Expression): Callee | null {
  const modifiers: string[] = [];
  let each = false;
  let e: TS.Expression = expr;
  for (;;) {
    if (ts.isIdentifier(e)) return { root: e.text, modifiers: modifiers.reverse(), each };
    if (ts.isPropertyAccessExpression(e)) {
      modifiers.push(e.name.text);
      e = e.expression;
      continue;
    }
    if (ts.isCallExpression(e)) {
      // it.each([...])(...) / describe.each`table`(...)
      each = true;
      e = e.expression;
      continue;
    }
    if (ts.isTaggedTemplateExpression(e)) {
      each = true;
      e = e.tag;
      continue;
    }
    return null;
  }
}

function staticTitle(arg: TS.Expression | undefined): string | null {
  if (arg === undefined) return null;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  return null;
}

function parseBlocks(source: TS.SourceFile): Block[] {
  const line = (pos: number) => source.getLineAndCharacterOfPosition(pos).line + 1;
  const visit = (node: TS.Node, into: Block[]): void => {
    if (ts.isCallExpression(node)) {
      const callee = calleeOf(node.expression);
      if (callee !== null && (TEST_FNS.has(callee.root) || SUITE_FNS.has(callee.root))) {
        const isSuite = SUITE_FNS.has(callee.root);
        const inert =
          callee.root.startsWith("x") || callee.modifiers.some((m) => INERT.has(m)) || callee.root === "bench";
        const block: Block = {
          kind: isSuite ? "suite" : "test",
          title: callee.each || callee.modifiers.includes("each") ? null : staticTitle(node.arguments[0]),
          start: line(node.getStart(source)),
          end: line(node.getEnd()),
          children: [],
          inert,
        };
        into.push(block);
        for (const arg of node.arguments) visit(arg, block.children);
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, into));
  };
  const blocks: Block[] = [];
  visit(source, blocks);
  return blocks;
}

function collectTests(blocks: readonly Block[], prefix: string[], out: Array<StaticTestCase | null>): void {
  for (const b of blocks) {
    if (b.inert) continue;
    if (b.kind === "test") {
      out.push(b.title === null || prefix.includes("\0") ? null : { path: [...prefix, b.title], start: b.start, end: b.end });
    } else {
      collectTests(b.children, [...prefix, b.title ?? "\0"], out);
    }
  }
}

export type ChangedTests = { kind: "whole-file"; reason: string } | { kind: "tests"; tests: StaticTestCase[] };

function isIgnorableLine(text: string): boolean {
  const t = text.trim();
  return t === "" || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t === "*/";
}

function importLines(source: TS.SourceFile): Set<number> {
  const lines = new Set<number>();
  for (const stmt of source.statements) {
    if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) {
      const a = source.getLineAndCharacterOfPosition(stmt.getStart(source)).line + 1;
      const b = source.getLineAndCharacterOfPosition(stmt.getEnd()).line + 1;
      for (let l = a; l <= b; l++) lines.add(l);
    }
  }
  return lines;
}

/** Every runnable test with a static name in the file, or null if some name is dynamic. */
export function allStaticTests(fileName: string, text: string): StaticTestCase[] | null {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const out: Array<StaticTestCase | null> = [];
  collectTests(parseBlocks(source), [], out);
  return out.some((t) => t === null) ? null : (out as StaticTestCase[]);
}

function scriptKind(fileName: string): TS.ScriptKind {
  if (/\.tsx$/.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * The tests of a modified test file touched by `lines` (head line numbers of added lines, plus
 * the head positions where lines were removed).
 */
export function changedTestCases(fileName: string, text: string, lines: readonly number[]): ChangedTests {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const blocks = parseBlocks(source);
  const imports = importLines(source);
  const textLines = text.split("\n");
  const selected = new Map<string, StaticTestCase>();

  const addAll = (within: readonly Block[], prefix: string[]): string | null => {
    const out: Array<StaticTestCase | null> = [];
    collectTests(within, prefix, out);
    if (out.some((t) => t === null)) return "a test in the changed region has a dynamic title";
    for (const t of out as StaticTestCase[]) selected.set(t.path.join("\0"), t);
    return null;
  };

  for (const lineNo of [...new Set(lines)].sort((a, b) => a - b)) {
    if (imports.has(lineNo)) continue;
    if (isIgnorableLine(textLines[lineNo - 1] ?? "")) continue;
    // Walk down to the innermost block containing the line.
    let level: readonly Block[] = blocks;
    const prefix: string[] = [];
    let suite: Block | null = null;
    let suitePrefix: string[] = [];
    let hit: Block | null = null;
    let dynamicSuite = false;
    for (;;) {
      const inside = level.find((b) => b.start <= lineNo && lineNo <= b.end);
      if (inside === undefined) break;
      if (inside.kind === "test") {
        hit = inside;
        break;
      }
      suitePrefix = [...prefix];
      suite = inside;
      if (inside.title === null) dynamicSuite = true;
      prefix.push(inside.title ?? "\0");
      level = inside.children;
    }
    if (hit !== null) {
      if (hit.inert) continue;
      if (hit.title === null || dynamicSuite) return { kind: "whole-file", reason: "a changed test has a dynamic title" };
      const t: StaticTestCase = { path: [...prefix, hit.title], start: hit.start, end: hit.end };
      selected.set(t.path.join("\0"), t);
      continue;
    }
    if (suite === null) {
      // Top-level code outside any suite (helpers, hooks, setup): every test may depend on it.
      return { kind: "whole-file", reason: `line ${lineNo} changes top-level code shared by every test` };
    }
    if (suite.inert) continue;
    const problem = addAll([suite], suitePrefix);
    if (problem !== null) return { kind: "whole-file", reason: problem };
  }
  return { kind: "tests", tests: [...selected.values()].sort((a, b) => a.start - b.start) };
}
