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

console.log(`Build complete: ${outDir}/`)
