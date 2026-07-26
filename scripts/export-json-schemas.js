#!/usr/bin/env node
/**
 * scripts/export-json-schemas.js
 *
 * Extracts reusable component schemas from api/openapi.yaml and writes
 * each one as a standalone JSON Schema (draft-07 compatible) file under
 * docs/schemas/.
 *
 * These schemas are consumed by:
 *  - The CBN / NFIU reporting pipeline (compliance validation)
 *  - Partner SDK generators (openapi-generator, swagger-codegen)
 *  - Runtime validation middleware (ajv, zod-from-json-schema)
 *
 * Usage:
 *   node scripts/export-json-schemas.js [--out <dir>]
 *
 * Outputs (defaults to docs/schemas/):
 *   EscrowRecord.schema.json
 *   Sep31Transaction.schema.json
 *   EscrowEvent.schema.json
 *   Tier.schema.json
 *   Pass.schema.json
 *   ReconcileResponse.schema.json
 *   ErrorResponse.schema.json
 *   WebhookResponse.schema.json
 *   HealthResponse.schema.json
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Minimal YAML parser for the subset we use (no external deps)
// ---------------------------------------------------------------------------
// We rely on js-yaml which ships with many Node toolchains, but fall back to
// a require() of the openapi.yaml converted to JSON if js-yaml is absent.
let yaml;
try {
  yaml = require("js-yaml");
} catch {
  // js-yaml not installed; try @redocly/openapi-core which bundles yaml
  try {
    yaml = require("@redocly/openapi-core/node_modules/js-yaml");
  } catch {
    console.error(
      "js-yaml is not available. Install it with: npm install --save-dev js-yaml"
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = outIdx !== -1 ? args[outIdx + 1] : path.join(__dirname, "..", "docs", "schemas");

// ---------------------------------------------------------------------------
// Load openapi.yaml
// ---------------------------------------------------------------------------
const specPath = path.join(__dirname, "..", "api", "openapi.yaml");
if (!fs.existsSync(specPath)) {
  console.error(`Cannot find OpenAPI spec at ${specPath}`);
  process.exit(1);
}

const spec = yaml.load(fs.readFileSync(specPath, "utf8"));
const schemas = spec?.components?.schemas;
if (!schemas) {
  console.error("No components/schemas found in openapi.yaml");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Schemas to export (subset most relevant to external consumers)
// ---------------------------------------------------------------------------
const EXPORT_LIST = [
  "EscrowRecord",
  "EscrowCreateRequest",
  "EscrowCreateResponse",
  "EscrowEvent",
  "EscrowState",
  "Sep31Transaction",
  "Sep31TransactionRequest",
  "Sep31TransactionCreatedResponse",
  "Tier",
  "TierCreateRequest",
  "TierContentKey",
  "CreatorContent",
  "Pass",
  "PassCreateRequest",
  "ReconcileResponse",
  "Discrepancy",
  "ErrorResponse",
  "WebhookResponse",
  "HealthResponse",
];

// ---------------------------------------------------------------------------
// Resolve $ref within the same spec (shallow — components/schemas only)
// ---------------------------------------------------------------------------
function resolveRefs(node, allSchemas) {
  if (typeof node !== "object" || node === null) return node;
  if (Array.isArray(node)) return node.map((item) => resolveRefs(item, allSchemas));

  if (node.$ref) {
    const refName = node.$ref.replace("#/components/schemas/", "");
    const resolved = allSchemas[refName];
    if (!resolved) {
      console.warn(`  warning: unresolved $ref ${node.$ref}`);
      return node;
    }
    // Return inline copy (avoid circular — schemas here are not recursive)
    return resolveRefs(JSON.parse(JSON.stringify(resolved)), allSchemas);
  }

  const out = {};
  for (const [key, val] of Object.entries(node)) {
    out[key] = resolveRefs(val, allSchemas);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Convert OpenAPI 3.1 schema to JSON Schema draft-07
// ---------------------------------------------------------------------------
function toJsonSchemaDraft07(openApiSchema, name, allSchemas) {
  // Deep-clone so we don't mutate the spec
  const schema = resolveRefs(JSON.parse(JSON.stringify(openApiSchema)), allSchemas);

  // OpenAPI 3.1 uses `type: [string, null]` where draft-07 uses `nullable: true`
  // Convert inline for compliance tooling that expects draft-07.
  function fixNullable(node) {
    if (typeof node !== "object" || node === null) return node;
    if (Array.isArray(node)) return node.map(fixNullable);
    const result = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "type" && Array.isArray(v)) {
        const types = v.filter((t) => t !== "null");
        result.type = types.length === 1 ? types[0] : types;
        if (v.includes("null")) result.nullable = true;
      } else {
        result[k] = fixNullable(v);
      }
    }
    return result;
  }

  const draft07Schema = fixNullable(schema);

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: `https://afropay.io/schemas/${name}.schema.json`,
    title: name,
    ...draft07Schema,
  };
}

// ---------------------------------------------------------------------------
// Write schemas
// ---------------------------------------------------------------------------
fs.mkdirSync(outDir, { recursive: true });

let exported = 0;
let skipped = 0;

for (const name of EXPORT_LIST) {
  if (!schemas[name]) {
    console.warn(`  skip: ${name} not found in components/schemas`);
    skipped++;
    continue;
  }

  const draft07 = toJsonSchemaDraft07(schemas[name], name, schemas);
  const outPath = path.join(outDir, `${name}.schema.json`);
  fs.writeFileSync(outPath, JSON.stringify(draft07, null, 2) + "\n");
  console.log(`  wrote: ${path.relative(process.cwd(), outPath)}`);
  exported++;
}

// ---------------------------------------------------------------------------
// Also write a combined bundle for SDK generators
// ---------------------------------------------------------------------------
const bundle = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://afropay.io/schemas/afropay-api-schemas.json",
  title: "AfroPay API — Combined Schema Bundle",
  description:
    "All reusable schemas from the AfroPay API, exported from api/openapi.yaml for use by the CBN reporting pipeline and partner SDK generators.",
  definitions: {},
};

for (const name of EXPORT_LIST) {
  if (schemas[name]) {
    const draft07 = toJsonSchemaDraft07(schemas[name], name, schemas);
    // Remove top-level $schema / $id from each definition entry
    const { $schema, $id, ...rest } = draft07;
    bundle.definitions[name] = rest;
  }
}

const bundlePath = path.join(outDir, "afropay-api-schemas.json");
fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2) + "\n");
console.log(`  wrote: ${path.relative(process.cwd(), bundlePath)}`);

console.log(`\nDone. Exported ${exported} schemas, skipped ${skipped}. Bundle: ${bundlePath}`);
