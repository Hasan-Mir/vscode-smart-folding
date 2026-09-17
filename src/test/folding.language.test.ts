import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    badgeClickDropsRememberedCursor,
    computeFoldingRanges,
    extendCopyRange,
    SimpleFoldingRange,
    takeoverLanguages,
    unfoldPathForLine,
} from '../core/folding';

const TS = {
    singleLineFolds: true,
    foldComments: true,
    languageId: 'typescript',
};
const TS_VSCODE = {
    singleLineFolds: false,
    foldComments: true,
    languageId: 'typescript',
};

function plain(ranges: SimpleFoldingRange[]): Array<{ start: number; end: number }> {
    return ranges.map(r => ({ start: r.start, end: r.end }));
}

// --- Regex literals ----------------------------------------------------------

test('brackets and quotes inside regex literals do not corrupt bracket matching', () => {
    const code = [
        "const re = /[{\"']/g;", // 0 — unbalanced `{` and quotes inside a regex
        'function f() {', // 1
        '  return re;', // 2
        '}', // 3
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [{ start: 1, end: 3 }]);
});

test('regex after return/(=/, and other operator contexts is skipped', () => {
    const code = [
        'function f(s) {', // 0
        '  if (/^[a-z{]+$/.test(s)) {', // 1
        '    return /}"/.exec(s);', // 2
        '  }', // 3
        '}', // 4
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [
        { start: 0, end: 4 },
        { start: 1, end: 3 },
    ]);
});

test('division is NOT mistaken for a regex (brackets afterwards still count)', () => {
    const code = [
        'const x = a / b / c;', // 0
        'const obj = {', // 1
        '  y: 1,', // 2
        '};', // 3
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [{ start: 1, end: 3 }]);
});

// --- #region markers ---------------------------------------------------------

test('// #region markers fold (including the #endregion line), nested', () => {
    const code = [
        '// #region outer', // 0
        'const a = 1;', // 1
        '//#region inner', // 2
        'const b = 2;', // 3
        '// #endregion', // 4
        'const c = 3;', // 5
        '// #endregion', // 6
    ].join('\n');
    const ranges = computeFoldingRanges(code, TS);
    assert.deepEqual(
        ranges.filter(r => r.kind === 'region'),
        [
            { start: 0, end: 6, kind: 'region' },
            { start: 2, end: 4, kind: 'region' },
        ]
    );
});

test('#region (C#) and #pragma region (C/C++) dialects fold', () => {
    const csharp = ['#region Setup', 'int x = 1;', '#endregion'].join('\n');
    assert.deepEqual(
        computeFoldingRanges(csharp, { ...TS, languageId: 'csharp' }).filter(
            r => r.kind === 'region'
        ),
        [{ start: 0, end: 2, kind: 'region' }]
    );
    const cpp = ['#pragma region Setup', 'int x = 1;', '#pragma endregion'].join('\n');
    assert.deepEqual(
        computeFoldingRanges(cpp, { ...TS, languageId: 'cpp' }).filter(r => r.kind === 'region'),
        [{ start: 0, end: 2, kind: 'region' }]
    );
});

// --- Import runs -------------------------------------------------------------

test('runs of 2+ imports fold as one imports region', () => {
    const code = [
        "import a from 'a';", // 0
        "import { b } from 'b';", // 1
        "import * as c from 'c';", // 2
        '', // 3
        'const x = 1;', // 4
    ].join('\n');
    const ranges = computeFoldingRanges(code, TS);
    assert.deepEqual(
        ranges.filter(r => r.kind === 'imports'),
        [{ start: 0, end: 2, kind: 'imports' }]
    );
});

test('multi-line imports extend the run; blank lines inside do not break it', () => {
    const code = [
        'import {', // 0
        '  first,', // 1
        '  second,', // 2
        "} from 'a';", // 3
        '', // 4
        "import b from 'b';", // 5
        'const done = true;', // 6
    ].join('\n');
    const ranges = computeFoldingRanges(code, TS);
    assert.deepEqual(
        ranges.filter(r => r.kind === 'imports'),
        [{ start: 0, end: 5, kind: 'imports' }]
    );
});

test('a single import (even multi-line) produces no imports region', () => {
    const code = ['import {', '  a,', "} from 'a';", 'const x = 1;'].join('\n');
    assert.deepEqual(
        computeFoldingRanges(code, TS).filter(r => r.kind === 'imports'),
        []
    );
});

test('a non-import line breaks the run', () => {
    const code = [
        "import a from 'a';", // 0
        "import b from 'b';", // 1
        'const between = 1;', // 2
        "import c from 'c';", // 3
        "import d from 'd';", // 4
    ].join('\n');
    assert.deepEqual(
        computeFoldingRanges(code, TS).filter(r => r.kind === 'imports'),
        [
            { start: 0, end: 1, kind: 'imports' },
            { start: 3, end: 4, kind: 'imports' },
        ]
    );
});

// --- Template literals -------------------------------------------------------

test('multi-line template literals fold; closing backtick stays visible in VS Code mode', () => {
    const code = [
        'const s = `first', // 0
        '  second', // 1
        '  third', // 2
        '`;', // 3
        'const t = 1;', // 4
    ].join('\n');
    // Native VS Code (tsserver) keeps the closing-backtick line visible.
    assert.deepEqual(plain(computeFoldingRanges(code, TS_VSCODE)), [{ start: 0, end: 2 }]);
    // WebStorm single-line folds swallow it.
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [{ start: 0, end: 3 }]);
});

test('brackets inside template literals are still ignored', () => {
    const code = ['const s = `{ not', 'a block }`;', 'function f() {', '  return s;', '}'].join(
        '\n'
    );
    const ranges = computeFoldingRanges(code, TS);
    assert.ok(ranges.some(r => r.start === 2 && r.end === 4));
    assert.ok(!ranges.some(r => r.start === 0 && r.end === 4));
});

// --- switch/case clauses -----------------------------------------------------

test('case and default clauses inside a switch fold', () => {
    const code = [
        'switch (value) {', // 0
        '  case 1:', // 1
        '    a();', // 2
        '    break;', // 3
        '  case 2:', // 4
        '    b();', // 5
        '    break;', // 6
        '  default:', // 7
        '    c();', // 8
        '}', // 9
    ].join('\n');
    const ranges = plain(computeFoldingRanges(code, TS));
    assert.deepEqual(ranges, [
        { start: 0, end: 9 }, // the switch block itself
        { start: 1, end: 3 }, // case 1
        { start: 4, end: 6 }, // case 2
        { start: 7, end: 8 }, // default
    ]);
});

