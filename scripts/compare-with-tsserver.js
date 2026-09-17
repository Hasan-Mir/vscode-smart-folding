// Parity harness v2: compares Smart Folding's computeFoldingRanges output with
// the folding ranges VS Code itself would show for JS/TS files.
//
// VS Code's built-in JS/TS folding = tsserver `getOutliningSpans`, converted
// by the typescript-language-features extension (foldEndPairCharacters rule).
// This script replicates that conversion exactly, so the "native" column is
// byte-for-byte what VS Code displays.
//
// Comparison contract (H-1):
//   - normalized (start, end, kind) sets; tsserver's "code" kind → undefined
//   - exact duplicate ranges are deduplicated on both sides
//   - MISSING native ranges ALWAYS fail the build
//   - EXTRA Smart Folding ranges are checked against the checked-in contract
//     fixtures/parity/allowlist.json (intentional WebStorm extras, e.g.
//     comment folds) — they fail only in STRICT mode when not allow-listed
//
// Usage:
//   node scripts/compare-with-tsserver.js            # lenient (local)
//   node scripts/compare-with-tsserver.js --strict   # strict (CI/release)
//   PARITY_STRICT=1 node scripts/compare-with-tsserver.js
'use strict';

const fs = require('fs');
const path = require('path');

// Resolve a full TypeScript library (needs the language-service API).
// Normally the project's `typescript` devDependency provides it; the
// TS_LIB_PATH env var can point to an alternative typescript.js if needed.
function loadTypescript() {
    if (process.env.TS_LIB_PATH) return require(process.env.TS_LIB_PATH);
    const t = require('typescript');
    if (typeof t.createLanguageService === 'function') return t;
    throw new Error(
        'The installed `typescript` package does not expose the language ' +
            'service API. Install typescript 5.x or set TS_LIB_PATH to a ' +
            'full lib/typescript.js.'
    );
}
const ts = loadTypescript();
const { computeFoldingRanges } = require('../out/core/folding');

const STRICT = process.argv.includes('--strict') || process.env.PARITY_STRICT === '1';

// ---------------------------------------------------------------------------
// Native VS Code ranges (tsserver + typescript-language-features conversion)
// ---------------------------------------------------------------------------

// From vscode/extensions/typescript-language-features/src/languageFeatures/folding.ts
const FOLD_END_PAIR_CHARACTERS = ['}', ']', ')', '`'];

function nativeRanges(fileName, text) {
    const host = {
        getScriptFileNames: () => [fileName],
        getScriptVersion: () => '1',
        getScriptSnapshot: f => (f === fileName ? ts.ScriptSnapshot.fromString(text) : undefined),
        getCurrentDirectory: () => process.cwd(),
        getCompilationSettings: () => ({
            allowJs: true,
            jsx: fileName.endsWith('x') ? ts.JsxEmit.Preserve : ts.JsxEmit.None,
        }),
        getDefaultLibFileName: opts => ts.getDefaultLibFilePath(opts),
        fileExists: f => f === fileName,
        readFile: f => (f === fileName ? text : undefined),
    };
    const service = ts.createLanguageService(host);
    try {
        const spans = service.getOutliningSpans(fileName);
        const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
        const lines = text.split('\n');

        const ranges = [];
        for (const span of spans) {
            const startPos = sf.getLineAndCharacterOfPosition(span.textSpan.start);
            const endPos = sf.getLineAndCharacterOfPosition(
                span.textSpan.start + span.textSpan.length
            );
            // VS Code workaround #49904: drop the bogus comment span tsserver
            // reports for `// #endregion` lines. (No /g flag: .test() with a
            // global regex is stateful across calls — H-1.)
            if (span.kind === 'comment') {
                const line = lines[startPos.line] || '';
                if (/\/\/\s*#endregion/i.test(line)) continue;
            }
            // VS Code workaround #47240 (adjustFoldingEnd): if the span ends
            // just after a closing pair character, keep that line visible.
            let endLine = endPos.line;
            if (endPos.character > 0) {
                const ch = text.charAt(span.textSpan.start + span.textSpan.length - 1);
                if (FOLD_END_PAIR_CHARACTERS.includes(ch)) {
                    endLine = Math.max(endPos.line - 1, startPos.line);
                }
            }
            if (endLine <= startPos.line) continue; // nothing to fold
            ranges.push({ start: startPos.line, end: endLine, kind: span.kind });
        }
        return ranges;
    } finally {
        service.dispose();
    }
}

// ---------------------------------------------------------------------------
// Smart Folding ranges (VS Code-equivalent settings)
// ---------------------------------------------------------------------------

function smartRanges(fileName, text) {
    const languageId = fileName.endsWith('.tsx')
        ? 'typescriptreact'
        : fileName.endsWith('.jsx')
          ? 'javascriptreact'
          : fileName.endsWith('.js')
            ? 'javascript'
            : 'typescript';
    return computeFoldingRanges(text, {
        singleLineFolds: false,
        foldComments: true,
        languageId,
    });
}

// ---------------------------------------------------------------------------
// Comparison (H-1: normalized kinds, dedup, missing always fails, strict extras)
// ---------------------------------------------------------------------------

// tsserver reports plain code spans with kind "code"; Smart Folding uses
// undefined. Normalize so both sides compare equal.
function normKind(kind) {
    return kind === 'code' ? undefined : kind;
}

function normalize(ranges) {
    const seen = new Set();
    const out = [];
    for (const r of ranges) {
        const kind = normKind(r.kind);
        const key = `${r.start}-${r.end}-${kind ?? 'code'}`;
        if (seen.has(key)) continue; // dedup exact duplicates
        seen.add(key);
        out.push({ start: r.start, end: r.end, kind });
    }
    return out;
}

function key(r) {
    return `${r.start}-${r.end}-${r.kind ?? 'code'}`;
}

function describe(r, lines) {
    const snippet = (lines[r.start] || '').trim().slice(0, 60);
    return `  lines ${String(r.start).padStart(4)}..${String(r.end).padEnd(4)} ${
        r.kind ? `[${r.kind}]`.padEnd(10) : ''.padEnd(10)
    } | ${snippet}`;
}

// ---------------------------------------------------------------------------
// Checked-in contract of INTENTIONAL Smart Folding extras (H-1).
// WebStorm-intentional divergences from tsserver (e.g. runs of consecutive
// `//` comments, which tsserver has no span for) are allow-listed here so
// strict mode can distinguish them from genuine regressions.
// ---------------------------------------------------------------------------

const fixtureDir = path.join(__dirname, '..', 'fixtures', 'parity');

let allowlist = {};
try {
    allowlist = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'allowlist.json'), 'utf8'));
} catch {
    console.warn(
        'WARNING: fixtures/parity/allowlist.json missing — strict mode will fail on extras.'
    );
}

