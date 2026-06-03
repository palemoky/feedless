#!/usr/bin/env node
"use strict";

// Builds per-browser extension zips into dist/.
//
// Chrome and Edge share the canonical manifest.json verbatim. Firefox needs a
// transformed manifest (event-page background + browser_specific_settings),
// so we stage each target into its own directory and zip from there.
//
// Run `make manifest` first so host lists are current (make build-all does).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
);
const version = manifest.version;

// Files/dirs shipped in every build.
const COMMON = ["_locales", "icons", "src"];

const distDir = path.join(root, "dist");
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

function pack(browser, transform) {
  const stage = path.join(distDir, browser);
  fs.mkdirSync(stage, { recursive: true });

  for (const item of COMMON) {
    fs.cpSync(path.join(root, item), path.join(stage, item), {
      recursive: true,
    });
  }

  const m = JSON.parse(JSON.stringify(manifest));
  transform(m);
  fs.writeFileSync(
    path.join(stage, "manifest.json"),
    JSON.stringify(m, null, 2) + "\n",
  );

  const zipPath = path.join(distDir, `feedless-${browser}-v${version}.zip`);
  // Zip from inside the stage dir so paths are relative to the extension root.
  // Exclude OS cruft (.DS_Store, dotfiles) so AMO's review doesn't flag them.
  execFileSync(
    "zip",
    ["-r", "-q", zipPath, ".", "-x", "*.DS_Store", "-x", "*/.*"],
    { cwd: stage },
  );
  console.log(`✓ ${path.relative(root, zipPath)}`);
}

// Chrome & Edge: canonical manifest, no changes.
pack("chrome", () => {});
pack("edge", () => {});

// Firefox MV3 runs an event page, not a service worker: list the shared scripts
// in background.scripts (background.js guards its importScripts call) and add
// the gecko settings AMO requires. strict_min_version 128 is the first release
// supporting `world: "MAIN"` content scripts (used by x-fetch-blocker.js).
pack("firefox", (m) => {
  if (m.background?.service_worker) {
    m.background = {
      scripts: ["src/sites.js", "src/config.js", "src/background.js"],
    };
  }
  m.browser_specific_settings = {
    gecko: {
      id: "feedless@palemoky.com",
      strict_min_version: "128.0",
    },
  };
});