test('a `default:` property in an object literal does NOT fold as a case clause', () => {
    const code = [
        'const config = {', // 0
        '  default:', // 1
        '    makeDefault(),', // 2
        '  other: 1,', // 3
        '};', // 4
    ].join('\n');
    const ranges = plain(computeFoldingRanges(code, TS));
    assert.deepEqual(ranges, [{ start: 0, end: 4 }]);
});

// --- Parenthesized signature groups merge with the body ----------------------

test('multi-line call arguments fold', () => {
    const code = [
        'console.log(', // 0
        "  'a',", // 1
        "  'b'", // 2
        ');', // 3
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [{ start: 0, end: 3 }]);
});

test('function-signature parens merge with the body (no dangling header)', () => {
    const code = [
        'async function f(', // 0
        '  a: string,', // 1
        '  b: number,', // 2
        '): Promise<void> {', // 3
        '  await go(a, b);', // 4
        '}', // 5
    ].join('\n');
    const ranges = plain(computeFoldingRanges(code, TS));
    assert.deepEqual(ranges, [
        { start: 0, end: 5 },
        { start: 3, end: 5 },
    ]);
});

test('chained arrays and concise arrows never swallow the next header', () => {
    const chained = [
        'pipe([', // 0
        '    op1,', // 1
        '    op2', // 2
        '], [', // 3
        '    op3,', // 4
        '    op4', // 5
        ']);', // 6
    ].join('\n');
    const chainedRanges = plain(computeFoldingRanges(chained, TS));
    // First array clamps to 0..2 — line 3 (`], [`) stays visible so the
    // second array can fold independently.
    assert.ok(chainedRanges.some(r => r.start === 0 && r.end === 2));
    assert.ok(chainedRanges.some(r => r.start === 3 && r.end === 6));

    const concise = [
        'const getID = (props: {', // 0
        '    id: string;', // 1
        '}) => props.id;', // 2
    ].join('\n');
    const conciseRanges = plain(computeFoldingRanges(concise, TS));
    // The concise body has no braces: the props literal must NOT swallow
    // line 2 (`}) => props.id;`), which holds the implementation.
    assert.ok(conciseRanges.some(r => r.start === 0 && r.end === 1));
    assert.ok(!conciseRanges.some(r => r.start === 0 && r.end >= 2));
});

// --- `#` lines in C-family / PHP ---------------------------------------------

test('C-family preprocessor directives never corrupt bracket matching', () => {
    const code = [
        '#define PAIR {1, 2}', // 0 — unbalanced-looking braces in a macro
        'int main() {', // 1
        '  return 0;', // 2
        '}', // 3
    ].join('\n');
    const ranges = plain(computeFoldingRanges(code, { ...TS, languageId: 'c' }));
    assert.deepEqual(ranges, [{ start: 1, end: 3 }]);
});

test('JS/TS private class members starting with # are unaffected', () => {
    const code = [
        'class A {', // 0
        '  #hidden() {', // 1
        '    return 1;', // 2
        '  }', // 3
        '}', // 4
    ].join('\n');
    const ranges = plain(computeFoldingRanges(code, TS));
    assert.deepEqual(ranges, [
        { start: 0, end: 4 },
        { start: 1, end: 3 },
    ]);
});

// --- Badge click vs remembered cursor (the cursor-jump bug) -------------------

test('badge click on a fold hiding the remembered cursor drops the remembered state', () => {
    const fold = { header: 10, hiddenEnd: 40 };
    // Remembered cursor deep inside the clicked block (grandchild etc.).
    assert.equal(badgeClickDropsRememberedCursor(fold, 25), true);
    // Remembered cursor exactly on the clicked header (Fold All clamp line).
    assert.equal(badgeClickDropsRememberedCursor(fold, 10), true);
    // Last hidden line still counts as inside.
    assert.equal(badgeClickDropsRememberedCursor(fold, 40), true);
});

test('badge click on an UNRELATED fold keeps the remembered state', () => {
    const fold = { header: 10, hiddenEnd: 40 };
    assert.equal(badgeClickDropsRememberedCursor(fold, 9), false);
    assert.equal(badgeClickDropsRememberedCursor(fold, 41), false);
    assert.equal(badgeClickDropsRememberedCursor(fold, 100), false);
});

// --- JSX (javascript / javascriptreact / typescriptreact) --------------------

const TSX_VSCODE = {
    singleLineFolds: false,
    foldComments: true,
    languageId: 'typescriptreact',
};
const TSX = {
    singleLineFolds: true,
    foldComments: true,
    languageId: 'typescriptreact',
};

test('JSX elements fold from the opening tag through the CLOSING tag line', () => {
    const code = [
        'function App() {', // 0
        '    return (', // 1
        '        <div>', // 2
        '            <p>hi</p>', // 3
        '        </div>', // 4
        '    );', // 5
        '}', // 6
    ].join('\n');
    const ranges = computeFoldingRanges(code, TSX_VSCODE);
    // Native VS Code includes the `</div>` line (`>` is not a fold-end pair
    // character in the typescript-language-features conversion).
    assert.ok(ranges.some(r => r.start === 2 && r.end === 4), 'element fold includes </div> line');
    assert.ok(ranges.some(r => r.start === 1 && r.end === 4), 'return ( … ) still folds');
    assert.ok(ranges.some(r => r.start === 0 && r.end === 5), 'function body still folds');
});

test("apostrophes and quotes in JSX text can't corrupt the rest of the file", () => {
    const code = [
        'function App() {', // 0
        "    return <p>Don't panic, it's \"fine\"</p>;", // 1
        '}', // 2
        'function after() {', // 3
        '    body();', // 4
        '}', // 5
    ].join('\n');
    const ranges = computeFoldingRanges(code, TSX_VSCODE);
    assert.ok(ranges.some(r => r.start === 3 && r.end === 4), 'code after JSX still folds');
});

test('JSX child expressions `{…}` fold like native JsxExpression spans', () => {
    const code = [
        'const x = (', // 0
        '    <ul>', // 1
        '        {items.map(item => {', // 2
        '            return <li key={item}>{item}</li>;', // 3
        '        })}', // 4
        '    </ul>', // 5
        ');', // 6
    ].join('\n');
    const ranges = computeFoldingRanges(code, TSX_VSCODE);
    assert.ok(ranges.some(r => r.start === 1 && r.end === 5), '<ul> element folds');
    // The `{items.map(…)}` expression keeps its closing `})}` line visible.
    assert.ok(ranges.some(r => r.start === 2 && r.end === 3), 'child expression folds');
});

