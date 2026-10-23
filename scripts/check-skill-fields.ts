#!/usr/bin/env bun
// Checks a SKILL.md against the Agent Skills spec (agentskills.io): its frontmatter may use only the six spec fields,
// and the ones that are required or constrained must hold. Exits 1 with each problem on its own line.
//
//   bun scripts/check-skill-fields.ts skills/solobooks/SKILL.md

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";

const SPEC_FIELDS = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"];

export function checkSkill(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) return ["The file must start with YAML frontmatter between --- lines."];
  let fm: unknown;
  try {
    fm = Bun.YAML.parse(m[1]!);
  } catch (e) {
    return [`The frontmatter is not valid YAML: ${e instanceof Error ? e.message : e}`];
  }
  if (typeof fm !== "object" || fm === null || Array.isArray(fm)) return ["The frontmatter must be a YAML mapping."];
  const f = fm as Record<string, unknown>;
  const problems: string[] = [];

  for (const k of Object.keys(f)) if (!SPEC_FIELDS.includes(k)) problems.push(`${k}: not an Agent Skills field; only ${SPEC_FIELDS.join(", ")} are allowed.`);

  const name = f.name;
  if (typeof name !== "string" || name.length === 0) problems.push("name: required.");
  else {
    if (name.length > 64) problems.push("name: at most 64 characters.");
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) problems.push("name: lowercase letters, digits and single hyphens only, not starting or ending with a hyphen.");
    if (name !== basename(dirname(path))) problems.push(`name: must match the skill's folder name, ${basename(dirname(path))}.`);
  }
  const description = f.description;
  if (typeof description !== "string" || !description.trim()) problems.push("description: required.");
  else if (description.length > 1024) problems.push("description: at most 1024 characters.");

  if (f.license !== undefined && typeof f.license !== "string") problems.push("license: must be text.");
  if (f.compatibility !== undefined && (typeof f.compatibility !== "string" || f.compatibility.length > 500)) {
    problems.push("compatibility: must be text of at most 500 characters.");
  }
  if (f.metadata !== undefined) {
    const md = f.metadata;
    if (typeof md !== "object" || md === null || Array.isArray(md) || Object.values(md).some((v) => typeof v !== "string")) {
      problems.push("metadata: must map names to text values.");
    }
  }
  if (f["allowed-tools"] !== undefined && typeof f["allowed-tools"] !== "string") problems.push("allowed-tools: must be one line of space-separated tools.");
  return problems;
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: bun scripts/check-skill-fields.ts <path to SKILL.md>");
    process.exit(2);
  }
  const problems = checkSkill(path);
  for (const p of problems) console.error(`${path}: ${p}`);
  if (problems.length) process.exit(1);
  console.log(`${path}: frontmatter uses only Agent Skills fields`);
}
