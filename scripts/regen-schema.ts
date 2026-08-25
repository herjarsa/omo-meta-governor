// Run generateSchema and write asset. CLI: bun scripts/regen-schema.ts
import { writeFileSync } from "node:fs";
import { generateSchema } from "../src/generate-schema.ts";

const schema = generateSchema();
const out = "D:/GITHUB/omo-meta-governor/assets/omo-meta-governor.schema.json";
writeFileSync(out, JSON.stringify(schema, null, 2));
console.log("schema written to", out);
console.log("top keys:", Object.keys(schema.properties ?? {}).slice(0, 10).join(", "));
console.log("skillPriming.enforceMode:", JSON.stringify(schema.properties?.skillPriming?.properties?.enforceMode));