test('self-closing elements fold their multi-line attribute list only', () => {
    const code = [
        'const w = (', // 0
        '    <Widget', // 1
        '        a={1}', // 2
        '        b="two"', // 3
        '    />', // 4
        ');', // 5
    ].join('\n');
    const ranges = computeFoldingRanges(code, TSX_VSCODE);
    // Native: spanForJSXAttributes — first attribute line .. last attribute line.
    assert.ok(ranges.some(r => r.start === 2 && r.end === 3), 'attribute list folds');
    assert.ok(!ranges.some(r => r.start === 1), 'no element fold for a self-closing tag');
});

test('JSX fragments fold including their closing `</>` line', () => {
    const code = [
        'const f = (', // 0
        '    <>', // 1
        '        <span>a</span>', // 2
        '        <span>b</span>', // 3
        '    </>', // 4
        ');', // 5
    ].join('\n');
    const ranges = computeFoldingRanges(code, TSX_VSCODE);
    assert.ok(ranges.some(r => r.start === 1 && r.end === 4), 'fragment folds through </>');
});

test('the `<T,>` generic-arrow comma hack is NOT treated as JSX (backtracks)', () => {
    const code = [
        'const generic = <T,>(value: T): T[] => {', // 0
        '    return [value];', // 1
        '};', // 2
        'function after() {', // 3
        '    body();', // 4
        '}', // 5
    ].join('\n');
    const ranges = computeFoldingRanges(code, TSX_VSCODE);
    assert.ok(ranges.some(r => r.start === 0 && r.end === 1), 'arrow body folds normally');
    assert.ok(ranges.some(r => r.start === 3 && r.end === 4), 'code after the hack still folds');
});

test('`<T extends …>` generic arrows are excluded by lookahead', () => {
    const code = [
        'const generic = <T extends object>(value: T) => {', // 0
        '    return value;', // 1
        '};', // 2
        'function after() {', // 3
        '    body();', // 4
        '}', // 5
    ].join('\n');
    const ranges = computeFoldingRanges(code, TSX_VSCODE);
    assert.ok(ranges.some(r => r.start === 0 && r.end === 1), 'arrow body folds normally');
    assert.ok(ranges.some(r => r.start === 3 && r.end === 4), 'code after still folds');
});

test('generic calls and comparisons never start JSX', () => {
    const code = [
        'function f() {', // 0
        '    const a = new Map<string, number>();', // 1
        '    const ok = a.size < b && c > d;', // 2
        '    return ok;', // 3
        '}', // 4
    ].join('\n');
    const ranges = computeFoldingRanges(code, TSX_VSCODE);
    assert.ok(ranges.some(r => r.start === 0 && r.end === 3), 'function body folds');
    assert.equal(
        ranges.filter(r => r.kind === undefined).length,
        1,
        'no bogus JSX ranges appear'
    );
});

test('JSX nested inside expressions inside JSX folds at every level', () => {
    const code = [
        'const x = (', // 0
        '    <div>', // 1
        '        {cond && (', // 2
        '            <section>', // 3
        '                <p>inner</p>', // 4
        '            </section>', // 5
        '        )}', // 6
        '    </div>', // 7
        ');', // 8
    ].join('\n');
    const ranges = computeFoldingRanges(code, TSX_VSCODE);
    assert.ok(ranges.some(r => r.start === 1 && r.end === 7), 'outer element folds');
    assert.ok(ranges.some(r => r.start === 3 && r.end === 5), 'nested element folds');
    assert.ok(ranges.some(r => r.start === 2 && r.end === 5), 'wrapping expression folds');
});

test('plain javascript files fold JSX too, but plain typescript never does', () => {
    const code = [
        'function f() {', // 0
        '    return (', // 1
        '        <div>', // 2
        '            <p>hi</p>', // 3
        '        </div>', // 4
        '    );', // 5
        '}', // 6
    ].join('\n');
    const js = computeFoldingRanges(code, { ...TSX_VSCODE, languageId: 'javascript' });
    assert.ok(js.some(r => r.start === 2 && r.end === 4), '.js files fold JSX (tsserver allows it)');
    const ts = computeFoldingRanges(code, { ...TSX_VSCODE, languageId: 'typescript' });
    assert.ok(!ts.some(r => r.start === 2 && r.end === 4), 'plain .ts never parses JSX');
});

test('WebStorm-mode options keep the same JSX ranges', () => {
    const code = [
        'const x = (', // 0
        '    <div className="a">', // 1
        '        <p>hi</p>', // 2
        '    </div>', // 3
        ');', // 4
    ].join('\n');
    const ranges = computeFoldingRanges(code, TSX);
    assert.ok(ranges.some(r => r.start === 1 && r.end === 3), 'element folds in WebStorm mode');
});

// --- Copying collapsed blocks -------------------------------------------------

const COPY_FOLDS = [
    { header: 2, hiddenEnd: 5 },
    { header: 10, hiddenEnd: 12 },
];
const COPY_LEN = (_line: number): number => 20;

test('line copy (empty selection) on a collapsed header copies the whole block', () => {
    const ext = extendCopyRange(
        { startLine: 2, startCharacter: 7, endLine: 2, endCharacter: 7 },
        COPY_FOLDS,
        COPY_LEN
    );
    assert.deepEqual(ext, {
        startLine: 2,
        startCharacter: 0,
        endLine: 5,
        endCharacter: 20,
        isLineCopy: true,
    });
});

test('line copy on an ordinary line keeps the native copy', () => {
    const ext = extendCopyRange(
        { startLine: 7, startCharacter: 3, endLine: 7, endCharacter: 3 },
        COPY_FOLDS,
        COPY_LEN
    );
    assert.equal(ext, undefined);
});

test('a selection reaching the end of a collapsed row widens through the block', () => {
    const ext = extendCopyRange(
        { startLine: 2, startCharacter: 4, endLine: 2, endCharacter: 20 },
        COPY_FOLDS,
        COPY_LEN
    );
    assert.deepEqual(ext, {
        startLine: 2,
        startCharacter: 4,
        endLine: 5,
        endCharacter: 20,
        isLineCopy: false,
    });
});

test('a selection stopping before the visible end is NOT widened', () => {
    const ext = extendCopyRange(
        { startLine: 2, startCharacter: 0, endLine: 2, endCharacter: 11 },
        COPY_FOLDS,
        COPY_LEN
    );
    assert.equal(ext, undefined);
});

test('a drag that stops at the badge (first hidden column) counts as line end', () => {
    const visibleEnd = (line: number): number => (line === 2 ? 12 : 20);
    const ext = extendCopyRange(
        { startLine: 2, startCharacter: 0, endLine: 2, endCharacter: 12 },
        COPY_FOLDS,
        COPY_LEN,
        visibleEnd
    );
    assert.deepEqual(ext, {
        startLine: 2,
        startCharacter: 0,
        endLine: 5,
        endCharacter: 20,
        isLineCopy: false,
    });
});

