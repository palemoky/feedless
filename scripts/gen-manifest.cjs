#!/usr/bin/env node
"use strict";

// Single source of truth for the supported-site host list is src/sites.js.
// This script derives manifest.json's content_scripts[0].matches and
// host_permissions from SITES[].hostnames so the lists never drift.
// Run via `make manifest` (also a prerequisite of `make build`).

const fs = require("fs");
const path = require("path");
const { SITES } = require("../src/sites.js");

// Collapse each hostname to its registrable base (drop leading "*." / "www.")
// and keep first-seen order so diffs stay stable.
const bases = [];
for (const site of SITES) {
  for (const hostname of site.hostnames) {
    const base = hostname.replace(/^\*\./, "").replace(/^www\./, "");
    if (!bases.includes(base)) bases.push(base);
  }
}

// Each base expands to the bare domain plus all subdomains.
const patterns = bases.flatMap((base) => [`*://${base}/*`, `*://*.${base}/*`]);

const manifestPath = path.join(__dirname, "..", "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

manifest.content_scripts[0].matches = patterns;
manifest.host_permissions = patterns;

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

console.log(
  `Generated ${patterns.length} host patterns from ${bases.length} domains`,
);
