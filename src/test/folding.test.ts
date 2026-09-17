import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    addedCursorIndex,
    collapsedFoldHeaderForHiddenLine,
    collapsedFolds,
    collapsedFoldStarts,
    commentPreviewText,
    computeFoldBadge,
    computeFoldingRanges,
    foldedStartLines,
    isLikelyFoldClamp,
    lineHiddenByFold,
    revealedGapContainingLine,
    SimpleFoldingRange,
    TAKEOVER_EXCLUDED_LANGUAGES,
    takeoverLanguages,
    unfoldPathForLine,
    unfoldRevealedGapLines,
} from '../core/folding';

const WEBSTORM = { singleLineFolds: true };
const VSCODE_LIKE = { singleLineFolds: false };

function byStart(ranges: SimpleFoldingRange[], start: number): SimpleFoldingRange | undefined {
    return ranges.find(r => r.start === start);
}

const FUNC = [
    'function foo() {', // 0
    '  return 1;', // 1
    '}', // 2
].join('\n');

test('singleLineFolds=true includes the closing-bracket line (WebStorm single-line fold)', () => {
    const ranges = computeFoldingRanges(FUNC, WEBSTORM);
    assert.deepEqual(ranges, [{ start: 0, end: 2 }]);
});

test('singleLineFolds=false leaves the closing bracket on its own line (VS Code default)', () => {
    const ranges = computeFoldingRanges(FUNC, { ...WEBSTORM, singleLineFolds: false });
    assert.deepEqual(ranges, [{ start: 0, end: 1 }]);
});

test('single-line blocks produce no folding range', () => {
    assert.deepEqual(computeFoldingRanges('const x = { a: 1 };', WEBSTORM), []);
});

test('parenthesized signature groups merge with the body (no dangling header)', () => {
    const code = [
        'const Comp = React.memo<Props>((', // 0
        '  props: Props,', // 1
        '  ref,', // 2
        ') => {', // 3
        '  return null;', // 4
        '});', // 5
    ].join('\n');

    const webstorm = computeFoldingRanges(code, WEBSTORM);
    // The inner params `(` closes on `) => {` (a line that opens the body),
    // so its range stretches through the body end — Fold All collapses the
    // whole signature+body instead of leaving a dangling `) => {` line…
    assert.ok(
        webstorm.some(r => r.start === 0 && r.end === 5),
        'signature paren should stretch through the body'
    );
    // T-2: was a byte-identical duplicate of the assertion above — now it
    // actually tests the distinct behavior: the body `{` keeps its own
    // progressive fold (single line, includes the `});` line).
    assert.deepEqual(byStart(webstorm, 3), { start: 3, end: 5 });
    // The OUTER `React.memo(` paren is a call-argument group — it covers the
    // whole call on its own.
    assert.ok(
        webstorm.some(r => r.start === 0 && r.end === 5),
        'call-argument paren group should fold'
    );
});

test('nested blocks each get their own range', () => {
    const code = [
        'class A {', // 0
        '  method() {', // 1
        '    if (x) {', // 2
        '      y();', // 3
        '    }', // 4
        '  }', // 5
        '}', // 6
    ].join('\n');
    const ranges = computeFoldingRanges(code, WEBSTORM);
    assert.deepEqual(ranges, [
        { start: 0, end: 6 },
        { start: 1, end: 5 },
        { start: 2, end: 4 },
    ]);
});

test('brackets inside strings, template literals and comments are ignored', () => {
    const code = [
        "const a = '{';", // 0
        'const b = "}{";', // 1
        'const c = `{ not a block', // 2
        '} still string`;', // 3
        '// { line comment', // 4
        '/* {', // 5
        '} */', // 6
        'function real() {', // 7
        '  return c;', // 8
        '}', // 9
    ].join('\n');
    const ranges = computeFoldingRanges(code, WEBSTORM);
    assert.deepEqual(ranges, [{ start: 7, end: 9 }]);
});

test('escaped quotes inside strings do not terminate the string', () => {
    const code = [
        "const s = 'it\\'s {';", // 0
        'function f() {', // 1
        '  return s;', // 2
        '}', // 3
    ].join('\n');
    assert.deepEqual(computeFoldingRanges(code, WEBSTORM), [{ start: 1, end: 3 }]);
});

