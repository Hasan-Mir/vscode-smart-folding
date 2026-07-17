import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    collapsedFoldHeaderForHiddenLine,
    collapsedFoldStarts,
    collapsedFolds,
    commentPreviewText,
    computeFoldingRanges,
    foldedStartLines,
    isLikelyFoldClamp,
    revealedGapContainingLine,
    SimpleFoldingRange,
    unfoldPathForLine,
    unfoldRevealedGapLines,
} from '../core/folding';

const WEBSTORM = { singleLineFolds: true, keepFunctionParamsVisible: true };
const VSCODE_LIKE = { singleLineFolds: false, keepFunctionParamsVisible: false };

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

test('keepFunctionParamsVisible=true: multi-line parameter lists are NOT foldable', () => {
    const code = [
        'const Comp = React.memo<Props>((', // 0
        '  props: Props,', // 1
        '  ref,', // 2
        ') => {', // 3
        '  return null;', // 4
        '});', // 5
    ].join('\n');

    const webstorm = computeFoldingRanges(code, WEBSTORM);
    // The params `(` opened on line 0 must NOT create a fold…
    assert.equal(byStart(webstorm, 0), undefined);
    // …but the body `{` on line 3 must (single line, includes `});` line).
    assert.deepEqual(byStart(webstorm, 3), { start: 3, end: 5 });

    // When the option is off, the parameter list IS foldable.
    const permissive = computeFoldingRanges(code, {
        ...WEBSTORM,
        keepFunctionParamsVisible: false,
    });
    assert.ok(byStart(permissive, 0), 'param list should fold when option disabled');
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

test('unbalanced input does not throw and yields sane ranges', () => {
    const code = ['function broken() {', '  if (x) {', '}'].join('\n');
    assert.doesNotThrow(() => computeFoldingRanges(code, WEBSTORM));
});

test('VSCODE_LIKE options combined behave like the defaults of VS Code', () => {
    const code = ['call((', '  a,', ') => {', '  b();', '});'].join('\n');
    const ranges = computeFoldingRanges(code, VSCODE_LIKE);
    // Closing lines are excluded everywhere, and BOTH paren groups fold:
    // the outer `call(` spanning to `);` and the inner parameter list.
    assert.ok(
        ranges.some(r => r.start === 0 && r.end === 3),
        'outer call( ... ) should fold, excluding its closing line'
    );
    assert.ok(
        ranges.some(r => r.start === 0 && r.end === 1),
        'inner parameter list should fold when the option is disabled'
    );
    assert.deepEqual(byStart(ranges, 2), { start: 2, end: 3 });
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

import { lineHiddenByFold } from '../core/folding';

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
        keepFunctionParamsVisible: true,
        foldComments: true,
    });
    assert.deepEqual(ranges[0], { start: 0, end: 2, kind: 'comment' });
});

test('computeFoldingRanges: single-line block comments never fold', () => {
    const text = ['/* one liner */', '/** also one line */', 'const x = 1;'].join('\n');
    const ranges = computeFoldingRanges(text, {
        singleLineFolds: true,
        keepFunctionParamsVisible: true,
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
    assert.deepEqual(collapsedFoldStarts(visible, []), [5]);
});

test('collapsedFoldStarts: a fold reaching EOF is recovered from the ranges', () => {
    const visible = [
        { startLine: 0, endLine: 5 },
        { startLine: 10, endLine: 12 },
    ];
    const ranges: SimpleFoldingRange[] = [{ start: 12, end: 40 }];
    assert.deepEqual(collapsedFoldStarts(visible, ranges), [5, 12]);
});

test('collapsedFoldStarts: the EOF case is not trusted with a single visible range', () => {
    const visible = [{ startLine: 0, endLine: 12 }];
    const ranges: SimpleFoldingRange[] = [{ start: 12, end: 40 }];
    assert.deepEqual(collapsedFoldStarts(visible, ranges), []);
});

// --- line-comment runs ---------------------------------------------------------

test('computeFoldingRanges: consecutive // line comments fold as one comment block', () => {
    const text = ['// one', '// two', '// three', 'const x = 1;'].join('\n');
    const ranges = computeFoldingRanges(text, {
        singleLineFolds: true,
        keepFunctionParamsVisible: true,
        foldComments: true,
    });
    assert.deepEqual(ranges[0], { start: 0, end: 2, kind: 'comment' });
});

test('computeFoldingRanges: a lone // line comment never folds', () => {
    const text = ['// alone', 'const x = 1;', '// another alone', 'const y = 2;'].join('\n');
    const ranges = computeFoldingRanges(text, {
        singleLineFolds: true,
        keepFunctionParamsVisible: true,
        foldComments: true,
    });
    assert.equal(ranges.length, 0);
});

test('computeFoldingRanges: trailing // comments after code are not comment lines', () => {
    const text = ['const a = 1; // one', 'const b = 2; // two', '// three'].join('\n');
    const ranges = computeFoldingRanges(text, {
        singleLineFolds: true,
        keepFunctionParamsVisible: true,
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
        []
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
        [{ start: 30, end: 45 }]
    );
    assert.deepEqual(folds, [
        { header: 10, hiddenEnd: 20 },
        { header: 30, hiddenEnd: 45 },
    ]);
});

test('collapsedFolds: does not trust the EOF heuristic with a single visible range', () => {
    assert.deepEqual(collapsedFolds([{ startLine: 0, endLine: 30 }], [{ start: 30, end: 45 }]), []);
});

test('keepFunctionParamsVisible=false folds the whole signature+body as one region', () => {
    const src = [
        'async function smartUnfold(',
        '    editor: TextEditor,',
        '    fallback: string',
        '): Promise<void> {',
        '    await body();',
        '}',
    ].join('\n');
    const merged = computeFoldingRanges(src, {
        singleLineFolds: true,
        keepFunctionParamsVisible: false,
        foldComments: true,
    });
    // The parameter-list fold swallows the body opening on its `)` line…
    assert.ok(merged.some(r => r.start === 0 && r.end === 5));
    // …while the body block still folds on its own for progressive unfolding.
    assert.ok(merged.some(r => r.start === 3 && r.end === 5));
    // No dangling params-only fold remains.
    assert.ok(!merged.some(r => r.start === 0 && r.end === 3));

    const kept = computeFoldingRanges(src, {
        singleLineFolds: true,
        keepFunctionParamsVisible: true,
        foldComments: true,
    });
    assert.ok(!kept.some(r => r.start === 0));
    assert.ok(kept.some(r => r.start === 3 && r.end === 5));
});
