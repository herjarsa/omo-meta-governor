#!/usr/bin/env bun
import { $ } from "bun"

// Build the meta-governor plugin as ESM bundle + .d.ts declarations

const outDir = "dist"

// Clean
await $`rm -rf ${outDir}`
await $`mkdir -p ${outDir}`

// Bundle runtime
await $`bun build ./src/index.ts --outdir ${outDir} --format esm --target node --minify --sourcemap`

// Emit declarations
await $`bun x tsc --project tsconfig.json --emitDeclarationOnly --outDir ${outDir}`

// Generate JSON schema for omo-meta-governor.jsonc
const schemaDir = "assets"
await $`mkdir -p ${schemaDir}`
const { writeSchemaFile } = await import("./src/generate-schema")
await writeSchemaFile(`${schemaDir}/omo-meta-governor.schema.json`)
console.log(`Schema generated: ${schemaDir}/omo-meta-governor.schema.json`)


console.log(`Build complete: ${outDir}/`)