test('arrays fold too', () => {
    const code = ['const arr = [', '  1,', '  2,', '];'].join('\n');
    assert.deepEqual(computeFoldingRanges(code, WEBSTORM), [{ start: 0, end: 3 }]);
});

test('unbalanced input does not throw and yields sane ranges (T-4)', () => {
    // T-4: replaces a bare doesNotThrow with a meaningful assertion — the
    // unclosed block simply produces no range at all.
    const code = ['function broken() {', '  if (x) {'].join('\n');
    assert.deepEqual(computeFoldingRanges(code, WEBSTORM), []);
});

test('VSCODE_LIKE options combined behave like the defaults of VS Code', () => {
    const code = ['call((', '  a,', ') => {', '  b();', '});'].join('\n');
    const ranges = computeFoldingRanges(code, VSCODE_LIKE);
    // Verified against tsserver's getOutliningSpans (what VS Code really
    // shows): the arrow function with a multi-line parameter list folds
    // from its `(` through the body as ONE region, the outer call parens
    // cover the same lines, and everything deduplicates to a single range
    // that keeps the closing `});` line visible. There is no separate
    // parameter-list or body range in native mode.
    assert.deepEqual(
        ranges.map(r => ({ start: r.start, end: r.end })),
        [{ start: 0, end: 3 }]
    );
});

test('foldedStartLines: every boundary between visible ranges marks a folded line', () => {
    // Lines 5..9 and 20..24 hidden → folds start at lines 4 and 19.
    const visible = [
        { startLine: 0, endLine: 4 },
        { startLine: 10, endLine: 19 },
        { startLine: 25, endLine: 40 },
    ];
    assert.deepEqual(foldedStartLines(visible), [4, 19]);
});

test('foldedStartLines: no folds when everything is one visible range', () => {
    assert.deepEqual(foldedStartLines([{ startLine: 0, endLine: 100 }]), []);
});

// --- Smart Unfold: unfoldPathForLine ---------------------------------------

const NESTED = [
    'class A {', // 0
    '  method() {', // 1
    '    if (x) {', // 2
    '      y();', // 3
    '    }', // 4
    '  }', // 5
    '}', // 6
    'const top = 1;', // 7
    'function other() {', // 8
    '  z();', // 9
    '}', // 10
].join('\n');

const WS_RANGES = computeFoldingRanges(NESTED, WEBSTORM);

test('unfoldPathForLine: cursor deep inside → full ancestor chain, outermost first', () => {
    // Cursor on `y();` (line 3): unfold class A → method → if, in that order.
    assert.deepEqual(unfoldPathForLine(WS_RANGES, 3), [0, 1, 2]);
});

test('unfoldPathForLine: unrelated blocks are NOT part of the path', () => {
    // `function other()` starts at line 8 and must stay collapsed.
    assert.ok(!unfoldPathForLine(WS_RANGES, 3).includes(8));
});

test('unfoldPathForLine: cursor at an intermediate depth only opens its own chain', () => {
    // Cursor on `}` of method (line 5): inside class A and method, not the if.
    assert.deepEqual(unfoldPathForLine(WS_RANGES, 5), [0, 1]);
});

test("unfoldPathForLine: cursor on a fold's start line includes that fold", () => {
    assert.deepEqual(unfoldPathForLine(WS_RANGES, 0), [0]);
    assert.deepEqual(unfoldPathForLine(WS_RANGES, 2), [0, 1, 2]);
});

test('unfoldPathForLine: cursor on top-level code between blocks → empty path', () => {
    assert.deepEqual(unfoldPathForLine(WS_RANGES, 7), []);
});

test('unfoldPathForLine: cursor in another top-level block only opens that block', () => {
    assert.deepEqual(unfoldPathForLine(WS_RANGES, 9), [8]);
});

test('unfoldPathForLine: duplicate start lines are deduplicated', () => {
    const ranges: SimpleFoldingRange[] = [
        { start: 0, end: 10 },
        { start: 0, end: 4 },
        { start: 2, end: 3 },
    ];
    assert.deepEqual(unfoldPathForLine(ranges, 3), [0, 2]);
});

// --- Ellipsis badge background ----------------------------------------------

import { resolveEllipsisBackground } from '../core/folding';