test('multi-line selections ending on ordinary lines keep the native copy', () => {
    const ext = extendCopyRange(
        { startLine: 0, startCharacter: 0, endLine: 8, endCharacter: 20 },
        COPY_FOLDS,
        COPY_LEN
    );
    assert.equal(ext, undefined);
});

// =============================================================================
// F-1 through F-13: feature-specific regression tests
// =============================================================================

// --- F-1: malformed-input recovery (stray closer ignored) ----------------------

test('F-1: sentinel — stray closer inside interpolation does not break template + function folds', () => {
    const code = [
        '`a${ b ] }c`', // 0 — stray `]` inside `${…}` is ignored (sentinel boundary)
        'function f() {', // 1
        '  body();', // 2
        '}', // 3
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [{ start: 1, end: 3 }]);
});

test('F-1: stray `}` with no matching opener above a `${` sentinel is ignored', () => {
    const code = [
        'const x = `a${ b }c`;', // 0
        'function f() {', // 1
        '  body();', // 2
        '}', // 3
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [{ start: 1, end: 3 }]);
});

test('F-1: stray `)` with no matching opener is ignored', () => {
    const code = [
        'const x = 1;', // 0
        ');', // 1 — stray closer
        'function f() {', // 2
        '  body();', // 3
        '}', // 4
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [{ start: 2, end: 4 }]);
});

// --- F-2: escaped line continuation in strings ---------------------------------

test('F-2: backslash-newline in a string does not misattribute folds', () => {
    const code = [
        "const s = 'abc\\", // 0 — escaped newline (line continuation)
        "def';", // 1
        'function f() {', // 2
        '  return s;', // 3
        '}', // 4
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [{ start: 2, end: 4 }]);
});

test('F-2: escaped \\r\\n in a string does not misattribute folds', () => {
    const code = "const s = 'abc\\\r\ndef';\nfunction f() {\n  return s;\n}\n";
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [{ start: 2, end: 4 }]);
});

test('F-2: multi-line single-quoted string with escaped continuation', () => {
    const code = [
        "const s = 'line1\\", // 0
        "line2\\", // 1
        "line3';", // 2
        'function f() {', // 3
        '  return s;', // 4
        '}', // 5
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [{ start: 3, end: 5 }]);
});

test('F-2: template literal with escaped newline does not break folding', () => {
    const code = [
        'const s = `line1\\', // 0
        'line2`;', // 1
        'function f() {', // 2
        '  return s;', // 3
        '}', // 4
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [
        { start: 0, end: 1 }, // the template legitimately spans 2 lines and folds
        { start: 2, end: 4 },
    ]);
});

// --- F-3: JSX generic arrows / variance annotations ---------------------------

test('F-3: `<T extends U>` is a generic constraint, not JSX', () => {
    const code = [
        'function f<T extends U>() {', // 0
        '  return null;', // 1
        '}', // 2
    ].join('\n');
    assert.deepEqual(
        plain(computeFoldingRanges(code, { ...TS, languageId: 'typescriptreact' })),
        [{ start: 0, end: 2 }]
    );
});

test('F-3: `<T = string>` is a generic default, not JSX', () => {
    const code = [
        'function f<T = string>() {', // 0
        '  return null;', // 1
        '}', // 2
    ].join('\n');
    assert.deepEqual(
        plain(computeFoldingRanges(code, { ...TS, languageId: 'typescriptreact' })),
        [{ start: 0, end: 2 }]
    );
});

test('F-3: `<in T>` / `<out T>` variance annotations are not JSX', () => {
    const code = [
        'type F<in T> = (x: T) => void;', // 0
        'type G<out T> = () => T;', // 1
        'function h() {', // 2
        '  return null;', // 3
        '}', // 4
    ].join('\n');
    assert.deepEqual(
        plain(computeFoldingRanges(code, { ...TS, languageId: 'typescriptreact' })),
        [{ start: 2, end: 4 }]
    );
});

// --- F-4: control-statement conditions / case clauses in switch body -----------

test('F-4: case clauses fold only inside a real switch body', () => {
    const code = [
        'switch (v) {', // 0
        '  case 1:', // 1
        '    a();', // 2
        '    break;', // 3
        '  default:', // 4
        '    b();', // 5
        '}', // 6
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [
        { start: 0, end: 6 },
        { start: 1, end: 3 },
        { start: 4, end: 5 },
    ]);
});

test('F-4: object literal with switch/default keys does NOT trigger case folding', () => {
    const code = [
        'const obj = {', // 0
        '  switch: true,', // 1
        '  default: 1,', // 2
        '};', // 3
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [{ start: 0, end: 3 }]);
});

test('F-4: multiline switch header — body recognized via pendingControlClose', () => {
    const code = [
        'switch (', // 0
        '  v', // 1
        ') {', // 2
        '  case 1:', // 3
        '    a();', // 4
        '}', // 5
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [
        { start: 0, end: 5 },
        { start: 3, end: 4 },
    ]);
});

test('Allman declaration with trailing block comment folds from header', () => {
    const code = [
        'function calculate(x: number) /* pure */', // 0
        '{', // 1
        '    return x * 2;', // 2
        '}', // 3
    ].join('\n');
    const ranges = computeFoldingRanges(code, TS);
    assert.ok(
        ranges.some(r => r.start === 0 && r.end === 3),
        'declaration with trailing block comment must fold from header line 0'
    );
});

test('F-4: Allman switch — brace on next line recognized as body', () => {
    const code = [
        'switch (v)', // 0
        '{', // 1
        '  case 1:', // 2
        '    a();', // 3
        '}', // 4
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [
        { start: 0, end: 4 },
        { start: 2, end: 3 },
    ]);
});

// --- F-5: regex after control-statement close ---------------------------------

test('F-5: regex after `if (…)` close is a literal, not division', () => {
    const code = [
        'function f() {', // 0
        '  if (x) /[a-z]/.test(y);', // 1
        '}', // 2
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [{ start: 0, end: 2 }]);
});

test('F-5: regex after `while (…)` close is a literal', () => {
    const code = [
        'function f() {', // 0
        '  while (x) /[a-z]/.test(y);', // 1
        '}', // 2
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [{ start: 0, end: 2 }]);
});

test('F-5: regex after `for (…)` close is a literal', () => {
    const code = [
        'function f() {', // 0
        '  for (let i = 0; i < 10; i++) /[a-z]/.test(i);', // 1
        '}', // 2
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [{ start: 0, end: 2 }]);
});

