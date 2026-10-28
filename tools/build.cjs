#!/usr/bin/env node
/* SAFe WSJF – Build: kopiert src/ samt README, LICENSE und NOTICE nach dist/SAFe-WSJF und setzt die Version.
   Es wird nichts übersetzt oder gebündelt; src/index.html lässt sich auch ohne Build direkt öffnen.

   Aufruf: node tools/build.cjs [--version v1.0.0] [--out dist/SAFe-WSJF] */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { version: 'dev', out: path.join(ROOT, 'dist', 'SAFe-WSJF') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version') args.version = argv[++i];
    else if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else throw new Error(`Unbekannte Option: ${argv[i]}`);
  }
  return args;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.rmSync(args.out, { recursive: true, force: true });
  copyDir(path.join(ROOT, 'src'), args.out);
  for (const f of ['README.md', 'LICENSE', 'NOTICE']) fs.copyFileSync(path.join(ROOT, f), path.join(args.out, f));
  const version = String(args.version).replace(/[^\w.\-+]/g, '');
  fs.writeFileSync(path.join(args.out, 'js', 'version.js'), `/* Beim Build gesetzt. */\nwindow.WSJF_VERSION = '${version}';\n`);
  console.log(`Gebaut: ${path.relative(ROOT, args.out)} (Version ${version})`);
}

main();
