import fs from "node:fs"
import path from "node:path"
import ts from "typescript"

const sourceRoot = path.resolve("src")
const expectedRootModules = new Set([
  "./Answer.js",
  "./Chat.js",
  "./Model.js",
  "./Question.js",
  "./Repair.js",
  "./Session.js",
  "./Stage.js",
  "./Tool.js",
  "./View.js",
])
const internalImporters = new Set([
  "Chat.ts",
  "core/chat.ts",
  "debug.ts",
  "testing/chat.ts",
])

const toPosix = (value) => value.split(path.sep).join("/")
const sourceFiles = fs
  .readdirSync(sourceRoot, { recursive: true })
  .filter((file) => /\.(?:ts|tsx)$/.test(file))
  .map(toPosix)

const resolveRelative = (from, specifier) => {
  if (!specifier.startsWith(".")) {
    return undefined
  }
  const unresolved = path.resolve(
    sourceRoot,
    path.dirname(from),
    specifier,
  )
  const withoutJs = unresolved.replace(/\.js$/, "")
  for (const candidate of [
    `${withoutJs}.ts`,
    `${withoutJs}.tsx`,
    path.join(withoutJs, "index.ts"),
  ]) {
    if (fs.existsSync(candidate)) {
      return toPosix(path.relative(sourceRoot, candidate))
    }
  }
  return undefined
}

const isRuntimeImport = (declaration) => {
  if (declaration.importClause === undefined) {
    return true
  }
  if (declaration.importClause.isTypeOnly) {
    return false
  }
  const bindings = declaration.importClause.namedBindings
  return !(
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  )
}

const graph = new Map()
const errors = []

for (const file of sourceFiles) {
  const absolute = path.join(sourceRoot, file)
  const parsed = ts.createSourceFile(
    file,
    fs.readFileSync(absolute, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const edges = []
  for (const statement of parsed.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      isRuntimeImport(statement)
    ) {
      const target = resolveRelative(file, statement.moduleSpecifier.text)
      if (target !== undefined) {
        edges.push(target)
      }
      continue
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const target = resolveRelative(file, statement.moduleSpecifier.text)
      if (target !== undefined) {
        edges.push(target)
      }
    }
  }
  graph.set(file, edges)

  for (const target of edges) {
    if (
      target.startsWith("testing/") &&
      file !== "testing.ts" &&
      !file.startsWith("testing/")
    ) {
      errors.push(`${file} imports testing production code from ${target}`)
    }
    if (
      target.startsWith("internal/") &&
      !internalImporters.has(file)
    ) {
      errors.push(`${file} is not allowed to import private ${target}`)
    }
  }
}

const indexSource = ts.createSourceFile(
  "index.ts",
  fs.readFileSync(path.join(sourceRoot, "index.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
)
const rootModules = new Set()
for (const statement of indexSource.statements) {
  if (
    !ts.isExportDeclaration(statement) ||
    statement.moduleSpecifier === undefined ||
    !ts.isStringLiteral(statement.moduleSpecifier) ||
    statement.exportClause === undefined ||
    !ts.isNamespaceExport(statement.exportClause)
  ) {
    errors.push("src/index.ts may contain only named module namespace exports")
    continue
  }
  rootModules.add(statement.moduleSpecifier.text)
}
for (const expected of expectedRootModules) {
  if (!rootModules.has(expected)) {
    errors.push(`src/index.ts is missing ${expected}`)
  }
}
for (const actual of rootModules) {
  if (!expectedRootModules.has(actual)) {
    errors.push(`src/index.ts leaks unexpected module ${actual}`)
  }
}

const visiting = new Set()
const visited = new Set()
const stack = []
const visit = (file) => {
  if (visiting.has(file)) {
    const start = stack.indexOf(file)
    errors.push(
      `runtime import cycle: ${[...stack.slice(start), file].join(" -> ")}`,
    )
    return
  }
  if (visited.has(file)) {
    return
  }
  visiting.add(file)
  stack.push(file)
  for (const target of graph.get(file) ?? []) {
    visit(target)
  }
  stack.pop()
  visiting.delete(file)
  visited.add(file)
}

for (const file of sourceFiles) {
  visit(file)
}

if (errors.length > 0) {
  for (const error of new Set(errors)) {
    process.stderr.write(`architecture: ${error}\n`)
  }
  process.exitCode = 1
} else {
  process.stdout.write(
    `architecture: ${sourceFiles.length} modules, no boundary violations or runtime cycles\n`,
  )
}