test('F-5: while/for/with/catch — try/catch bodies fold correctly', () => {
    const code = [
        'function f() {', // 0
        '  a();', // 1
        '  b();', // 2
        '  c();', // 3
        '  try {', // 4
        '    d();', // 5
        '  } catch (e) {', // 6
        '    f();', // 7
        '  }', // 8
        '}', // 9
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [
        { start: 0, end: 9 },
        { start: 4, end: 5 }, // `} catch (e) {` stays visible (not swallowed)
        { start: 6, end: 8 },
    ]);
});

// --- F-6: URL strings — `//` inside strings not mistaken for comments ----------

test('F-6: `//` inside a single-quoted string is not a comment', () => {
    const code = [
        "const url = 'http://example.com';", // 0
        'function f() {', // 1
        '  return url;', // 2
        '}', // 3
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [{ start: 1, end: 3 }]);
});

test('F-6: `//` inside a double-quoted string is not a comment', () => {
    const code = [
        'const url = "https://example.com";', // 0
        'function f() {', // 1
        '  return url;', // 2
        '}', // 3
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [{ start: 1, end: 3 }]);
});

test('F-6: `/* … */` inside a string is not a block comment', () => {
    const code = [
        "const s = '/* not a comment */';", // 0
        'function f() {', // 1
        '  return s;', // 2
        '}', // 3
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [{ start: 1, end: 3 }]);
});

test('F-6: `//` inside a template literal is not a comment', () => {
    const code = [
        'const url = `http://example.com`;', // 0
        'function f() {', // 1
        '  return url;', // 2
        '}', // 3
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [{ start: 1, end: 3 }]);
});

// --- F-7: trailing comments on closing line in paren-merge --------------------

test('F-7: trailing comment on closing paren line does not block body merge (WebStorm)', () => {
    const code = [
        'function f(', // 0
        '  a: number,', // 1
        '  b: string', // 2
        '): void { // main entry', // 3 — trailing comment ignored
        '  return;', // 4
        '}', // 5
    ].join('\n');
    const ranges = computeFoldingRanges(code, TS);
    assert.ok(ranges.some(r => r.start === 0 && r.end === 5), 'signature should merge through body');
});

test('F-7: trailing comment on closing paren line (VS Code mode)', () => {
    const code = [
        'function f(', // 0
        '  a: number,', // 1
        '  b: string', // 2
        '): void { // main entry', // 3
        '  return;', // 4
        '}', // 5
    ].join('\n');
    const ranges = computeFoldingRanges(code, TS_VSCODE);
    assert.ok(ranges.some(r => r.start === 0 && r.end === 4), 'signature should merge through body');
});

test('F-7: `=> {` with trailing comment still merges', () => {
    const code = [
        'const f = (', // 0
        '  a: number', // 1
        ') => { // arrow body', // 2
        '  return a;', // 3
        '};', // 4
    ].join('\n');
    const ranges = computeFoldingRanges(code, TS);
    assert.ok(ranges.some(r => r.start === 0 && r.end === 4), 'arrow signature should merge through body');
});

// --- F-8: multiline braceless import statements (terminated by `;`) ------------

test('F-8: multiline import with explicit braces folds as one run', () => {
    const code = [
        "import {", // 0
        "  a,", // 1
        "  b,", // 2,
        "} from 'mod';", // 3
        "import { c } from 'other';", // 4
        '', // 5
        'function f() {', // 6
        '  return a;', // 7
        '}', // 8
    ].join('\n');
    const ranges = computeFoldingRanges(code, TS);
    assert.ok(ranges.some(r => r.kind === 'imports' && r.start === 0 && r.end === 4), 'import run folds');
});

test('F-8: braceless multiline import terminated by `;`', () => {
    const code = [
        "import a from", // 0
        "  'mod';", // 1
        "import b from 'other';", // 2
        '', // 3
        'function f() {', // 4
        '  return a;', // 5
        '}', // 6
    ].join('\n');
    const ranges = computeFoldingRanges(code, TS);
    assert.ok(ranges.some(r => r.kind === 'imports' && r.start === 0 && r.end === 2), 'import run folds');
});

// --- F-9: #region / #endregion marker lines ------------------------------------

test('F-9: `// #region` lines do not join an ordinary comment run', () => {
    const code = [
        '// #region section', // 0
        '// a region body', // 1
        '// #endregion', // 2
        '// ordinary comment', // 3
        '// another comment', // 4
    ].join('\n');
    const ranges = computeFoldingRanges(code, TS);
    const regionRanges = ranges.filter(r => r.kind === 'region');
    const commentRanges = ranges.filter(r => r.kind === 'comment');
    assert.deepEqual(regionRanges, [{ start: 0, end: 2, kind: 'region' }]);
    assert.deepEqual(commentRanges, [{ start: 3, end: 4, kind: 'comment' }]);
});

// --- F-10: PHP `#` comments and `#[` attributes -------------------------------

test('F-10: PHP `#` comment line is not scanned for brackets', () => {
    const code = [
        '<?php', // 0
        '# this is a comment {', // 1
        'function f() {', // 2
        '  return 1;', // 3
        '}', // 4
    ].join('\n');
    assert.deepEqual(
        plain(computeFoldingRanges(code, { ...TS, languageId: 'php' })),
        [{ start: 2, end: 4 }]
    );
});

test('F-10: PHP `#[` attribute is code, not a comment', () => {
    const code = [
        '<?php', // 0
        '#[Attribute]', // 1
        'class C {', // 2
        '  public function f() {', // 3
        '    return 1;', // 4
        '  }', // 5
        '}', // 6
    ].join('\n');
    assert.deepEqual(
        plain(computeFoldingRanges(code, { ...TS, languageId: 'php' })),
        [
            { start: 2, end: 6 },
            { start: 3, end: 5 },
        ]
    );
});

test('F-10: PHP `#region` marker folds', () => {
    const code = [
        '<?php', // 0
        '#region setup', // 1
        '$x = 1;', // 2
        '#endregion', // 3
    ].join('\n');
    const ranges = computeFoldingRanges(code, { ...TS, languageId: 'php' });
    assert.ok(ranges.some(r => r.kind === 'region' && r.start === 1 && r.end === 3));
});

// --- F-11: C# `using` vs `using var` / `using (…)` statements ------------------

