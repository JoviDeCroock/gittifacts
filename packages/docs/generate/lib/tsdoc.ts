/**
 * JSDoc comments read straight from TypeScript sources with the compiler API, so reference
 * tables carry the same words as the code (policy fields, RunnerOptions, enum members).
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

function sourceOf(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

function docOf(node: ts.Node, sf: ts.SourceFile): string {
  const text = sf.getFullText();
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  const docs = ranges
    .map((r) => text.slice(r.pos, r.end))
    .filter((c) => c.startsWith("/**"))
    .map((c) =>
      c
        .replace(/^\/\*\*/, "")
        .replace(/\*\/$/, "")
        .split("\n")
        .map((l) => l.replace(/^\s*\* ?/, "").trim())
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    );
  return docs.at(-1) ?? "";
}

function nameOf(n: ts.PropertyName | ts.BindingName, sf: ts.SourceFile): string {
  if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text;
  return n.getText(sf);
}

/**
 * Doc comments of every property assignment / property signature in `file`, keyed by their
 * dotted path from the outermost object literal or interface (`thresholds.mutationScore`).
 * Nested `z.object({...})` calls count as nesting under the property that holds them.
 */
export function propertyDocs(file: string): Map<string, string> {
  const sf = sourceOf(file);
  const out = new Map<string, string>();
  let owner = "";
  const visit = (node: ts.Node, path: string[]) => {
    if (ts.isPropertyAssignment(node) || ts.isPropertySignature(node)) {
      const key = [...path, nameOf(node.name, sf)];
      const doc = docOf(node, sf);
      const dotted = key.join(".");
      if (doc !== "" && !out.has(dotted)) out.set(dotted, doc);
      // Also keyed by the declaration that holds it (`CoverageDelta#ratio`): field names repeat.
      if (doc !== "" && owner !== "") out.set(`${owner}#${dotted}`, doc);
      ts.forEachChild(node, (c) => visit(c, key));
      return;
    }
    if (ts.isVariableStatement(node) || ts.isInterfaceDeclaration(node)) {
      const decl = ts.isVariableStatement(node)
        ? node.declarationList.declarations[0]?.name
        : node.name;
      owner = decl !== undefined && ts.isIdentifier(decl) ? decl.text : "";
      ts.forEachChild(node, (c) => visit(c, []));
      return;
    }
    ts.forEachChild(node, (c) => visit(c, path));
  };
  visit(sf, []);
  return out;
}

/** Doc comments of the string members of `export const <name> = z.enum([...])` (or a plain array). */
export function enumMemberDocs(file: string, exportName: string): Map<string, string> {
  const sf = sourceOf(file);
  const out = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === exportName
    ) {
      const walk = (n: ts.Node) => {
        if (ts.isArrayLiteralExpression(n)) {
          for (const el of n.elements) {
            if (ts.isStringLiteral(el)) out.set(el.text, docOf(el, sf));
          }
          return;
        }
        ts.forEachChild(n, walk);
      };
      walk(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The JSDoc of an exported declaration (function, const, interface). */
export function declarationDoc(file: string, name: string): string {
  const sf = sourceOf(file);
  for (const stmt of sf.statements) {
    const named =
      (ts.isFunctionDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) &&
      stmt.name?.text === name;
    const isVar =
      ts.isVariableStatement(stmt) &&
      stmt.declarationList.declarations.some(
        (d) => ts.isIdentifier(d.name) && d.name.text === name,
      );
    if (named || isVar) return docOf(stmt, sf);
  }
  return "";
}
