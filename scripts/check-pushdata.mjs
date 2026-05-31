// CI check: forbid direct calls to `.pushData(...)` anywhere in the repo.
//
// safePushData is a library wrapper; callers pass `Actor.pushData` (or any
// dataset's push function) as `pushFn`. The whole point is to ensure nothing
// bypasses the wrapper, so a stray `Actor.pushData(items)` inside this repo
// would defeat that goal.
//
// Exits non-zero (and prints the offending lines) if any file under src/
// or test/ contains a `.pushData(` call. This script itself, and the
// scripts/ folder generally, are excluded — the script needs to mention
// the string in order to look for it.
//
// Run: node scripts/check-pushdata.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

// Scan these directories. Anything outside (scripts/, node_modules/, etc.)
// is ignored.
const SCAN_DIRS = ['src', 'test'];
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);

// Match `.pushData(` after a `.` or `?.` (so we don't catch a property
// named `pushData` in an object literal, only call expressions).
const FORBIDDEN = /\??\.pushData\s*\(/;

// Lines that are pure comments (JSDoc, line comments) are ignored — the
// check is for call sites, not for docs that need to mention the API.
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|\*\/)/;

function walk(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const stat = statSync(full);
        if (stat.isDirectory()) {
            if (name === 'node_modules' || name.startsWith('.')) continue;
            out.push(...walk(full));
        } else if (EXTENSIONS.has(full.slice(full.lastIndexOf('.')))) {
            out.push(full);
        }
    }
    return out;
}

const offenders = [];
for (const dir of SCAN_DIRS) {
    const abs = join(ROOT, dir);
    let files;
    try {
        files = walk(abs);
    } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw err;
    }
    for (const file of files) {
        const content = readFileSync(file, 'utf8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (COMMENT_LINE.test(lines[i])) continue;
            if (FORBIDDEN.test(lines[i])) {
                offenders.push({ file: relative(ROOT, file), line: i + 1, text: lines[i].trim() });
            }
        }
    }
}

if (offenders.length === 0) {
    console.log('check-pushdata: OK — no direct .pushData() calls found.');
    process.exit(0);
}

console.error('check-pushdata: FAIL — direct .pushData() calls are forbidden.');
console.error('Wrap every push through safePushData and pass the push function as pushFn.\n');
for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  ${o.text}`);
}
process.exit(1);