test('F-11: C# `using` statement (import) folds in a run', () => {
    const code = [
        'using System;', // 0
        'using System.Collections;', // 1
        '', // 2
        'class C {', // 3
        '  void M() {', // 4
        '  }', // 5
        '}', // 6
    ].join('\n');
    const ranges = computeFoldingRanges(code, { ...TS, languageId: 'csharp' });
    assert.ok(ranges.some(r => r.kind === 'imports' && r.start === 0 && r.end === 1));
});

test('F-11: C# `using var x = …` is NOT an import (no run fold)', () => {
    const code = [
        'using var x = Make();', // 0
        'using var y = Make();', // 1
        '', // 2
        'class C {', // 3
        '  void M() {', // 4
        '  }', // 5
        '}', // 6
    ].join('\n');
    const ranges = computeFoldingRanges(code, { ...TS, languageId: 'csharp' });
    const imports = ranges.filter(r => r.kind === 'imports');
    assert.deepEqual(imports, []);
});

// --- F-12: Allman style (brace on next line) -----------------------------------

test('F-12: Allman function declaration — paren merges with body', () => {
    const code = [
        'function f(', // 0
        '  a: number', // 1
        '): string', // 2
        '{', // 3
        '  return a;', // 4
        '}', // 5
    ].join('\n');
    const ranges = computeFoldingRanges(code, TS);
    assert.ok(ranges.some(r => r.start === 0 && r.end === 5), 'Allman declaration should merge through body');
});

test('F-12: Allman if-statement body folds from keyword line', () => {
    const code = [
        'function f() {', // 0
        '  if (x)', // 1
        '  {', // 2
        '    y();', // 3
        '  }', // 4
        '}', // 5
    ].join('\n');
    const ranges = computeFoldingRanges(code, TS);
    assert.ok(ranges.some(r => r.start === 1 && r.end === 4), 'Allman if body folds from keyword line');
});

// --- F-13: takeover-excluded languages -----------------------------------------

test('F-13: takeoverLanguages excludes C/C++/C#/Java/PHP', () => {
    const all = ['typescript', 'javascript', 'c', 'cpp', 'csharp', 'java', 'php', 'python'];
    const result = takeoverLanguages(all);
    assert.deepEqual(result, ['typescript', 'javascript', 'python']);
});
// --- Second-adversarial-review fixes (round 3) --------------------------------
// Every case below was verified against real tsserver output (the parity
// harness conversion) before the fix; the assertions pin the corrected ranges.

test('R-F-A: a closing line carrying a second statement is never swallowed', () => {
    const call = [
        'const result = compute(', // 0
        '    1,', // 1
        '    2,', // 2
        '    3', // 3
        '); return result;', // 4 — `return result;` shares the closing line
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(call, TS)), [{ start: 0, end: 3 }]);

    for (const tail of [']; throw err;', ']; break;', ']; continue;', ']; cleanup;']) {
        const code = ['const a = [', '    1', tail].join('\n');
        assert.deepEqual(
            plain(computeFoldingRanges(code, TS)),
            [{ start: 0, end: 1 }],
            `"${tail}" carries a statement — the fold must stop above it`
        );
    }

    const elseTail = ['if (a) {', '    b();', '} else cleanup;'].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(elseTail, TS)), [{ start: 0, end: 1 }]);
});

test('R-F-A: trailing-only suffixes are still swallowed (single-line fold kept)', () => {
    assert.deepEqual(
        plain(computeFoldingRanges(['const a = [', '    1', '] as const;'].join('\n'), TS)),
        [{ start: 0, end: 2 }]
    );
    assert.deepEqual(
        plain(computeFoldingRanges(['const a = [', '    1', '];'].join('\n'), TS)),
        [{ start: 0, end: 2 }]
    );
    // A destructured import's closing line (`} from 'node:fs';`) is a
    // trailing-only suffix and may still be swallowed.
    const named = ['import {', '    readFile,', "} from 'node:fs';"].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(named, TS)), [{ start: 0, end: 2 }]);
});

test('R-F-C: comments between a switch condition and its brace keep the case folds', () => {
    const heads: string[][] = [
        ['switch (value) // route', '{'],
        ['switch (value)', '// pick a branch', '{'],
        ['switch (value) /* pick */', '{'],
    ];
    for (const head of heads) {
        const lines = [...head, '    case 1:', '        a();', '        break;', '}'];
        const ranges = computeFoldingRanges(lines.join('\n'), TS);
        const caseLine = head.length;
        assert.ok(
            ranges.some(r => r.start === caseLine && r.end === caseLine + 2),
            `case clause must fold for ${JSON.stringify(head)}`
        );
        assert.ok(
            ranges.some(r => r.start === 0),
            `switch body must fold from the switch line for ${JSON.stringify(head)}`
        );
    }
});

test('R-F-D: a trailing comment does not turn the previous statement into a header', () => {
    const code = [
        'const x = 1; // init', // 0 — ends a statement despite the comment
        '{', // 1
        '    isolated();', // 2
        '}', // 3
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [{ start: 1, end: 3 }]);
});

test('R-R8: a comment line between an Allman header and its brace is not the fold start', () => {
    const code = [
        'function f()', // 0
        '// docs', // 1
        '{', // 2
        '    body();', // 3
        '}', // 4
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS)), [{ start: 0, end: 4 }]);

    const block = [
        'function g()', // 0
        '/* docs', // 1
        '   more */', // 2
        '{', // 3
        '    body();', // 4
        '}', // 5
    ].join('\n');
    const ranges = computeFoldingRanges(block, TS);
    assert.ok(
        ranges.some(r => r.start === 0 && r.end === 5),
        'the fold must start at the declaration line, not at the comment tail'
    );
    // The multi-line comment between header and brace still folds on its own.
    assert.deepEqual(ranges.filter(r => r.kind === 'comment'), [
        { start: 1, end: 2, kind: 'comment' },
    ]);
});

test('R-F-12: a multi-line call followed by a standalone block keeps the block on its own line', () => {
    const code = [
        'foo(', // 0
        '    arg', // 1
        ')', // 2
        '{', // 3
        '    isolated();', // 4
        '}', // 5
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS_VSCODE)), [
        { start: 0, end: 1 },
        { start: 3, end: 4 },
    ]);
});
test('R-R1: a mid-line PHP `#` comment hides the brackets after it', () => {
    const php = { ...TS, languageId: 'php' };
    const closing = [
        '<?php', // 0
        'function f() {', // 1
        '    $x = 1; # }', // 2 — the `}` is inside the comment
        '    $y = 2;', // 3
        '}', // 4
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(closing, php)), [{ start: 1, end: 4 }]);

    const opening = [
        '<?php', // 0
        'function f() {', // 1
        '    $x = 1; # {', // 2 — the `{` is inside the comment
        '    $y = 2;', // 3
        '}', // 4
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(opening, php)), [{ start: 1, end: 4 }]);
});