test('resolveEllipsisBackground: returns the configured color, trimmed', () => {
    assert.equal(resolveEllipsisBackground('#46494e'), '#46494e');
    assert.equal(resolveEllipsisBackground('  #46494e  '), '#46494e');
    assert.equal(resolveEllipsisBackground('rgba(83, 127, 231, 0.35)'), 'rgba(83, 127, 231, 0.35)');
});

test('resolveEllipsisBackground: empty/whitespace/missing → undefined (fall back to theme selection color)', () => {
    assert.equal(resolveEllipsisBackground(''), undefined);
    assert.equal(resolveEllipsisBackground('   '), undefined);
    assert.equal(resolveEllipsisBackground(undefined), undefined);
    assert.equal(resolveEllipsisBackground(null), undefined);
});

// --- Pre-fold cursor tracker: lineHiddenByFold -------------------------------

test('lineHiddenByFold: lines in the gap between visible ranges are fold-hidden', () => {
    // Lines 5..9 are folded away between two visible ranges.
    const visible = [
        { startLine: 0, endLine: 4 },
        { startLine: 10, endLine: 19 },
    ];
    assert.equal(lineHiddenByFold(visible, 5), true);
    assert.equal(lineHiddenByFold(visible, 9), true);
});

test('lineHiddenByFold: the fold header and following visible line are NOT hidden', () => {
    const visible = [
        { startLine: 0, endLine: 4 },
        { startLine: 10, endLine: 19 },
    ];
    assert.equal(lineHiddenByFold(visible, 4), false);
    assert.equal(lineHiddenByFold(visible, 10), false);
});

test('lineHiddenByFold: lines outside the viewport are NOT considered fold-hidden', () => {
    const visible = [{ startLine: 0, endLine: 50 }];
    assert.equal(lineHiddenByFold(visible, 100), false);
    assert.equal(lineHiddenByFold(visible, 25), false);
});

test('lineHiddenByFold: multiple folds — every gap counts', () => {
    const visible = [
        { startLine: 0, endLine: 2 },
        { startLine: 8, endLine: 12 },
        { startLine: 30, endLine: 40 },
    ];
    assert.equal(lineHiddenByFold(visible, 5), true);
    assert.equal(lineHiddenByFold(visible, 20), true);
    assert.equal(lineHiddenByFold(visible, 35), false);
});

test('isLikelyFoldClamp: detects finally-block cursor clamped to function header', () => {
    const code = [
        'const probe = async (): Promise<boolean> => {', // 0
        '  try {', // 1
        '    return true;', // 2
        '  } finally {', // 3 (cursor was here)
        '    cleanup();', // 4
        '  }', // 5
        '};', // 6
    ].join('\n');
    const ranges = computeFoldingRanges(code, WEBSTORM);
    assert.equal(isLikelyFoldClamp(ranges, 3, 0), true);
});

test('isLikelyFoldClamp: rejects ordinary upward cursor movement', () => {
    assert.equal(isLikelyFoldClamp(WS_RANGES, 9, 7), false);
    assert.equal(isLikelyFoldClamp(WS_RANGES, 3, 3), false);
});

test('isLikelyFoldClamp alone is not proof of a fold clamp: Go to Definition to a header must not arm state', () => {
    const ranges = computeFoldingRanges(FUNC, WEBSTORM);
    // isLikelyFoldClamp is structural only — the extension also requires the
    // previous line to be fold-hidden (or the range to reach EOF), so a plain
    // programmatic jump to a range header never arms saved fold state.
    assert.equal(isLikelyFoldClamp(ranges, 1, 0), true);
    assert.equal(lineHiddenByFold([{ startLine: 0, endLine: 2 }], 1), false);
});

// --- Unified provider model: native-equivalent + Smart in one result --------

test('unified model: native-only mapped-type fold and Smart function fold coexist', () => {
    const code = [
        'export type EntityPatch<T> = {', // 0
        '    [K in keyof T]?: T[K];', // 1
        '};', // 2
        'function foo() {', // 3
        '    return 1;', // 4
        '}', // 5
    ].join('\n');
    const smart = computeFoldingRanges(code, { ...WEBSTORM, languageId: 'typescript' });
    assert.ok(smart.some(r => r.start === 0 && r.end === 2), 'native-equivalent type fold survives');
    assert.ok(smart.some(r => r.start === 3 && r.end === 5), 'Smart single-line function fold survives');
});

