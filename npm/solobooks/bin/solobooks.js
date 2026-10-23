#!/usr/bin/env node
"use strict";
// Runs the solobooks binary built for this machine. npm installed it alongside this file as an optional dependency
// (@solobooks/<os>-<arch>), so nothing is downloaded here, and solobooks itself opens no network connection.
const { spawn } = require("node:child_process");

const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
const arch = { arm64: "arm64", x64: "x64" }[process.arch];
const pkg = `@solobooks/${os}-${arch}`;
let bin;
try {
  bin = require.resolve(`${pkg}/bin/solobooks${process.platform === "win32" ? ".exe" : ""}`);
} catch {
  process.stderr.write(
    `solobooks: there is no solobooks build installed for ${process.platform}-${process.arch}. ` +
      `Reinstall without --no-optional, or install solobooks with its installer instead.\n`,
  );
  process.exit(1);
}

const child = spawn(bin, process.argv.slice(2), { stdio: "inherit" });
// Pass the agent app's stop signals on, so the MCP server stops with it.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", (e) => {
  process.stderr.write(`solobooks: couldn't start ${bin}: ${e.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
