import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    commentPreviewText,
    computeFoldBadge,
    computeFoldingRanges,
    extendCopyRange,
    languageSyntax,
    resolveEllipsisColor,
} from '../core/folding';

// --- T-3: resolveEllipsisColor ------------------------------------------------

test('resolveEllipsisColor: returns the configured color, trimmed', () => {
    assert.equal(resolveEllipsisColor('#9a9da5'), '#9a9da5');
    assert.equal(resolveEllipsisColor('  #9a9da5  '), '#9a9da5');
    assert.equal(resolveEllipsisColor('rgb(154, 157, 165)'), 'rgb(154, 157, 165)');
});

test('resolveEllipsisColor: empty/whitespace/missing → undefined (fall back to editor.foreground)', () => {
    assert.equal(resolveEllipsisColor(''), undefined);
    assert.equal(resolveEllipsisColor('   '), undefined);
    assert.equal(resolveEllipsisColor(undefined), undefined);
    assert.equal(resolveEllipsisColor(null), undefined);
});

// --- T-3: commentPreviewText bounds --------------------------------------------

test('commentPreviewText: empty input falls back to dots', () => {
    assert.equal(commentPreviewText([], 60), '···');
});

test('commentPreviewText: all-empty lines fall back to dots', () => {
    assert.equal(commentPreviewText(['', '   ', ' * '], 60), '···');
});

test('commentPreviewText: non-positive maxLength falls back to dots (pinned)', () => {
    assert.equal(commentPreviewText(['/**', ' * Hello.', ' */'], 0), '···');
    assert.equal(commentPreviewText(['/**', ' * Hello.', ' */'], -5), '···');
});

test('commentPreviewText: fractional maxLength truncates deterministically', () => {
    const preview = commentPreviewText(['/**', ` * ${'a'.repeat(100)}`, ' */'], 10.5);
    assert.ok(preview.endsWith('…'));
    assert.ok(preview.length <= 11);
});

// --- T-3: unknown language IDs --------------------------------------------------

test('unknown language IDs get generic bracket scanning only', () => {
    const code = ['function f() {', '    body();', '}'].join('\n');
    assert.deepEqual(computeFoldingRanges(code, { singleLineFolds: true, languageId: 'cobol' }), [
        { start: 0, end: 2 },
    ]);
    const syntax = languageSyntax('cobol');
    assert.equal(syntax.regexLiterals, false);
    assert.equal(syntax.jsx, false);
    assert.equal(syntax.importPattern, undefined);
});

test('undefined language ID scans generically', () => {
    const code = ['function f() {', '    body();', '}'].join('\n');
    assert.deepEqual(computeFoldingRanges(code, { singleLineFolds: true }), [{ start: 0, end: 2 }]);
});

// --- T-3: unclosed constructs at EOF ---------------------------------------------

test('unclosed region at EOF produces no region range', () => {
    const code = ['// #region never closed', 'const a = 1;'].join('\n');
    assert.deepEqual(
        computeFoldingRanges(code, { singleLineFolds: true, languageId: 'typescript' }).filter(
            r => r.kind === 'region'
        ),
        []
    );
});

test('unterminated block comment at EOF still folds', () => {
    const code = ['/* start', 'more'].join('\n');
    assert.deepEqual(computeFoldingRanges(code, { singleLineFolds: true, foldComments: true }), [
        { start: 0, end: 1, kind: 'comment' },
    ]);
});

test('unterminated string does not swallow the next line', () => {
    const code = ["const s = 'abc", 'function f() {', '    body();', '}'].join('\n');
    assert.deepEqual(computeFoldingRanges(code, { singleLineFolds: true }), [{ start: 1, end: 3 }]);
});

// --- T-3: CRLF documents -----------------------------------------------------------

test('CRLF documents fold identically to LF', () => {
    const lf = ['function f() {', '    if (x) {', '        y();', '    }', '}'].join('\n');
    const crlf = ['function f() {', '    if (x) {', '        y();', '    }', '}'].join('\r\n');
    const expected = [
        { start: 0, end: 4 },
        { start: 1, end: 3 },
    ];
    assert.deepEqual(computeFoldingRanges(lf, { singleLineFolds: true }), expected);
    assert.deepEqual(computeFoldingRanges(crlf, { singleLineFolds: true }), expected);
});

// --- T-3: extendCopyRange edge cases -------------------------------------------------

test('extendCopyRange: a selection ending on a hidden NON-header line is not widened', () => {
    const folds = [{ header: 2, hiddenEnd: 5 }];
    const ext = extendCopyRange(
        { startLine: 0, startCharacter: 0, endLine: 4, endCharacter: 3 },
        folds,
        () => 20
    );
    assert.equal(ext, undefined);
});

test('extendCopyRange: an end beyond the line length still widens', () => {
    const ext = extendCopyRange(
        { startLine: 2, startCharacter: 0, endLine: 2, endCharacter: 99 },
        [{ header: 2, hiddenEnd: 5 }],
        () => 20
    );
    assert.deepEqual(ext, {
        startLine: 2,
        startCharacter: 0,
        endLine: 5,
        endCharacter: 20,
        isLineCopy: false,
    });
});

// --- T-5: computeFoldBadge (extracted badge decision logic) ----------------------------