test('unified model: same-start paren/body conflict resolves to exactly one range (smart end)', () => {
    const code = [
        'export function make(', // 0
        '    name: string', // 1
        ')', // 2
        '{', // 3
        '    return name;', // 4
        '}', // 5
    ].join('\n');
    const smart = computeFoldingRanges(code, {
        singleLineFolds: true,
        foldComments: true,
        languageId: 'typescript',
    });
    const sameStart = smart.filter(r => r.start === 0 && r.kind === undefined);
    assert.equal(sameStart.length, 1);
    assert.equal(sameStart[0].end, 5);
    const nativeStyle = computeFoldingRanges(code, {
        singleLineFolds: false,
        foldComments: true,
        languageId: 'typescript',
    });
    assert.ok(
        nativeStyle.some(r => r.start === 0 && r.end === 4),
        'VS Code-style model keeps the closing brace visible'
    );
});

test('unified model: overlapping ranges keep every nested fold', () => {
    const code = [
        'function outer() {', // 0
        '    if (true) {', // 1
        '        work();', // 2
        '    }', // 3
        '}', // 4
    ].join('\n');
    const smart = computeFoldingRanges(code, WEBSTORM);
    assert.ok(smart.some(r => r.start === 0 && r.end === 4), 'outer fold survives');
    assert.ok(smart.some(r => r.start === 1 && r.end === 3), 'nested fold survives');
});

test('unified model: excluded languages stay native-only (no Smart provider ranges forced)', () => {
    assert.ok(TAKEOVER_EXCLUDED_LANGUAGES.has('cpp'));
    assert.deepEqual(takeoverLanguages(['cpp', 'typescript']), ['typescript']);
});

test('unfoldRevealedGapLines: Unfold All reveals previously fold-hidden lines in place', () => {
    const prev = [
        { startLine: 0, endLine: 10 },
        { startLine: 40, endLine: 45 },
        { startLine: 80, endLine: 90 },
    ];
    const next = [{ startLine: 0, endLine: 60 }];
    assert.equal(unfoldRevealedGapLines(prev, next), true);
});

test('unfoldRevealedGapLines: plain scrolling is NOT detected as an unfold', () => {
    const prev = [
        { startLine: 0, endLine: 10 },
        { startLine: 40, endLine: 45 },
    ];
    // Scrolled far down - the old gap lines (11-39) are not rendered in place.
    const next = [{ startLine: 100, endLine: 160 }];
    assert.equal(unfoldRevealedGapLines(prev, next), false);
});

test('unfoldRevealedGapLines: no previous gaps means no unfold detection', () => {
    assert.equal(
        unfoldRevealedGapLines([{ startLine: 0, endLine: 50 }], [{ startLine: 0, endLine: 50 }]),
        false
    );
});

// --- revealedGapContainingLine ---------------------------------------------

test('revealedGapContainingLine: unfolding the block that hid the line is detected', () => {
    // Folded: visible 0-3, gap 4-9 (contains line 7), visible 10-12.
    const prev = [
        { startLine: 0, endLine: 3 },
        { startLine: 10, endLine: 12 },
    ];
    // One level opened: lines 4-6 became visible, 7-9 still folded deeper.
    const next = [
        { startLine: 0, endLine: 6 },
        { startLine: 10, endLine: 12 },
    ];
    assert.equal(revealedGapContainingLine(prev, next, 7), true);
});

test('revealedGapContainingLine: unfolding an UNRELATED block is ignored', () => {
    // Two gaps: 4-9 (contains line 7) and 13-19. Only the second one opens.
    const prev = [
        { startLine: 0, endLine: 3 },
        { startLine: 10, endLine: 12 },
        { startLine: 20, endLine: 25 },
    ];
    const next = [
        { startLine: 0, endLine: 3 },
        { startLine: 10, endLine: 18 },
        { startLine: 20, endLine: 25 },
    ];
    assert.equal(revealedGapContainingLine(prev, next, 7), false);
});

test('revealedGapContainingLine: line outside every gap → false', () => {
    const prev = [
        { startLine: 0, endLine: 3 },
        { startLine: 10, endLine: 12 },
    ];
    const next = [{ startLine: 0, endLine: 12 }];
    assert.equal(revealedGapContainingLine(prev, next, 2), false);
});