test('R-F-8: braceless multi-line imports without `;` (ASI) still form one run', () => {
    const code = [
        'import a from', // 0
        "    'a'", // 1
        'import b from', // 2
        "    'b'", // 3
        '', // 4
        'const x = 1;', // 5
    ].join('\n');
    assert.deepEqual(
        computeFoldingRanges(code, TS).filter(r => r.kind === 'imports'),
        [{ start: 0, end: 3, kind: 'imports' }]
    );
});

test('R-F-8: comments between imports keep the run, real code breaks it', () => {
    const lineComment = [
        "import a from 'a';", // 0
        '// why', // 1
        "import b from 'b';", // 2
        '', // 3
        'const x = 1;', // 4
    ].join('\n');
    assert.deepEqual(
        computeFoldingRanges(lineComment, TS).filter(r => r.kind === 'imports'),
        [{ start: 0, end: 2, kind: 'imports' }]
    );

    const blockComment = [
        "import a from 'a';", // 0
        '/* note', // 1
        '   more */', // 2
        "import b from 'b';", // 3
    ].join('\n');
    assert.deepEqual(
        computeFoldingRanges(blockComment, TS).filter(r => r.kind === 'imports'),
        [{ start: 0, end: 3, kind: 'imports' }]
    );

    const realCode = ["import a from 'a';", 'const z = 1;', "import b from 'b';"].join('\n');
    assert.deepEqual(
        computeFoldingRanges(realCode, TS).filter(r => r.kind === 'imports'),
        []
    );
});

test('R-imports: dynamic `import()` and `import.meta` never start an import run', () => {
    const dynamic = ["import('a');", "import('b');"].join('\n');
    assert.deepEqual(
        computeFoldingRanges(dynamic, TS).filter(r => r.kind === 'imports'),
        []
    );
    const meta = ['import.meta;', 'import.meta;'].join('\n');
    assert.deepEqual(
        computeFoldingRanges(meta, TS).filter(r => r.kind === 'imports'),
        []
    );
    // …while real static declarations still do.
    const statics = ["import a from 'a';", "import b from 'b';"].join('\n');
    assert.deepEqual(
        computeFoldingRanges(statics, TS).filter(r => r.kind === 'imports'),
        [{ start: 0, end: 1, kind: 'imports' }]
    );
});

test('R-F-3: a `<T = string>` generic arrow cannot corrupt later line-wise detection', () => {
    const tsx = { ...TS, languageId: 'typescriptreact' };
    const region = [
        'const fn = <T = string>(arg: T) => arg;', // 0
        '', // 1
        '// #region real', // 2
        'const x = 1;', // 3
        '// #endregion', // 4
    ].join('\n');
    assert.ok(
        computeFoldingRanges(region, tsx).some(r => r.kind === 'region' && r.start === 2),
        'the region after the generic arrow must still fold'
    );

    const withBody = [
        'const fn = <T = string>(arg: T) => {', // 0
        '    return arg;', // 1
        '};', // 2
        '', // 3
        'function after() {', // 4
        '    body();', // 5
        '}', // 6
    ].join('\n');
    const ranges = computeFoldingRanges(withBody, tsx);
    assert.ok(ranges.some(r => r.start === 0 && r.end === 2), 'the arrow body still folds');
    assert.ok(ranges.some(r => r.start === 4 && r.end === 6), 'the next function still folds');
});

test('a backtracked false-positive JSX entry does not corrupt following folds', () => {
    const tsx = { ...TS, languageId: 'typescriptreact' };
    const cases = [
        'const g = (x: number) => <B, 2);\nfunction after() {\n    return 1;\n}\n',
        'const g = <B, C>(x: number) => x;\nfunction after() {\n    return 1;\n}\n',
        'call(<B, 2);\nfunction after() {\n    return 1;\n}\n',
    ];
    for (const code of cases) {
        const ranges = computeFoldingRanges(code, tsx);
        assert.ok(
            ranges.some(r => r.start === 1 && r.end === 3),
            `the function after a backtracked JSX entry must still fold:\n${code}`
        );
    }
});
test('R-F-B: an indented Allman method merges its signature with the body', () => {
    const code = [
        'class Box {', // 0
        '    method(', // 1
        '        a: number', // 2
        '    ): string', // 3
        '    {', // 4
        '        return a;', // 5
        '    }', // 6
        '}', // 7
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(code, TS_VSCODE)), [
        { start: 0, end: 6 },
        { start: 1, end: 5 },
    ]);
});

test('R-R10: an Allman declaration without a return annotation still merges', () => {
    const fn = [
        'export function f(', // 0
        '    a: number', // 1
        ')', // 2
        '{', // 3
        '    return a;', // 4
        '}', // 5
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(fn, TS_VSCODE)), [{ start: 0, end: 4 }]);

    const arrow = [
        'export const g = (', // 0
        '    b: number', // 1
        ') =>', // 2
        '{', // 3
        '    return b;', // 4
        '};', // 5
    ].join('\n');
    assert.deepEqual(plain(computeFoldingRanges(arrow, TS_VSCODE)), [{ start: 0, end: 4 }]);
});

test('R-F-7: a block comment continuing past the `{` line still merges the signature', () => {
    const code = [
        'const f = (', // 0
        '    a: number', // 1
        ') => { /* comment', // 2 — the comment continues on the next line
        '*/', // 3
        '    return a;', // 4
        '};', // 5
    ].join('\n');
    const ranges = computeFoldingRanges(code, TS);
    assert.ok(
        ranges.some(r => r.start === 0 && r.end === 5),
        'the signature must merge through the body'
    );
    assert.ok(
        ranges.some(r => r.start === 2 && r.end === 5),
        'the body keeps its own range for progressive unfolding'
    );
});

test('Allman declaration with multi-line block comment on signature line folds from header', () => {
    const code = [
        'function calculate(x: number) /* start', // 0
        '   more docs */', // 1
        '{', // 2
        '    return x * 2;', // 3
        '}', // 4
    ].join('\n');
    const ranges = computeFoldingRanges(code, TS);
    assert.ok(
        ranges.some(r => r.start === 0 && r.end === 4),
        'declaration with signature multi-line block comment must fold from line 0'
    );
});

test('Allman function declaration with blank lines and comments merges signature with body', () => {
    const code = [
        'export function make(', // 0
        '    name: string', // 1
        ')', // 2
        '', // 3
        '// implementation note', // 4
        '{', // 5
        '    return name;', // 6
        '}', // 7
    ].join('\n');
    const ranges = computeFoldingRanges(code, TS_VSCODE);
    assert.deepEqual(plain(ranges.filter(r => r.kind === undefined)), [{ start: 0, end: 6 }]);
});