test('computeFoldBadge: code block renders `{...}` and hides the bracket', () => {
    const badge = computeFoldBadge({
        lineText: 'function foo() {',
        kind: undefined,
        previewText: '',
        commentPreviewEnabled: true,
        singleLineFolding: true,
        hideOpeningBracket: true,
    });
    assert.equal(badge.contentText, '{...}');
    assert.equal(badge.hiddenStart, 15);
});
test('computeFoldBadge: array renders `[...]` and extracts an `as const` suffix', () => {
    const badge = computeFoldBadge({
        lineText: 'const values = [',
        kind: undefined,
        previewText: '',
        commentPreviewEnabled: true,
        singleLineFolding: true,
        hideOpeningBracket: true,
        closingLineText: '] as const);',
    });
    // Pinned original behavior: everything after the closer up to any comment
    // becomes the suffix, `;` and `)` included.
    assert.equal(badge.contentText, '[...] as const);');
    assert.equal(badge.hiddenStart, 15);
});

test('computeFoldBadge: `//` inside a string is not treated as a comment', () => {
    const badge = computeFoldBadge({
        lineText: 'const value = [',
        kind: undefined,
        previewText: '',
        commentPreviewEnabled: true,
        singleLineFolding: true,
        hideOpeningBracket: true,
        closingLineText: "]; log('http://x'); // done",
    });
    // The URL's `//` must not truncate the suffix; the REAL trailing comment
    // is masked off and never reaches the badge.
    assert.equal(badge.contentText, "[...]; log('http://x');");
    assert.ok(!badge.contentText.includes('done'));
});

test('computeFoldBadge: a trailing line comment on the closing line is never a suffix', () => {
    const badge = computeFoldBadge({
        lineText: 'call(',
        kind: undefined,
        previewText: '',
        commentPreviewEnabled: true,
        singleLineFolding: true,
        hideOpeningBracket: true,
        closingLineText: '); // [note]',
    });
    // Pinned: the `;` after the closer is part of the suffix; the comment
    // content is not.
    assert.equal(badge.contentText, '(...);');
    assert.ok(!badge.contentText.includes('note'));
});

test('computeFoldBadge: bare `/**` header keeps the last marker char', () => {
    const badge = computeFoldBadge({
        lineText: '/**',
        kind: 'comment',
        previewText: 'Docs',
        commentPreviewEnabled: true,
        singleLineFolding: true,
        hideOpeningBracket: true,
    });
    assert.equal(badge.contentText, '* Docs */');
    assert.equal(badge.hiddenStart, 2);
    assert.equal(badge.visibleMarkerEnd, 2);
    // Combined visual: the visible marker `/*` + the badge = `/** Docs */`.
    assert.equal('/**'.slice(0, badge.visibleMarkerEnd!) + badge.contentText, '/** Docs */');
});

test('computeFoldBadge: paren prefix joins when an empty call wraps the bracket', () => {
    const badge = computeFoldBadge({
        lineText: 'foo({',
        kind: undefined,
        previewText: '',
        commentPreviewEnabled: true,
        singleLineFolding: true,
        hideOpeningBracket: true,
        closingLineText: '});',
    });
    assert.equal(badge.contentText, '({...});');
    assert.equal(badge.hiddenStart, 3);
    assert.equal(badge.noMargin, true);
});

test('computeFoldBadge: plain badge when singleLineFolding is off', () => {
    const badge = computeFoldBadge({
        lineText: 'function foo() {',
        kind: undefined,
        previewText: '',
        commentPreviewEnabled: true,
        singleLineFolding: false,
        hideOpeningBracket: true,
    });
    assert.equal(badge.contentText, ' ··· ');
    assert.equal(badge.hiddenStart, undefined);
});

test('computeFoldBadge: plain badge when hideOpeningBracket is off', () => {
    const badge = computeFoldBadge({
        lineText: 'function foo() {',
        kind: undefined,
        previewText: '',
        commentPreviewEnabled: true,
        singleLineFolding: true,
        hideOpeningBracket: false,
    });
    assert.equal(badge.contentText, ' ··· ');
});

test('computeFoldBadge: hides opening bracket on header with trailing comment', () => {
    const badge = computeFoldBadge({
        lineText: 'function foo() { // main logic',
        kind: undefined,
        previewText: '',
        commentPreviewEnabled: true,
        singleLineFolding: true,
        hideOpeningBracket: true,
    });
    assert.equal(badge.contentText, '{...}');
    assert.equal(badge.hiddenStart, 15);
});

test('computeFoldBadge: import run ending with brace produces plain ellipsis badge', () => {
    const badge = computeFoldBadge({
        lineText: 'import {',
        kind: 'imports',
        previewText: '',
        commentPreviewEnabled: true,
        singleLineFolding: true,
        hideOpeningBracket: true,
        closingLineText: "} from 'mod';",
    });
    assert.equal(badge.contentText, ' ··· ');
    assert.equal(badge.hiddenStart, undefined);
});

test('computeFoldBadge: region fold ending with brace produces plain ellipsis badge', () => {
    const badge = computeFoldBadge({
        lineText: '// #region {',
        kind: 'region',
        previewText: '',
        commentPreviewEnabled: true,
        singleLineFolding: true,
        hideOpeningBracket: true,
    });
    assert.equal(badge.contentText, ' ··· ');
    assert.equal(badge.hiddenStart, undefined);
});