// --- comment folding ---------------------------------------------------------

test('computeFoldingRanges: multi-line JSDoc folds as a comment range', () => {
    const text = ['/**', ' * Docs here.', ' */', 'function a() {', '    return 1;', '}'].join('\n');
    const ranges = computeFoldingRanges(text, {
        singleLineFolds: true,
        foldComments: true,
    });
    assert.deepEqual(ranges[0], { start: 0, end: 2, kind: 'comment' });
});

test('computeFoldingRanges: single-line block comments never fold', () => {
    const text = ['/* one liner */', '/** also one line */', 'const x = 1;'].join('\n');
    const ranges = computeFoldingRanges(text, {
        singleLineFolds: true,
        foldComments: true,
    });
    assert.equal(ranges.length, 0);
});

test('computeFoldingRanges: no comment ranges when foldComments is off', () => {
    const text = ['/**', ' * Docs.', ' */'].join('\n');
    const ranges = computeFoldingRanges(text, WEBSTORM);
    assert.equal(ranges.length, 0);
});

// --- comment previews --------------------------------------------------------

test('commentPreviewText: first meaningful line with markers stripped', () => {
    assert.equal(commentPreviewText(['/**', ' * Hello world.', ' */'], 60), 'Hello world.');
});

test('commentPreviewText: long lines are truncated with an ellipsis', () => {
    const preview = commentPreviewText(['/**', ` * ${'a'.repeat(100)}`, ' */'], 10);
    assert.equal(preview.length, 10);
    assert.ok(preview.endsWith('…'));
});

test('commentPreviewText: contentless comments fall back to dots', () => {
    assert.equal(commentPreviewText(['/**', ' *', ' */'], 60), '···');
});

// --- collapsed fold detection ------------------------------------------------

test('collapsedFoldStarts: a gap between visible ranges is a collapsed fold', () => {
    const visible = [
        { startLine: 0, endLine: 5 },
        { startLine: 10, endLine: 20 },
    ];
    assert.deepEqual(collapsedFoldStarts(visible, [], 100), [5]);
});

test('collapsedFoldStarts: a fold reaching EOF is recovered from the ranges', () => {
    const visible = [
        { startLine: 0, endLine: 5 },
        { startLine: 10, endLine: 12 },
    ];
    const ranges: SimpleFoldingRange[] = [{ start: 12, end: 40 }];
    assert.deepEqual(collapsedFoldStarts(visible, ranges, 41), [5, 12]);
});

test('collapsedFoldStarts: the EOF case is trusted with a single visible range at EOF', () => {
    const visible = [{ startLine: 0, endLine: 12 }];
    const ranges: SimpleFoldingRange[] = [{ start: 12, end: 40 }];
    assert.deepEqual(collapsedFoldStarts(visible, ranges, 41), [12]);
});

// E-7: the EOF/bottom-edge heuristic must require the range to REACH EOF.
test('collapsedFoldStarts: an open block at the viewport bottom is NOT a fold (E-7)', () => {
    // Two visible ranges (folding active) and a range starting on the last
    // visible line — but it does NOT reach EOF: the old heuristic fabricated
    // a phantom collapsed fold here.
    const visible = [
        { startLine: 0, endLine: 5 },
        { startLine: 10, endLine: 12 },
    ];
    const ranges: SimpleFoldingRange[] = [{ start: 12, end: 40 }];
    assert.deepEqual(collapsedFoldStarts(visible, ranges, 100), [5]);
});

// --- line-comment runs ---------------------------------------------------------

test('computeFoldingRanges: consecutive // line comments fold as one comment block', () => {
    const text = ['// one', '// two', '// three', 'const x = 1;'].join('\n');
    const ranges = computeFoldingRanges(text, {
        singleLineFolds: true,
        foldComments: true,
    });
    assert.deepEqual(ranges[0], { start: 0, end: 2, kind: 'comment' });
});

test('computeFoldingRanges: a lone // line comment never folds', () => {
    const text = ['// alone', 'const x = 1;', '// another alone', 'const y = 2;'].join('\n');
    const ranges = computeFoldingRanges(text, {
        singleLineFolds: true,
        foldComments: true,
    });
    assert.equal(ranges.length, 0);
});

