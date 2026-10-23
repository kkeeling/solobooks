#!/usr/bin/env bun
// Assembles the npm packages from a release build: the `solobooks` wrapper (npm/solobooks), and one
// @solobooks/<os>-<arch> package per binary found, each limited to its own os and cpu so npm installs only the one
// that fits. Packs nothing and publishes nothing.
//
//   bun scripts/build-npm.ts [release dir, default dist/release] [out dir, default dist/npm]

import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { VERSION } from "../src/version.ts";

const ROOT = resolve(import.meta.dir, "..");
const release = resolve(process.argv[2] ?? join(ROOT, "dist", "release"));
const out = resolve(process.argv[3] ?? join(ROOT, "dist", "npm"));

const PLATFORMS = [
  { name: "darwin-arm64", os: "darwin", cpu: "arm64", file: "solobooks-darwin-arm64", bin: "solobooks" },
  { name: "darwin-x64", os: "darwin", cpu: "x64", file: "solobooks-darwin-x64", bin: "solobooks" },
  { name: "linux-arm64", os: "linux", cpu: "arm64", file: "solobooks-linux-arm64", bin: "solobooks" },
  { name: "linux-x64", os: "linux", cpu: "x64", file: "solobooks-linux-x64", bin: "solobooks" },
  { name: "windows-x64", os: "win32", cpu: "x64", file: "solobooks-windows-x64.exe", bin: "solobooks.exe" },
];

const wrapper = await Bun.file(join(ROOT, "npm", "solobooks", "package.json")).json();
if (wrapper.version !== VERSION) throw new Error(`npm/solobooks/package.json is ${wrapper.version}, but src/version.ts is ${VERSION}`);
for (const p of PLATFORMS) {
  if (wrapper.optionalDependencies[`@solobooks/${p.name}`] !== VERSION) throw new Error(`npm/solobooks/package.json doesn't depend on @solobooks/${p.name}@${VERSION}`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "solobooks", "bin"), { recursive: true });
copyFileSync(join(ROOT, "npm", "solobooks", "package.json"), join(out, "solobooks", "package.json"));
copyFileSync(join(ROOT, "npm", "solobooks", "bin", "solobooks.js"), join(out, "solobooks", "bin", "solobooks.js"));
chmodSync(join(out, "solobooks", "bin", "solobooks.js"), 0o755);
copyFileSync(join(ROOT, "LICENSE"), join(out, "solobooks", "LICENSE"));

const built: string[] = ["solobooks"];
for (const p of PLATFORMS) {
  const src = join(release, p.file);
  if (!existsSync(src)) continue;
  const dir = join(out, `solobooks-${p.name}`);
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(src, join(dir, "bin", p.bin));
  chmodSync(join(dir, "bin", p.bin), 0o755);
  copyFileSync(join(ROOT, "LICENSE"), join(dir, "LICENSE"));
  await Bun.write(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: `@solobooks/${p.name}`,
        version: VERSION,
        description: `The solobooks binary for ${p.name}. Installed by the solobooks package; not meant to be used on its own.`,
        license: "MIT",
        repository: wrapper.repository,
        os: [p.os],
        cpu: [p.cpu],
        files: ["bin"],
        preferUnplugged: true,
      },
      null,
      2,
    ) + "\n",
  );
  built.push(`@solobooks/${p.name}`);
}
console.log(`npm packages for solobooks ${VERSION} in ${out}: ${built.join(", ")}`);
