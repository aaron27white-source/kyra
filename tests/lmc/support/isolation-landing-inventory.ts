import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { AuditRoute } from "./isolation-inventory";

const rootDefault = fileURLToPath(new URL("../../../", import.meta.url));
const methods = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];

function exportedNames(file: string): Set<string> {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    )
      for (const item of statement.exportClause.elements)
        names.add(item.name.text);
    if (
      !ts.canHaveModifiers(statement) ||
      !ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    )
      continue;
    if (ts.isFunctionDeclaration(statement) && statement.name)
      names.add(statement.name.text);
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
        else if (ts.isObjectBindingPattern(declaration.name))
          for (const element of declaration.name.elements)
            if (ts.isIdentifier(element.name)) names.add(element.name.text);
      }
  }
  return names;
}

/** Source discovery only: static output and deployment method behavior still require actual probes. */
export function discoverLandingHttpRoutes(root = rootDefault): AuditRoute[] {
  const pages = join(root, "apps/landing/src/pages"),
    functions = join(root, "apps/landing/functions");
  const routes: AuditRoute[] = [];
  function walk(
    directory: string,
    base: string,
    kind: "endpoint" | "function",
  ) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(file, base, kind);
        continue;
      }
      if (
        !/\.[cm]?[jt]s$/.test(entry.name) ||
        /\.d\.ts$|\.(?:test|spec)\.[cm]?[jt]s$/.test(entry.name)
      )
        continue;
      const exports = exportedNames(file),
        label = relative(root, file).replaceAll("\\", "/");
      if (
        kind === "endpoint" &&
        !methods.some((method) => exports.has(method)) &&
        !exports.has("ALL")
      )
        throw new Error(`UNRESOLVED_LANDING_ENDPOINT:${label}`);
      if (
        kind === "function" &&
        !exports.has("onRequest") &&
        !methods.some((method) =>
          exports.has(`onRequest${method[0]}${method.slice(1).toLowerCase()}`),
        )
      )
        throw new Error(`UNRESOLVED_LANDING_FUNCTION:${label}`);
      const segments = relative(base, file)
        .replaceAll("\\", "/")
        .replace(/\.[cm]?[jt]s$/, "")
        .split("/");
      const last = segments.at(-1);
      if (last === "_middleware") segments.splice(-1, 1, "[[...path]]");
      else if (last === "index") segments.pop();
      else if (last?.startsWith("_"))
        throw new Error(`UNINVENTORIED_LANDING_FUNCTION:${label}`);
      routes.push({
        path: `/${segments.join("/")}`,
        file: label,
        surface: "landing",
        methods: [...methods],
      });
    }
  }
  if (!existsSync(pages)) throw new Error("LANDING_ENDPOINT_DIRECTORY_MISSING");
  walk(pages, pages, "endpoint");
  if (existsSync(functions)) walk(functions, functions, "function");
  if (!routes.length) throw new Error("LANDING_HTTP_INVENTORY_EMPTY");
  if (new Set(routes.map((route) => route.path)).size !== routes.length)
    throw new Error("DUPLICATE_LANDING_ROUTE");
  return routes.sort((a, b) => a.path.localeCompare(b.path));
}