test('computeFoldingRanges: trailing // comments after code are not comment lines', () => {
    const text = ['const a = 1; // one', 'const b = 2; // two', '// three'].join('\n');
    const ranges = computeFoldingRanges(text, {
        singleLineFolds: true,
        foldComments: true,
    });
    assert.equal(ranges.length, 0);
});

test('commentPreviewText: strips // markers and reads the first line', () => {
    assert.equal(commentPreviewText(['// Fallback only', '// more text'], 60), 'Fallback only');
});

test('commentPreviewText: includes the header line own text', () => {
    assert.equal(
        commentPreviewText(['/* Fallback only — details', ' * rest */'], 60),
        'Fallback only — details'
    );
});

// --- clicks mapped into hidden fold content ---------------------------------

test('collapsedFoldHeaderForHiddenLine: resolves a hidden line to its collapsed header', () => {
    const ranges: SimpleFoldingRange[] = [
        { start: 2, end: 10 },
        { start: 4, end: 6 },
    ];
    assert.equal(collapsedFoldHeaderForHiddenLine([2], ranges, 7), 2);
});

test('collapsedFoldHeaderForHiddenLine: prefers the outermost collapsed fold', () => {
    const ranges: SimpleFoldingRange[] = [
        { start: 2, end: 10 },
        { start: 4, end: 6 },
    ];
    assert.equal(collapsedFoldHeaderForHiddenLine([2, 4], ranges, 5), 2);
});

test('collapsedFoldHeaderForHiddenLine: ignores open folds and header lines themselves', () => {
    const ranges: SimpleFoldingRange[] = [{ start: 2, end: 10 }];
    assert.equal(collapsedFoldHeaderForHiddenLine([], ranges, 5), undefined);
    assert.equal(collapsedFoldHeaderForHiddenLine([2], ranges, 2), undefined);
});

// --- ground-truth collapsed folds from visible-range gaps --------------------

test('collapsedFolds: derives header and hidden end from visible-range gaps', () => {
    const folds = collapsedFolds(
        [
            { startLine: 0, endLine: 10 },
            { startLine: 21, endLine: 40 },
            { startLine: 51, endLine: 60 },
        ],
        [],
        100
    );
    assert.deepEqual(folds, [
        { header: 10, hiddenEnd: 20 },
        { header: 40, hiddenEnd: 50 },
    ]);
});

test('collapsedFolds: recovers a fold reaching EOF from the ranges list', () => {
    const folds = collapsedFolds(
        [
            { startLine: 0, endLine: 10 },
            { startLine: 21, endLine: 30 },
        ],
        [{ start: 30, end: 45 }],
        46
    );
    assert.deepEqual(folds, [
        { header: 10, hiddenEnd: 20 },
        { header: 30, hiddenEnd: 45 },
    ]);
});

test('collapsedFolds: trusts the EOF heuristic with a single visible range at EOF', () => {
    assert.deepEqual(
        collapsedFolds([{ startLine: 0, endLine: 30 }], [{ start: 30, end: 45 }], 46),
        [{ header: 30, hiddenEnd: 45 }]
    );
});

// E-7: EOF recovery requires the range to actually reach EOF.
test('collapsedFolds: a range NOT reaching EOF is not recovered (E-7)', () => {
    const folds = collapsedFolds(
        [
            { startLine: 0, endLine: 10 },
            { startLine: 21, endLine: 30 },
        ],
        [{ start: 30, end: 45 }],
        100
    );
    assert.deepEqual(folds, [{ header: 10, hiddenEnd: 20 }]);
});

test('collapsedFolds: fold to the last brace is recovered with a single visible range', () => {
    const folds = collapsedFolds([{ startLine: 0, endLine: 0 }], [{ start: 0, end: 4 }], 6);
    assert.deepEqual(folds, [{ header: 0, hiddenEnd: 4 }]);
});

test('collapsedFolds: fold ending just before trailing empty lines is recovered', () => {
    const folds = collapsedFolds([{ startLine: 0, endLine: 0 }], [{ start: 0, end: 4 }], 6);
    assert.deepEqual(folds, [{ header: 0, hiddenEnd: 4 }]);
});