test('multiline call followed by blank line and standalone block keeps block on its own line', () => {
    const code = [
        'format(', // 0
        '    arg1,', // 1
        '    arg2', // 2
        ')', // 3
        '', // 4
        '{', // 5
        '    standalone();', // 6
        '}', // 7
    ].join('\n');
    const ranges = computeFoldingRanges(code, TS_VSCODE);
    assert.deepEqual(plain(ranges.filter(r => r.kind === undefined)), [
        { start: 0, end: 2 },
        { start: 5, end: 6 },
    ]);
});
// --- Complex Generics, Deep If-Nesting, and Deep Callbacks ------------------

test('complex multi-line conditional generics fold each branch cleanly', () => {
    const code = [
        'export type DeepFlatten<T> = T extends readonly (infer Element)[]', // 0
        '    ? Element extends readonly (infer Nested)[]', // 1
        '      ? DeepFlatten<Nested>[]', // 2
        '      : Element extends object', // 3
        '        ? {', // 4
        '              [K in keyof Element]: DeepFlatten<Element[K]>;', // 5
        '          }', // 6
        '        : Element', // 7
        '    : T extends object', // 8
        '      ? {', // 9
        '            [K in keyof T]: DeepFlatten<T[K]>;', // 10
        '        }', // 11
        '      : T;', // 12
    ].join('\n');
    const ranges = computeFoldingRanges(code, TS);
    assert.ok(ranges.some(r => r.start === 4 && r.end === 6), 'Element mapped type must fold');
    assert.ok(ranges.some(r => r.start === 9 && r.end === 11), 'T mapped type must fold');

    const vsRanges = computeFoldingRanges(code, TS_VSCODE);
    assert.ok(vsRanges.some(r => r.start === 4 && r.end === 5), 'Element mapped type folds in VS Code mode');
    assert.ok(vsRanges.some(r => r.start === 9 && r.end === 10), 'T mapped type folds in VS Code mode');
});

test('multi-line tuple conditional generics fold from [ to ]', () => {
    const code = [
        'export type Reverse<T extends readonly unknown[]> = T extends readonly [', // 0
        '    infer Head,', // 1
        '    ...infer Tail,', // 2
        ']', // 3
        '    ? [...Reverse<Tail>, Head]', // 4
        '    : [];', // 5
    ].join('\n');
    const ranges = computeFoldingRanges(code, TS_VSCODE);
    assert.ok(ranges.some(r => r.start === 0 && r.end === 2), 'tuple type must fold from 0 to 2 in VS Code mode');
});
test('deeply nested if statements (7 levels) fold at every depth and resolve ancestor path', () => {
    const code = [
        'function evaluate(ctx: any, flags: any, level: number): boolean {', // 0
        '    if (flags.active) {', // 1
        '        if (level > 0) {', // 2
        '            if (flags.strict) {', // 3
        '                if (ctx.user) {', // 4
        '                    if (ctx.user.roles) {', // 5
        '                        if (ctx.user.roles.includes("admin")) {', // 6
        '                            if (flags.dryRun) {', // 7
        '                                return true;', // 8
        '                            }', // 9
        '                        }', // 10
        '                    }', // 11
        '                }', // 12
        '            }', // 13
        '        }', // 14
        '    }', // 15
        '    return false;', // 16
        '}', // 17
    ].join('\n');
    const ranges = computeFoldingRanges(code, TS);
    assert.ok(ranges.some(r => r.start === 0 && r.end === 17), 'function body folds');
    assert.ok(ranges.some(r => r.start === 1 && r.end === 15), 'level 1 if folds');
    assert.ok(ranges.some(r => r.start === 2 && r.end === 14), 'level 2 if folds');
    assert.ok(ranges.some(r => r.start === 3 && r.end === 13), 'level 3 if folds');
    assert.ok(ranges.some(r => r.start === 4 && r.end === 12), 'level 4 if folds');
    assert.ok(ranges.some(r => r.start === 5 && r.end === 11), 'level 5 if folds');
    assert.ok(ranges.some(r => r.start === 6 && r.end === 10), 'level 6 if folds');
    assert.ok(ranges.some(r => r.start === 7 && r.end === 9), 'level 7 if folds');

    const path = unfoldPathForLine(ranges, 8);
    assert.deepEqual(path, [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('deep callback chains (4 levels of nested async callbacks) fold each callback frame', () => {
    const code = [
        'function runPipeline(input: string, done: Function) {', // 0
        '    step1(input, (err1, res1) => {', // 1
        '        if (err1) return done(err1);', // 2
        '        step2(res1, (err2, res2) => {', // 3
        '            if (err2) return done(err2);', // 4
        '            step3(res2, (err3, res3) => {', // 5
        '                if (err3) return done(err3);', // 6
        '                step4(res3, (err4, res4) => {', // 7
        '                    done(null, res4);', // 8
        '                });', // 9
        '            });', // 10
        '        });', // 11
        '    });', // 12
        '}', // 13
    ].join('\n');
    const ranges = computeFoldingRanges(code, TS);
    assert.ok(ranges.some(r => r.start === 0 && r.end === 13), 'outer function folds');
    assert.ok(ranges.some(r => r.start === 1 && r.end === 12), 'step 1 callback folds');
    assert.ok(ranges.some(r => r.start === 3 && r.end === 11), 'step 2 callback folds');
    assert.ok(ranges.some(r => r.start === 5 && r.end === 10), 'step 3 callback folds');
    assert.ok(ranges.some(r => r.start === 7 && r.end === 9), 'step 4 callback folds');

    const path = unfoldPathForLine(ranges, 8);
    assert.deepEqual(path, [0, 1, 3, 5, 7]);
});

test('deep promise chains with multi-line arrow returns fold properly', () => {
    const code = [
        'function fetchChain(url: string) {', // 0
        '    return fetch(url)', // 1
        '        .then(res => {', // 2
        '            return res.json().then(data => {', // 3
        '                return validate(data).then(valid => {', // 4
        '                    return format(valid);', // 5
        '                });', // 6
        '            });', // 7
        '        });', // 8
        '}', // 9
    ].join('\n');
    const ranges = computeFoldingRanges(code, TS);
    assert.ok(ranges.some(r => r.start === 0 && r.end === 9));
    assert.ok(ranges.some(r => r.start === 2 && r.end === 8));
    assert.ok(ranges.some(r => r.start === 3 && r.end === 7));
    assert.ok(ranges.some(r => r.start === 4 && r.end === 6));
});