const files = fs.readdirSync(fixtureDir).filter(f => /\.(ts|js|tsx|jsx)$/.test(f));
let failed = false;
let totalMissing = 0;
let totalUnexpectedExtras = 0;

for (const file of files) {
    const full = path.join(fixtureDir, file);
    const text = fs.readFileSync(full, 'utf8');
    const lines = text.split('\n');
    const native = normalize(nativeRanges(full, text));
    const ours = normalize(smartRanges(full, text));
    const ourKeys = new Set(ours.map(key));
    const nativeKeys = new Set(native.map(key));

    const missing = native.filter(r => !ourKeys.has(key(r)));
    const extras = ours.filter(r => !nativeKeys.has(key(r)));

    const allowedExtraKeys = new Set(
        (allowlist[file] ?? []).map(e => `${e.start}-${e.end}-${normKind(e.kind) ?? 'code'}`)
    );
    const allowedExtras = extras.filter(r => allowedExtraKeys.has(key(r)));
    const unexpectedExtras = extras.filter(r => !allowedExtraKeys.has(key(r)));

    totalMissing += missing.length;
    totalUnexpectedExtras += unexpectedExtras.length;

    console.log(`\n=== ${file}: native=${native.length} smart=${ours.length} ===`);
    if (missing.length > 0) {
        console.log(`MISSING (VS Code folds these, Smart Folding does not): ${missing.length}`);
        for (const r of missing) console.log(describe(r, lines));
    }
    if (allowedExtras.length > 0) {
        console.log(
            `ALLOWED EXTRA (intentional WebStorm behavior, see allowlist.json): ${allowedExtras.length}`
        );
        for (const r of allowedExtras) console.log(describe(r, lines));
    }
    if (unexpectedExtras.length > 0) {
        console.log(
            `EXTRA (Smart Folding folds these, VS Code does not): ${unexpectedExtras.length}`
        );
        for (const r of unexpectedExtras) console.log(describe(r, lines));
    }
    if (missing.length === 0 && extras.length === 0) {
        console.log('PERFECT MATCH');
    }
}

if (totalMissing > 0) {
    failed = true;
    console.error(`\nParity check FAILED: ${totalMissing} native VS Code range(s) missing.`);
}
if (STRICT && totalUnexpectedExtras > 0) {
    failed = true;
    console.error(
        `\nParity check FAILED (strict): ${totalUnexpectedExtras} unexpected extra range(s). ` +
            'Add intentional divergences to fixtures/parity/allowlist.json.'
    );
}

if (failed) {
    process.exit(1);
}
console.log(
    `\nParity check passed: every native VS Code range is produced` +
        (STRICT ? ' (strict: no unexpected extras).' : ' (lenient: extras reported, not failed).')
);
