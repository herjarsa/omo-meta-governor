#!/usr/bin/env bun
import { $ } from "bun"
import { existsSync, mkdirSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"

// Build skills tarball ONLY — exits before the full bundle.
// Triggered via `bun run build:skills` in package.json.
async function buildSkillsTarball() {
  const bundledDir = join(import.meta.dir, "bundled-skills")
  const outDir = join(import.meta.dir, "dist", "skills")
  if (!existsSync(bundledDir)) {
    console.warn(`[build:skills] ${bundledDir} does not exist; skipping`)
    return
  }
  mkdirSync(outDir, { recursive: true })
  const tarPath = join(outDir, "chore.tar.gz")
  // Use execFileSync (no shell) to avoid shell injection via paths.
  execFileSync("tar", ["-czf", tarPath, "-C", bundledDir, "."], { stdio: "inherit" })
  console.log(`[build:skills] wrote ${tarPath}`)
}

if (process.argv[2] === "skills") {
  await buildSkillsTarball()
  process.exit(0)
}

// Build the meta-governor plugin as ESM bundle + .d.ts declarations
const outDir = "dist"
// Clean
await $`rm -rf ${outDir}`
await $`mkdir -p ${outDir}`
// v0.39.0: add cli-doctor (omo bin) to the bundle so `npx omo doctor` works
// after install. Pure ESM, node target — matches the other entry points.
await $`bun build ./src/index.ts ./src/lib.ts ./src/cli-doctor.ts --outdir ${outDir} --format esm --target node --minify --sourcemap`
// v0.31.0: MCP server entry. Built alongside the plugin so users can opt
// in via `mcp.omo-meta-governor` in opencode.jsonc. Uses node target + esm
// format to match the plugin output (interop with both Bun and Node).
await $`bun build ./src/mcp-server.ts --outdir ${outDir} --format esm --target node --minify --sourcemap`
// Emit declarations
await $`bun x tsc --project tsconfig.json --emitDeclarationOnly --outDir ${outDir}`
// Generate JSON schema for omo-meta-governor.jsonc
const schemaDir = "assets"
await $`mkdir -p ${schemaDir}`
const { writeSchemaFile } = await import("./src/generate-schema")
await writeSchemaFile(`${schemaDir}/omo-meta-governor.schema.json`)
console.log(`Schema generated: ${schemaDir}/omo-meta-governor.schema.json`)
// Also pack the bundled skills tarball into the dist/ tree so npm publish
// ships it inside the package (required for first-run bootstrap).
await buildSkillsTarball()
console.log(`Build complete: ${outDir}/`)
