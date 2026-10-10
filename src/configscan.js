'use strict';

// Recursive .Civ6Cfg scan for the config picker. Kept out of server.js so the
// browser-scripts and node:test mirrors can require it: server.js binds a
// port on require, this module only reads the filesystem.
//
// Match is by file NAME before touching contents, so the big .Civ6Save blobs
// sharing these folders are never opened during listing (see ADR-002 for the
// roundtrip-safe parse they would otherwise pay for on every row).

const fs = require('fs');
const path = require('path');

// How far below the saves root AutoConfig nests (Single/auto/prev is 2).
const MAX_SCAN_DEPTH = 3;

// A folder carrying a save extension holds saves, never configs.
function isSaveLeaf(name) {
  return /\.Civ6Save$/i.test(name);
}

function isConfigLeaf(name) {
  return /\.Civ6Cfg$/i.test(name);
}

// [{ name, path, rel }] under root, sorted by name then relative path so
// duplicate basenames (auto/ vs auto/prev/) read adjacently. Reads directory
// entries only; file bytes are never touched.
function scanConfigDir(root, maxDepth) {
  const out = [];
  const depthCap = maxDepth == null ? MAX_SCAN_DEPTH : maxDepth;
  (function walk(dir, depth) {
    if (depth > depthCap) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!isSaveLeaf(e.name) && !isConfigLeaf(e.name) && depth < depthCap) walk(full, depth + 1);
        continue;
      }
      if (!isConfigLeaf(e.name)) continue;
      if (!e.isFile()) {
        let stat = null;
        try {
          stat = fs.statSync(full);
        } catch (_) {
          continue;
        }
        if (!stat.isFile()) continue;
      }
      out.push({ name: e.name, path: full, rel: path.relative(root, full) });
    }
  })(root, 0);
  out.sort((a, b) => a.name.localeCompare(b.name) || a.rel.localeCompare(b.rel));
  return out;
}

module.exports = { scanConfigDir, MAX_SCAN_DEPTH };