test('collapsedFoldStarts: single visible range at an EOF fold header is reported', () => {
    assert.deepEqual(collapsedFoldStarts([{ startLine: 0, endLine: 0 }], [{ start: 0, end: 4 }], 6), [
        0,
    ]);
});

test('computeFoldBadge: multiline function declaration ending with ( renders {...} badge', () => {
    const badge = computeFoldBadge({
        lineText: 'export function processCommand<TData>(',
        kind: undefined,
        previewText: '',
        commentPreviewEnabled: true,
        singleLineFolding: true,
        hideOpeningBracket: true,
        closingLineText: '}',
    });
    assert.equal(badge.contentText, '{...}');
    assert.equal(badge.hiddenStart, undefined);
});

test('collapsedFolds: EOF fold with a trailing newline still produces its badge range', () => {
    const folds = collapsedFolds(
        [
            { startLine: 0, endLine: 0 },
            { startLine: 5, endLine: 5 },
        ],
        [{ start: 0, end: 4 }],
        6
    );
    assert.deepEqual(folds, [{ header: 0, hiddenEnd: 4 }]);
});

// --- E-8: addedCursorIndex ----------------------------------------------------

test('addedCursorIndex: returns the index of the newly added cursor', () => {
    const prev = [
        { line: 3, character: 5 },
        { line: 9, character: 0 },
    ];
    const next = [
        { line: 3, character: 5 },
        { line: 9, character: 0 },
        { line: 20, character: 2 },
    ];
    assert.equal(addedCursorIndex(prev, next), 2);
});

test('addedCursorIndex: -1 only when every cursor pre-existed', () => {
    const prev = [{ line: 3, character: 5 }];
    assert.equal(addedCursorIndex(prev, [{ line: 3, character: 5 }]), -1);
    assert.equal(addedCursorIndex([], []), -1);
    // With 2+ selections, the cursor at a brand-new position is the added one
    // (a modifier click adds a cursor rather than moving an existing one).
    assert.equal(
        addedCursorIndex(
            [{ line: 9, character: 0 }],
            [
                { line: 9, character: 0 },
                { line: 3, character: 5 },
            ]
        ),
        1
    );
});

// --- Copying collapsed blocks -------------------------------------------------

import { extendCopyRange } from '../core/folding';

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

// --- Signature fold tests ------------------------------------------------------

test('async function signature parens merge with the body (no dangling header)', () => {
    const code = [
        'async function fetch(', // 0
        '  url: string,', // 1
        '  opts: RequestInit', // 2
        '): Promise<Response> {', // 3
        '  return fetch(url, opts);', // 4
        '}', // 5
    ].join('\n');
    const webstorm = computeFoldingRanges(code, WEBSTORM);
    // The signature paren group stretches through the body end — Fold All
    // collapses the whole signature+body instead of leaving a dangling
    // `): Promise<Response> {` line.
    assert.ok(
        webstorm.some(r => r.start === 0 && r.end === 5),
        'async signature paren should stretch through the body'
    );
    // The body `{` keeps its own progressive fold.
    assert.deepEqual(byStart(webstorm, 3), { start: 3, end: 5 });
});

test('a multi-line function folds to one line under Fold All', () => {
    const code = [
        'function compute(', // 0
        '  a: number,', // 1
        '  b: number,', // 2
        '  c: number', // 3
        '): number {', // 4
        '  return a + b + c;', // 5
        '}', // 6
    ].join('\n');
    const webstorm = computeFoldingRanges(code, WEBSTORM);
    // The signature paren merges with the body — one fold covers lines 0-6.
    assert.ok(
        webstorm.some(r => r.start === 0 && r.end === 6),
        'multi-line function signature should merge through the body'
    );
});

test('singleLineFolds never swallows a closing line that continues the statement', () => {
    const code = [
        'const result = compute(', // 0
        '  1,', // 1
        '  2,', // 2
        '  3', // 3
        '); doSomething();', // 4 — the closing line continues with a statement
    ].join('\n');
    const webstorm = computeFoldingRanges(code, WEBSTORM);
    assert.ok(
        webstorm.some(r => r.start === 0 && r.end === 3),
        'the fold must stop before the closing line'
    );
    assert.ok(
        !webstorm.some(r => r.end === 4 && r.start < 4),
        'closing line that continues the statement must not be swallowed'
    );
});
