/**
 * Pure folding-range computation (unit tested).
 *
 * A lightweight bracket scanner for C-like languages that understands line
 * comments, block comments, single/double/backtick strings AND (for the
 * JS/TS family) regular-expression literals, so brackets inside those are
 * ignored. (Template-literal `${…}` interpolation is treated as part of the
 * string — good enough in practice for folding.)
 *
 * Besides brackets it produces the same extra folding regions VS Code's own
 * built-in providers produce, so replacing the built-in provider does not
 * lose folds:
 *   - `#region` / `#endregion` marker regions (`// #region`, `#region`,
 *     `#pragma region` — per language)
 *   - runs of consecutive import/using/include statements
 *   - multi-line template literals
 *   - `case …:` / `default:` clauses inside `switch` blocks
 *   - block comments / JSDoc and runs of `//` line comments
 *
 * Malformed-input recovery policy (F-1): a stray closing bracket that finds
 * no matching opener ABOVE the nearest interpolation/JSX sentinel boundary
 * is IGNORED — the bracket stack, all enclosing folds and all pending
 * `case …:` clauses are left untouched. Only frames genuinely consumed by a
 * matched closer are removed.
 */

export interface FoldingOptions {
    /**
     * WebStorm behavior: the folding range INCLUDES the closing-bracket line,
     * so a collapsed block renders as a single line. When false the closing
     * bracket keeps its own line (VS Code default).
     */
    singleLineFolds: boolean;
    /**
     * Fold multi-line block comments / JSDoc and runs of consecutive
     * whole-line `//` comments (collapsing them down to their first line).
     * A single-line comment never produces a range, so it can never be
     * collapsed.
     */
    foldComments?: boolean;
    /**
     * VS Code language ID (e.g. "typescript"). Enables language-specific
     * syntax: regex literals, template-literal folds, region-marker
     * dialects, import-run folding and case-clause folding. When omitted,
     * only the generic bracket/comment scanning runs.
     */
    languageId?: string;
}

export interface SimpleFoldingRange {
    /** Zero-based first line (stays visible; the fold starts after it). */
    start: number;
    /** Zero-based last folded line. */
    end: number;
    /**
     * Set for block-comment/JSDoc folds (rendered with a text preview),
     * `#region` marker folds and import-run folds.
     */
    kind?: 'comment' | 'region' | 'imports';
}

interface OpenBracket {
    char: string;
    line: number;
    /** `(` opened directly after if/while/for/with/catch/switch (F-4/F-5). */
    control?: 'switch' | 'condition';
    /** `{` that is the body of a `switch` statement — case clauses fold inside. */
    switchBody?: boolean;
    /**
     * Statement line a control-statement body folds from (F-12): tsserver
     * starts multiline-header spans at the keyword line, not the `{` line.
     */
    headerLine?: number;
}

/** Characters VS Code keeps visible on a fold's closing line (`>` is NOT one). */
const FOLD_END_PAIRS = '}])`';

/**
 * Control-statement keywords whose `(...)` group is a CONDITION (F-5): after
 * its closing `)` a `/` may start a regex literal (statement position).
 */
const CONTROL_CONDITION_KEYWORDS = new Set(['if', 'while', 'for', 'with', 'catch']);

/**
 * A closing line must NOT be swallowed into a single-line fold if that line
 * continues with significant code: opening another block (`}) => {`,
 * `} else {`), opening another bracket group (`], [`), continuing an arrow
 * (`) => props.id;`), or carrying a real statement (`]; doSomething();`,
 * `]; const other = 'http://x';`, `); return result;`, `} else cleanup;`).
 * Trailing-only lines (`];`, `] as const;`, `} from 'a';`) MAY be swallowed so
 * the badge can show the suffix.
 *
 * F-6: implemented as a small LEXICAL scan (strings/comments masked), not
 * regex stripping — `//` inside `'http://x'` is not a comment, `/* … *\/`
 * inside a string is not a comment either, and the scan stops correctly at
 * a CRLF `\r\n` (LF and CRLF behave identically).
 */
function canSwallowClosingLine(text: string, indexAfterBracket: number): boolean {
    const newline = text.indexOf('\n', indexAfterBracket);
    const raw = text.slice(indexAfterBracket, newline === -1 ? text.length : newline);
    let cleaned = '';
    let quote: string | undefined;
    let inBlockComment = false;
    let i = 0;
    while (i < raw.length) {
        const ch = raw[i];
        const nx = raw[i + 1];
        if (quote !== undefined) {
            if (ch === '\\') {
                i += 2;
                continue;
            }
            if (ch === quote) quote = undefined;
            i++;
            continue;
        }
        if (inBlockComment) {
            if (ch === '*' && nx === '/') {
                inBlockComment = false;
                i += 2;
                continue;
            }
            i++;
            continue;
        }
        if (ch === '/' && nx === '/') break; // rest of the line is a comment
        if (ch === '/' && nx === '*') {
            inBlockComment = true;
            i += 2;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            quote = ch;
            i++;
            continue;
        }
        cleaned += ch;
        i++;
    }
    cleaned = cleaned.trim();
    if (cleaned.length === 0) return true; // whitespace / trailing comments only
    if (cleaned.endsWith('{')) return false;
    if (cleaned.includes('=>')) return false;
    if (/[{[(]/.test(cleaned)) return false;
    // An assignment or other real statement must stay visible.
    if (cleaned.includes('=')) return false;
    // A `;` followed by more code means a SECOND statement shares the closing
    // line (`); return result;`, `]; throw err;`) — swallowing the line would
    // hide that statement inside the fold. A trailing `;` is harmless
    // (`];`, `] as const;`, `} from 'a';`).
    if (/;(?!\s*$)/.test(cleaned)) return false;
    // A statement-continuation keyword means real code follows the closer
    // (`} else cleanup;`). Strings/comments were masked off above, so these
    // can only be real tokens.
    if (/\b(else|return|throw|break|continue|yield)\b/.test(cleaned)) return false;
    return true;
}

/**
 * F-C: true when `slice` contains nothing but whitespace and comments (block
 * comments may span lines). Used for the gap between a closed control-statement
 * condition and its `{`: `switch (v) // comment` + `{` is still a switch body,
 * so its `case …:` clauses must fold.
 */
function isWsOrCommentsOnly(slice: string): boolean {
    let i = 0;
    while (i < slice.length) {
        const ch = slice[i];
        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
            i++;
            continue;
        }
        if (ch === '/' && slice[i + 1] === '/') {
            while (i < slice.length && slice[i] !== '\n') i++;
            continue;
        }
        if (ch === '/' && slice[i + 1] === '*') {
            const end = slice.indexOf('*/', i + 2);
            if (end === -1) return false; // unterminated comment — not a gap
            i = end + 2;
            continue;
        }
        return false;
    }
    return true;
}

/**
 * F-7: text of a line with any trailing comment lexically removed
 * (string-aware, so `//` / `/* … *\/` inside strings are not mistaken for
 * comments). Character indices are preserved 1:1 (masking, not deletion).
 */
function codeBeforeTrailingComment(lineText: string): string {
    let masked = '';
    let quote: string | undefined;
    let i = 0;
    while (i < lineText.length) {
        const ch = lineText[i];
        if (quote !== undefined) {
            masked += ' ';
            if (ch === '\\') {
                masked += ' ';
                i += 2;
                continue;
            }
            if (ch === quote) quote = undefined;
            i++;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            quote = ch;
            masked += ' ';
            i++;
            continue;
        }
        if (ch === '/' && lineText[i + 1] === '/') {
            masked += ' '.repeat(lineText.length - i);
            break;
        }
        if (ch === '/' && lineText[i + 1] === '*') {
            // A block comment masks `/* … */` — and, when it is not closed on
            // this line, the REST OF THE LINE too: the comment continues on the
            // next line, so `) => { /* note` must still read as `) => {`.
            const close = lineText.indexOf('*/', i + 2);
            const end = close === -1 ? lineText.length : close + 2;
            masked += ' '.repeat(end - i);
            i = end;
            continue;
        }
        masked += ch;
        i++;
    }
    return masked.trimEnd();
}

/**
 * F-12 (Allman / brace-on-next-line): tsserver starts a statement block's
 * fold at the STATEMENT header line (the `function f()` / `if (x)` / `try`
 * line), not the bare `{` line — walk back over blank lines AND comment-only
 * lines to find it. A comment between the header and an Allman brace is not
 * part of the block, so the fold must still start at the header
 * (`function f()` + `// docs` + `{` folds from the `function` line).
 * Returns undefined when the previous code line ends a statement or opens a
 * continuation (`=`, `,`, `:`, `(`, `[`, `;`, `{`, `}`) — then the brace
 * genuinely opens there (object literal, destructuring, call argument) — or
 * when it ends with `)`, which is a call/condition tail: the `{` below it is a
 * standalone block that tsserver folds from its own line (a control statement
 * body is resolved through `headerLine` instead, so nothing is lost).
 * Verified against fixtures/parity/allman.ts and allman-blocks.ts.
 */
function allmanHeaderLine(
    lines: string[],
    braceLine: number,
    multilineParenCloseLines: ReadonlySet<number>
): number | undefined {
    let k = braceLine - 1;
    let inBlockComment = false;
    while (k >= 0) {
        const line = lines[k] ?? '';
        const text = line.trim();
        if (text.length === 0) {
            k--;
            continue;
        }
        if (inBlockComment) {
            // Walking UP through a multi-line block comment — stop at the line
            // that opened it, then keep looking for the real header.
            if (line.includes('/*')) {
                inBlockComment = false;
                if (codeBeforeTrailingComment(line).trim().length > 0) {
                    break;
                }
            }
            k--;
            continue;
        }
        if (text.startsWith('//')) {
            k--;
            continue;
        }
        // Handle block comments: skip comment-only lines, but stop if the line contains code
        if (text.endsWith('*/')) {
            if (line.lastIndexOf('/*') === -1) {
                inBlockComment = true;
                k--;
                continue;
            }
            // Standalone /* ... */ on its own line: skip it
            if (codeBeforeTrailingComment(line).trim().length === 0) {
                k--;
                continue;
            }
            // Line has code before /* ... */ (e.g. `function f() /* docs */`): stop walk-back
            break;
        }
        break;
    }
    if (k < 0 || k >= braceLine) return undefined;
    // F-7/F-D: a trailing comment must not mask the line's real terminator
    // (`const x = 1; // init` still ends a statement, so the block below it
    // does NOT fold from that line).
    const prev = codeBeforeTrailingComment(lines[k] ?? '').trimEnd();
    if (prev.length === 0) return undefined;
    // A `)` that closes a MULTI-LINE paren group (`foo(` … `)` on this line) is
    // a continuation tail: the `{` below it is a standalone block that
    // tsserver folds from its own line. A same-line `)` (`function f()`,
    // `if (x)`, `try`-less headers) is a complete statement header, so the
    // walk-back below still applies. Control statements resolve through
    // `headerLine` regardless.
    if (prev.endsWith(')') && multilineParenCloseLines.has(k)) {
        return undefined;
    }
    if (/[;{}=,:]$/.test(prev) || prev.endsWith('(') || prev.endsWith('[')) {
        return undefined;
    }
    return k;
}

/** One JSX element/fragment currently being scanned. */
interface JsxFrame {
    /** Line of the element's opening `<` — the element fold's start. */
    openLine: number;
    /** Root of a JSX island entered from code — closing it resumes code mode. */
    returnsToCode: boolean;
    /** The opening tag's `>` was consumed — we are among its children. */
    inChildren: boolean;
    /** Whitespace after the tag name was seen — attributes may follow. */
    tagNameDone: boolean;
    /** A `{…}` attribute/child expression was consumed (disables backtracking). */
    sawExpr: boolean;
    firstAttrLine?: number;
    lastAttrLine?: number;
    lastAttrEndCh?: string;
}

const OPEN = '{([';
const CLOSE = '})]';

/** Language-specific syntax matched line-wise / during the scan. */
interface LanguageSyntax {
    /** `/regex/` literals exist (JS/TS family) — skip their contents. */
    regexLiterals: boolean;
    /** Multi-line backtick template literals produce a folding range. */
    templateLiteralFolds: boolean;
    /** `case …:` / `default:` clauses inside `switch` blocks fold. */
    caseClauses: boolean;
    /** First token of an import/using/include line. */
    importPattern?: RegExp;
    /** Region marker patterns (start/end), checked on whole lines. */
    regionStart: RegExp[];
    regionEnd: RegExp[];
    /** A line whose first code character is `#` is a comment (PHP). */
    hashLineComment: boolean;
    /**
     * A line whose first code character is `#` is a preprocessor directive /
     * compiler directive (C, C++, C#) — never scan it for brackets
     * (`#define PAIR {1, 2}` must not corrupt bracket matching).
     */
    hashDirectives: boolean;
    /** JSX elements (`<div>…</div>`) fold — JS + react dialects, not plain TS. */
    jsx: boolean;
}

const JS_FAMILY = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact']);

// `// #region` / `//#region` / `// region` (JetBrains style is `//region`).
const LINE_COMMENT_REGION_START = /^\s*\/\/\s*#?region\b/;
const LINE_COMMENT_REGION_END = /^\s*\/\/\s*#?endregion\b/;

export function languageSyntax(languageId: string | undefined): LanguageSyntax {
    const js = languageId !== undefined && JS_FAMILY.has(languageId);
    const syntax: LanguageSyntax = {
        regexLiterals: js,
        templateLiteralFolds: js,
        caseClauses: false,
        importPattern: undefined,
        regionStart: [],
        regionEnd: [],
        hashLineComment: false,
        hashDirectives: false,
        jsx: false,
    };
    switch (languageId) {
        case 'javascript':
        case 'javascriptreact':
        case 'typescript':
        case 'typescriptreact':
            syntax.caseClauses = true;
            // tsserver parses JSX everywhere except plain .ts files, where
            // `<T>` is a type assertion / generic — match that exactly.
            syntax.jsx = languageId !== 'typescript';
            // `import x from 'm'` / `import {x} from 'm'` / `import type …` —
            // but NOT a dynamic import call or `import.meta` (neither is a
            // static declaration, so tsserver folds no run for them).
            syntax.importPattern = /^\s*import\b(?!\s*[.(])/;
            syntax.regionStart = [LINE_COMMENT_REGION_START];
            syntax.regionEnd = [LINE_COMMENT_REGION_END];
            break;
        case 'java':
            syntax.caseClauses = true;
            syntax.importPattern = /^\s*import\b/;
            syntax.regionStart = [LINE_COMMENT_REGION_START];
            syntax.regionEnd = [LINE_COMMENT_REGION_END];
            break;
        case 'c':
        case 'cpp':
            syntax.caseClauses = true;
            syntax.importPattern = /^\s*#\s*include\b/;
            syntax.regionStart = [/^\s*#\s*pragma\s+region\b/, LINE_COMMENT_REGION_START];
            syntax.regionEnd = [/^\s*#\s*pragma\s+endregion\b/, LINE_COMMENT_REGION_END];
            syntax.hashDirectives = true;
            break;
        case 'csharp':
            syntax.caseClauses = true;
            // `using System;` / `global using X = Y;` — but NOT `using (…)`
            // statements and NOT `using var x = …` local declarations (F-11).
            syntax.importPattern = /^\s*(global\s+)?using\s+(static\s+)?(?!var\b)[A-Za-z_]/;
            syntax.regionStart = [/^\s*#\s*region\b/, LINE_COMMENT_REGION_START];
            syntax.regionEnd = [/^\s*#\s*endregion\b/, LINE_COMMENT_REGION_END];
            syntax.hashDirectives = true;
            break;
        case 'go':
            syntax.caseClauses = true;
            syntax.importPattern = /^\s*import\b/;
            syntax.regionStart = [LINE_COMMENT_REGION_START];
            syntax.regionEnd = [LINE_COMMENT_REGION_END];
            break;
        case 'rust':
            syntax.importPattern = /^\s*(pub\s+)?use\b/;
            syntax.regionStart = [LINE_COMMENT_REGION_START];
            syntax.regionEnd = [LINE_COMMENT_REGION_END];
            break;
        case 'php':
            syntax.caseClauses = true;
            syntax.importPattern = /^\s*use\b/;
            syntax.regionStart = [/^\s*#\s*region\b/, LINE_COMMENT_REGION_START];
            syntax.regionEnd = [/^\s*#\s*endregion\b/, LINE_COMMENT_REGION_END];
            syntax.hashLineComment = true;
            break;
        case 'json':
        case 'jsonc':
            syntax.regionStart = [LINE_COMMENT_REGION_START];
            syntax.regionEnd = [LINE_COMMENT_REGION_END];
            break;
        default:
            break;
    }
    return syntax;
}

/**
 * Languages whose language-specific multiline literals (C++ raw strings,
 * C# verbatim/interpolated strings, Java text blocks, PHP heredoc) the
 * scanner cannot safely model yet (F-13). Smart Folding stays available for
 * them, but it must NOT take over as `defaultFoldingRangeProvider` — native
 * folding remains active. Remove a language from this set only once its
 * literal forms are implemented and tested.
 */
export const TAKEOVER_EXCLUDED_LANGUAGES: ReadonlySet<string> = new Set([
    'c',
    'cpp',
    'csharp',
    'java',
    'php',
]);

/** Language IDs safe for Smart Folding takeover (F-13 filter). */
export function takeoverLanguages(languages: readonly string[]): string[] {
    return languages.filter(l => !TAKEOVER_EXCLUDED_LANGUAGES.has(l));
}

/**
 * Can a `/` at the current position start a REGEX LITERAL (instead of being
 * a division operator)? Decided from the previous significant code
 * character/word — the standard tokenizer heuristic: a regex may follow an
 * operator, an opening bracket, a separator, or a keyword like `return`.
 */
const REGEX_PRECEDING_CHARS = '([{,;=:!&|?+-*%~^<>';
const REGEX_PRECEDING_KEYWORDS = new Set([
    'return',
    'typeof',
    'instanceof',
    'in',
    'of',
    'new',
    'delete',
    'void',
    'do',
    'else',
    'yield',
    'await',
    'throw',
    'case',
]);

function regexCanFollow(lastCode: string | undefined, lastWord: string): boolean {
    if (lastCode === undefined) return true; // start of file / statement
    if (lastWord.length > 0) return REGEX_PRECEDING_KEYWORDS.has(lastWord);
    return REGEX_PRECEDING_CHARS.includes(lastCode);
}

// `case 1:` / `case(1):` / `case 'x':` / `case"x":` / `default:` / `default :`
// (`case(` is intentional — `case (expression):` is valid JavaScript).
const CASE_CLAUSE = /^\s*(case[\s("']|default\s*:)/;

export function computeFoldingRanges(text: string, opts: FoldingOptions): SimpleFoldingRange[] {
    const syntax = languageSyntax(opts.languageId);
    const lines = text.split('\n');
    const ranges: SimpleFoldingRange[] = [];
    const stack: OpenBracket[] = [];
    const lineCommentLines: number[] = [];
    const parenRanges: Array<{ range: SimpleFoldingRange; closeLine: number }> = [];
    /** Raw closing line of the LAST bracket opened on a given line (import grouping). */
    const bracketCloseByStartLine = new Map<number, number>();
    /** Lines whose first token is an import/using/include statement. */
    const importLines: number[] = [];
    /** Statement end line of a braceless multiline import, keyed by its start line (F-8). */
    const importEndByLine = new Map<number, number>();
    /** Import line currently awaiting its terminating `;` (F-8). */
    let pendingImportLine: number | undefined;
    /** Last line carrying code for that pending import (its extent, F-8). */
    let pendingImportLastLine = 0;
    let pendingImportDepth = 0;
    const regionStack: number[] = [];
    /** Open `case …:` clause per enclosing `{`. */
    const pendingCases: Array<{ line: number; open: OpenBracket }> = [];
    /** Lines that are `// #region` / `// #endregion` markers (F-9). */
    const regionMarkerLines = new Set<number>();
    /** F-4: control-statement condition that just closed (`if (x)`, `switch (v)`, …). */
    let pendingControlClose:
        | { control: 'switch' | 'condition'; line: number; closeIndex: number }
        | undefined;

    let line = 0;
    let lineStart = 0;
    let lineChecked = false; // line-wise checks ran for the current line
    let inLineComment = false;
    let inBlockComment = false;
    let blockCommentStartLine = 0;
    let stringQuote: string | undefined;
    let stringStartLine = 0;
    // Previous significant CODE character/word (for regex-vs-division).
    let lastCode: string | undefined;
    let lastWord = '';
    // ---- JSX state ---------------------------------------------------------
    const jsxElements: JsxFrame[] = [];
    let jsxMode: 'tag' | 'text' | undefined;
    /** Open quote of a JSX attribute string (no escapes, may span lines). */
    let jsxAttrQuote: string | undefined;
    /** Snapshot for backtracking a false-positive JSX entry (`<T,>` hack). */
    let jsxEntry: { i: number; line: number; lineStart: number; lineChecked: boolean } | undefined;

    const closeCase = (pendingIndex: number, endLine: number): void => {
        const pending = pendingCases[pendingIndex];
        pendingCases.splice(pendingIndex, 1);
        let end = endLine;
        while (end > pending.line && (lines[end] ?? '').trim().length === 0) end--;
        // Native VS Code keeps a closing pair character's line visible: a
        // clause whose last statement is a block (`case 1: { … }`) folds to
        // the line BEFORE the `}` (tsserver's foldEndPairCharacters rule).
        // With single-line folds on, the closing line is swallowed instead.
        if (!opts.singleLineFolds && end > pending.line) {
            const tail = (lines[end] ?? '').trimEnd();
            if (/[}\])`]$/.test(tail)) end--;
        }
        if (end > pending.line) ranges.push({ start: pending.line, end });
    };

    // Multi-line JSX attribute lists fold exactly like tsserver's
    // spanForJSXAttributes: first attribute line .. last attribute line
    // (minus one when the last attribute ends with a close-pair character).
    const closeJsxTag = (frame: JsxFrame): void => {
        if (frame.firstAttrLine === undefined || frame.lastAttrLine === undefined) return;
        let end = frame.lastAttrLine;
        if (!opts.singleLineFolds && FOLD_END_PAIRS.includes(frame.lastAttrEndCh ?? '')) end--;
        if (end > frame.firstAttrLine) ranges.push({ start: frame.firstAttrLine, end });
    };

    const exitJsxElement = (frame: JsxFrame): void => {
        if (frame.returnsToCode) {
            // The island's root element closed — back to ordinary code.
            jsxMode = undefined;
            jsxEntry = undefined;
            lastCode = '>';
            lastWord = '';
        } else {
            jsxMode = 'text'; // back among the parent element's children
        }
    };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];

        if (ch === '\n') {
            line++;
            lineStart = i + 1;
            lineChecked = false;
            inLineComment = false;
            // Unterminated ' / " strings do not span lines (backtick does).
            if (stringQuote === "'" || stringQuote === '"') stringQuote = undefined;
            continue;
        }

        if (inLineComment) continue;

        if (inBlockComment) {
            if (ch === '*' && next === '/') {
                inBlockComment = false;
                i++;
                // Multi-line block comments / JSDoc fold down to their first
                // line (WebStorm style). A comment that starts and ends on the
                // SAME line produces no range, so single-line comments can
                // never be collapsed.
                if (opts.foldComments && line > blockCommentStartLine) {
                    ranges.push({ start: blockCommentStartLine, end: line, kind: 'comment' });
                }
            }
            continue;
        }

        if (stringQuote) {
            if (ch === '\\') {
                i++; // skip the escaped character
                // F-2: an escaped line continuation MUST run the normal line
                // bookkeeping — otherwise every subsequent fold is
                // misattributed by one line, forever.
                if (text[i] === '\n') {
                    line++;
                    lineStart = i + 1;
                    lineChecked = false;
                } else if (text[i] === '\r' && text[i + 1] === '\n') {
                    i++;
                    line++;
                    lineStart = i + 1;
                    lineChecked = false;
                }
            } else if (
                stringQuote === '`' &&
                syntax.templateLiteralFolds &&
                ch === '$' &&
                next === '{'
            ) {
                // `${…}` interpolation: the code inside folds like any other
                // code (VS Code's built-in provider folds multi-line calls and
                // object literals inside interpolations). The sentinel keeps
                // the enclosing template's start line so scanning resumes in
                // template mode at the matching `}` — including for nested
                // templates.
                stack.push({ char: '${', line: stringStartLine });
                stringQuote = undefined;
                lastCode = '{';
                lastWord = '';
                i++;
            } else if (ch === stringQuote) {
                // Multi-line template literals fold like VS Code's built-in
                // JS/TS provider: the closing-backtick line stays visible
                // (native behavior) unless single-line folds are on.
                if (stringQuote === '`' && syntax.templateLiteralFolds && line > stringStartLine) {
                    const end = opts.singleLineFolds ? line : line - 1;
                    if (end > stringStartLine) ranges.push({ start: stringStartLine, end });
                }
                stringQuote = undefined;
                lastCode = ch; // a string end behaves like a value
                lastWord = '';
            }
            continue;
        }

        // -------- JSX context (opening tags, children text) ----------------

        if (jsxMode === 'tag') {
            // Inside `<name attr=…>` — line-wise checks (imports, regions,
            // case clauses) never apply to JSX tag lines.
            lineChecked = true;
            const frame = jsxElements[jsxElements.length - 1]!;
            if (jsxAttrQuote !== undefined) {
                if (ch === jsxAttrQuote) jsxAttrQuote = undefined;
                frame.lastAttrLine = line;
                frame.lastAttrEndCh = ch;
                continue;
            }
            if (ch === '"' || ch === "'") {
                jsxAttrQuote = ch;
                if (frame.tagNameDone && frame.firstAttrLine === undefined) {
                    frame.firstAttrLine = line;
                }
                frame.lastAttrLine = line;
                frame.lastAttrEndCh = ch;
                continue;
            }
            if (ch === '{') {
                // `attr={…}` / `{...spread}`: the braces scan as ordinary code
                // (nested JSX included); a sentinel resumes tag mode at the
                // matching `}`.
                frame.sawExpr = true;
                if (frame.tagNameDone && frame.firstAttrLine === undefined) {
                    frame.firstAttrLine = line;
                }
                stack.push({ char: '{jsxTag', line });
                jsxMode = undefined;
                lastCode = '{';
                lastWord = '';
                continue;
            }
            if (ch === '/' && next === '>') {
                // Self-closing element: only its attributes fold (native
                // tsserver emits no element span for JsxSelfClosingElement).
                closeJsxTag(frame);
                jsxElements.pop();
                exitJsxElement(frame);
                i++;
                continue;
            }
            if (ch === '>') {
                closeJsxTag(frame);
                frame.inChildren = true;
                jsxMode = 'text';
                continue;
            }
            if (ch === ' ' || ch === '\t' || ch === '\r') {
                frame.tagNameDone = true;
                continue;
            }
            if (
                jsxEntry !== undefined &&
                jsxElements.length === 1 &&
                !frame.sawExpr &&
                (ch === ',' || ch === '(' || ch === ')' || ch === ';')
            ) {
                // A character that cannot occur in a JSX opening tag: this `<`
                // was NOT JSX after all (e.g. the `<T,>` generic-arrow comma
                // hack). Rewind and rescan it as a comparison operator.
                i = jsxEntry.i;
                line = jsxEntry.line;
                lineStart = jsxEntry.lineStart;
                lineChecked = jsxEntry.lineChecked;
                jsxEntry = undefined;
                jsxElements.length = 0;
                jsxMode = undefined;
                jsxAttrQuote = undefined;
                lastCode = '<';
                lastWord = '';
                continue;
            }
            if (frame.tagNameDone) {
                if (frame.firstAttrLine === undefined) frame.firstAttrLine = line;
                frame.lastAttrLine = line;
                frame.lastAttrEndCh = ch;
            }
            continue;
        }

        if (jsxMode === 'text') {
            // Among an element's children: everything is plain text except
            // `{…}` expressions and `<…>` tags — apostrophes, quotes and
            // stray braces-in-text can never corrupt bracket matching.
            lineChecked = true;
            if (ch === '{') {
                stack.push({ char: '{jsxText', line });
                jsxMode = undefined;
                lastCode = '{';
                lastWord = '';
                continue;
            }
            if (ch === '<' && next === '/') {
                // Closing tag: find its `>` (it may span lines). Native VS
                // Code INCLUDES the closing-tag line in the element fold
                // (`>` is not a fold-end pair character).
                let j = i + 2;
                while (j < text.length && text[j] !== '>') {
                    if (text[j] === '\n') {
                        line++;
                        lineStart = j + 1;
                    }
                    j++;
                }
                i = j;
                const frame = jsxElements.pop();
                if (frame === undefined) {
                    jsxMode = undefined;
                    continue;
                }
                if (line > frame.openLine) ranges.push({ start: frame.openLine, end: line });
                exitJsxElement(frame);
                continue;
            }
            if (ch === '<' && next === '>') {
                // Child fragment `<>…</>`.
                jsxElements.push({
                    openLine: line,
                    returnsToCode: false,
                    inChildren: true,
                    tagNameDone: true,
                    sawExpr: true,
                });
                i++;
                continue;
            }
            if (ch === '<' && next !== undefined && /[A-Za-z_$]/.test(next)) {
                jsxElements.push({
                    openLine: line,
                    returnsToCode: false,
                    inChildren: false,
                    tagNameDone: false,
                    sawExpr: false,
                });
                jsxMode = 'tag';
                continue;
            }
            continue;
        }

        // -------- code context ------------------------------------------

        // Line-wise checks, once per line, at its first non-whitespace code
        // character: region markers, import runs, case clauses, `#` lines.
        if (!lineChecked && ch !== ' ' && ch !== '\t' && ch !== '\r') {
            lineChecked = true;
            const lineText = lines[line] ?? '';
            const isRegionLine =
                syntax.regionStart.some(p => p.test(lineText)) ||
                syntax.regionEnd.some(p => p.test(lineText));
            if (isRegionLine) regionMarkerLines.add(line);
            if (syntax.regionStart.some(p => p.test(lineText))) {
                regionStack.push(line);
            } else if (syntax.regionEnd.some(p => p.test(lineText))) {
                const start = regionStack.pop();
                if (start !== undefined && line > start) {
                    ranges.push({ start, end: line, kind: 'region' });
                }
            } else if (syntax.importPattern?.test(lineText)) {
                // F-8: a braceless import that was never terminated by `;`
                // (ASI) ends just above this line — record where it ended so
                // the run below keeps its real extent.
                if (pendingImportLine !== undefined && !importEndByLine.has(pendingImportLine)) {
                    importEndByLine.set(pendingImportLine, pendingImportLastLine);
                }
                importLines.push(line);
                pendingImportLine = line;
                pendingImportLastLine = line;
                pendingImportDepth = stack.length;
            } else if (pendingImportLine !== undefined && /[A-Za-z_$]/.test(ch)) {
                // A non-import code line starting with an identifier ends a
                // pending braceless multiline import by ASI (continuation
                // lines start with a quote, bracket or punctuation — a bare
                // string cannot span lines).
                if (stack.length <= pendingImportDepth) {
                    if (!importEndByLine.has(pendingImportLine)) {
                        importEndByLine.set(pendingImportLine, pendingImportLastLine);
                    }
                    pendingImportLine = undefined;
                }
            }
            // Every further line carrying code extends a pending import's
            // extent (its continuation lines, e.g. the module specifier).
            if (pendingImportLine !== undefined && line > pendingImportLastLine) {
                pendingImportLastLine = line;
            }
            if (syntax.caseClauses && CASE_CLAUSE.test(lineText) && !isRegionLine) {
                // F-4: only inside the body of a real `switch` statement
                // (tracked semantically on the stack) — object literals with
                // `switch:` / `default:` properties and multiline/Allman
                // switch headers are handled correctly in both directions.
                const top = stack[stack.length - 1];
                if (top && top.char === '{' && top.switchBody) {
                    const previous = pendingCases.findIndex(p => p.open === top);
                    if (previous !== -1) closeCase(previous, line - 1);
                    pendingCases.push({ line, open: top });
                }
            }
            if (ch === '#' && next !== '[' && (syntax.hashLineComment || syntax.hashDirectives)) {
                // PHP `#` comment / C-family `#directive`: never scan the rest
                // of the line for brackets or strings. `#[` is NOT excluded —
                // PHP 8 attributes are code (F-10).
                inLineComment = true;
                continue;
            }
        }

        if (ch === '/' && next === '/') {
            inLineComment = true;
            // A line whose first non-whitespace text is `//` is a whole-line
            // comment; consecutive ones fold as one block (WebStorm style).
            // F-9: `// #region` / `// #endregion` marker lines stay region
            // boundaries and never join an ordinary comment run.
            if (opts.foldComments && !regionMarkerLines.has(line)) {
                if (/^\s*$/.test(text.slice(lineStart, i))) {
                    lineCommentLines.push(line);
                }
            }
            i++;
            continue;
        }
        // R1: PHP hash comments may also start MID-LINE — the line-start case
        // in the line-wise block above only covers a line's FIRST code
        // character. Everything after a mid-line `#` (except a `#[` attribute)
        // is a comment, so `$x = 1; # }` must not close the enclosing fold and
        // `# {` must not open a phantom frame. C-family mid-line `#` is not a
        // comment (`hashDirectives`), so this stays PHP-only.
        if (ch === '#' && syntax.hashLineComment && next !== '[') {
            inLineComment = true;
            continue;
        }
        if (ch === '/' && next === '*') {
            inBlockComment = true;
            blockCommentStartLine = line;
            i++;
            continue;
        }
        // Regex literal (JS/TS family): skip its contents so brackets and
        // quote characters inside (e.g. `/[{"']/`) cannot corrupt bracket
        // matching — a classic source of wrong folds for the rest of a file.
        if (ch === '/' && syntax.regexLiterals && regexCanFollow(lastCode, lastWord)) {
            let j = i + 1;
            let inClass = false;
            let closed = false;
            while (j < text.length && text[j] !== '\n') {
                const rc = text[j];
                if (rc === '\\') {
                    j++;
                } else if (inClass) {
                    if (rc === ']') inClass = false;
                } else if (rc === '[') {
                    inClass = true;
                } else if (rc === '/') {
                    closed = true;
                    break;
                }
                j++;
            }
            if (closed) {
                i = j; // skip the whole literal (flags are harmless identifiers)
                lastCode = '/';
                lastWord = '';
                continue;
            }
            // No closing `/` on this line → it was a division after all;
            // fall through and treat it as an ordinary operator.
        }
        // JSX entry: a `<` in EXPRESSION position (same contexts where a
        // regex literal could start) followed by a tag name or `>` opens a
        // JSX element/fragment. `Array<T>`, `a < b`, `1 << 2` never match —
        // they follow an identifier/number or a second `<`. Generic arrows
        // are excluded by lookahead: `<T extends …>`, `<T = string>` and the
        // TS 4.7 variance annotations `<in T>` / `<out T>` (F-3). The
        // `<T,>` comma hack backtracks from tag mode.
        if (
            ch === '<' &&
            syntax.jsx &&
            next !== undefined &&
            (next === '>' || /[A-Za-z_$]/.test(next)) &&
            regexCanFollow(lastCode, lastWord)
        ) {
            let isJsx = true;
            if (next !== '>') {
                let j = i + 1;
                let ident = '';
                while (j < text.length && /[A-Za-z0-9_$]/.test(text[j])) {
                    ident += text[j];
                    j++;
                }
                while (j < text.length && /\s/.test(text[j])) j++;
                const rest = text.slice(j);
                if (
                    /^extends\b/.test(rest) ||
                    rest.startsWith('=') ||
                    ident === 'in' ||
                    ident === 'out'
                ) {
                    isJsx = false;
                }
            }
            if (isJsx) {
                jsxEntry = { i, line, lineStart, lineChecked };
                if (next === '>') {
                    jsxElements.push({
                        openLine: line,
                        returnsToCode: true,
                        inChildren: true,
                        tagNameDone: true,
                        sawExpr: true,
                    });
                    jsxMode = 'text';
                    i++;
                } else {
                    jsxElements.push({
                        openLine: line,
                        returnsToCode: true,
                        inChildren: false,
                        tagNameDone: false,
                        sawExpr: false,
                    });
                    jsxMode = 'tag';
                }
                continue;
            }
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            stringQuote = ch;
            stringStartLine = line;
            continue;
        }

        // F-8: the terminating `;` ends a pending (possibly multiline,
        // braceless) import statement.
        if (ch === ';') {
            if (pendingImportLine !== undefined) {
                if (!importEndByLine.has(pendingImportLine)) {
                    importEndByLine.set(pendingImportLine, line);
                }
                pendingImportLine = undefined;
            }
            lastCode = ch;
            lastWord = '';
            continue;
        }

        if (OPEN.includes(ch)) {
            const frame: OpenBracket = { char: ch, line };
            if (ch === '(') {
                // F-4/F-5: mark condition groups of control statements.
                if (lastWord === 'switch') frame.control = 'switch';
                else if (CONTROL_CONDITION_KEYWORDS.has(lastWord)) frame.control = 'condition';
            } else if (ch === '{') {
                const pc = pendingControlClose;
                if (
                    pc !== undefined &&
                    isWsOrCommentsOnly(text.slice(pc.closeIndex + 1, i))
                ) {
                    // The brace directly follows a closed control-statement
                    // condition (possibly on the next line — Allman), ignoring
                    // comments in between (`switch (v) // note` + `{`): it is
                    // the statement body. A `{` deeper inside the condition
                    // (`for (const {a} of x)`) has non-whitespace text in
                    // between and is correctly NOT marked. The old
                    // top-of-stack check never fired for same-line
                    // `switch (v) {` because the paren is already popped.
                    frame.switchBody = pc.control === 'switch';
                    frame.headerLine = pc.line;
                    pendingControlClose = undefined;
                }
                // F-12 Allman: `{` as the line's first token folds from the
                // statement header line (verified against tsserver).
                if (/^[ \t]*$/.test(text.slice(lineStart, i))) {
                    const multilineParenCloseLines = new Set(parenRanges.map(p => p.closeLine));
                    const header = allmanHeaderLine(lines, line, multilineParenCloseLines);
                    if (header !== undefined) {
                        frame.line = header;
                    }
                }
            }
            stack.push(frame);
            lastCode = ch;
            lastWord = '';
            continue;
        }

        // A `}` matching an interpolation sentinel resumes template mode.
        if (ch === '}' && stack[stack.length - 1]?.char === '${') {
            const sentinel = stack.pop()!;
            stringQuote = '`';
            stringStartLine = sentinel.line;
            lastCode = undefined;
            lastWord = '';
            continue;
        }

        // A `}` matching a JSX sentinel closes the JSX expression — which
        // folds exactly like tsserver's JsxExpression span — and resumes
        // JSX scanning (tag or children mode).
        if (
            ch === '}' &&
            (stack[stack.length - 1]?.char === '{jsxText' ||
                stack[stack.length - 1]?.char === '{jsxTag')
        ) {
            const sentinel = stack.pop()!;
            const end = opts.singleLineFolds ? line : line - 1;
            if (end > sentinel.line) ranges.push({ start: sentinel.line, end });
            if (sentinel.char === '{jsxTag') {
                jsxMode = 'tag';
                const frame = jsxElements[jsxElements.length - 1];
                if (frame !== undefined) {
                    frame.lastAttrLine = line;
                    frame.lastAttrEndCh = '}';
                }
            } else {
                jsxMode = 'text';
            }
            lastCode = undefined;
            lastWord = '';
            continue;
        }

        const closeIndex = CLOSE.indexOf(ch);
        if (closeIndex !== -1) {
            const expectedOpen = OPEN[closeIndex];
            // F-1: find the matching opener WITHOUT popping. A stray closer
            // must not destroy unrelated openers: entries are only discarded
            // once a match is confirmed, and interpolation/JSX sentinels are
            // hard boundaries (never match across them).
            let openIndex = -1;
            for (let k = stack.length - 1; k >= 0; k--) {
                const candidate = stack[k];
                if (
                    candidate.char === '${' ||
                    candidate.char === '{jsxText' ||
                    candidate.char === '{jsxTag'
                ) {
                    break;
                }
                if (candidate.char === expectedOpen) {
                    openIndex = k;
                    break;
                }
            }
            if (openIndex === -1) {
                // Stray closer — documented recovery policy: ignore it, keep
                // every open frame and every pending case clause.
                lastCode = ch;
                lastWord = '';
                continue;
            }
            const open = stack[openIndex];
            // Discard the frames the match consumes; any `case …:` clauses
            // attached to discarded `{` frames end just above the closing
            // line. Side effects apply ONLY to actually-matched frames.
            for (let k = stack.length - 1; k >= openIndex; k--) {
                const candidate = stack[k];
                if (candidate.char === '{') {
                    for (let p = pendingCases.length - 1; p >= 0; p--) {
                        if (pendingCases[p].open === candidate) closeCase(p, line - 1);
                    }
                }
            }
            stack.length = openIndex;
            lastCode = ch;
            lastWord = '';
            if (open.control) {
                // F-5: a control-statement condition ended (`if (ok)` …).
                // The next `/` is in statement position and may start a
                // regex literal, so drop the `)` context (which would make
                // it a division). Ordinary `(...) / y` stays division.
                lastCode = undefined;
                // F-4: remember the closed condition so a `{` that directly
                // follows it (same line, or Allman next line) is recognized
                // as the statement body.
                pendingControlClose = { control: open.control, line: open.line, closeIndex: i };
            }
            if (line <= open.line) {
                continue;
            }

            const startLine = open.headerLine ?? open.line;
            bracketCloseByStartLine.set(
                startLine,
                Math.max(bracketCloseByStartLine.get(startLine) ?? 0, line)
            );

            const canSwallow = opts.singleLineFolds && canSwallowClosingLine(text, i + 1);
            const end = canSwallow ? line : line - 1;
            // Control-statement conditions (`switch (\n v\n)`, `catch (\n e\n)`)
            // never produce their own fold: tsserver emits no span for them,
            // and the body's fold starts at the keyword line via headerLine.
            if (end > startLine && !(ch === ')' && open.control !== undefined)) {
                const range: SimpleFoldingRange = { start: startLine, end };
                ranges.push(range);
                if (ch === ')') {
                    parenRanges.push({ range, closeLine: line });
                }
            }
            continue;
        }

        // Track the previous significant code character/word for the
        // regex-vs-division decision. F-5: postfix `++`/`--` end an
        // expression — a following `/` is division, never a regex opener.
        if (ch !== ' ' && ch !== '\t' && ch !== '\r') {
            if (/[A-Za-z0-9_$]/.test(ch)) {
                lastWord = /[A-Za-z0-9_$]/.test(lastCode ?? '') ? lastWord + ch : ch;
                lastCode = ch;
            } else {
                lastWord = '';
                if ((ch === '+' && lastCode === '+') || (ch === '-' && lastCode === '-')) {
                    lastCode = ')'; // postfix ++/-- behaves like a value
                } else {
                    lastCode = ch;
                }
            }
        }
    }

    // An unterminated block comment running to EOF still folds.
    if (inBlockComment && opts.foldComments && line > blockCommentStartLine) {
        ranges.push({ start: blockCommentStartLine, end: line, kind: 'comment' });
    }
    // Unterminated template literal running to EOF still folds.
    if (stringQuote === '`' && syntax.templateLiteralFolds && line > stringStartLine) {
        ranges.push({ start: stringStartLine, end: line });
    }
    // Case clauses still open at EOF close at the last line.
    while (pendingCases.length > 0) closeCase(pendingCases.length - 1, line);

    // A braceless import still pending at EOF (no terminating `;` — ASI) ends
    // at its last code line (F-8).
    if (pendingImportLine !== undefined && !importEndByLine.has(pendingImportLine)) {
        importEndByLine.set(pendingImportLine, pendingImportLastLine);
    }

    // Runs of consecutive whole-line `//` comments fold as one comment block
    // (collapsing to their first line). A lone `//` line produces no range.
    for (let idx = 0; idx < lineCommentLines.length; ) {
        let j = idx;
        while (
            j + 1 < lineCommentLines.length &&
            lineCommentLines[j + 1] === lineCommentLines[j] + 1
        ) {
            j++;
        }
        if (j > idx) {
            ranges.push({
                start: lineCommentLines[idx],
                end: lineCommentLines[j],
                kind: 'comment',
            });
        }
        idx = j + 1;
    }

    // Runs of 2+ import/using/include statements fold as one `imports` region
    // (exactly like VS Code's built-in JS/TS provider). A single import —
    // even a multi-line one — produces no extra region (its own brackets
    // already fold). Blank lines inside a run are allowed; any other line
    // breaks it. F-8: a braceless import's end is its terminating `;` (the
    // statement may span lines), so continuation lines don't break the run.
    for (let idx = 0; idx < importLines.length; ) {
        const runStart = importLines[idx];
        let statements = 1;
        let runEnd = Math.max(
            runStart,
            importEndByLine.get(runStart) ?? bracketCloseByStartLine.get(runStart) ?? runStart
        );
        let j = idx + 1;
        while (j < importLines.length) {
            const candidate = importLines[j];
            // F-8: only blank lines and comments may sit between the
            // statements — anything else breaks the run (tsserver agrees).
            // A trailing comment after an import (`import a from 'a'; // x`)
            // is part of the import's own line and never reaches this gap.
            const gapOk = isWsOrCommentsOnly(lines.slice(runEnd + 1, candidate).join('\n'));
            if (!gapOk || candidate <= runEnd) {
                if (candidate <= runEnd) {
                    j++;
                    continue;
                }
                break;
            }
            statements++;
            runEnd = Math.max(
                candidate,
                importEndByLine.get(candidate) ??
                    bracketCloseByStartLine.get(candidate) ??
                    candidate
            );
            j++;
        }
        if (statements >= 2 && runEnd > runStart) {
            ranges.push({ start: runStart, end: runEnd, kind: 'imports' });
        }
        idx = j;
    }

    // Merged signature+body ranges (WebStorm look): a parameter list whose
    // closing `)` line opens the body (e.g. `): Promise<void> {`, `) => {`)
    // stretches through the body end, while the body keeps its own range
    // for progressive unfolding. F-7: trailing comments on the closing line
    // are lexically ignored before the brace test.
    if (parenRanges.length > 0) {
        const parenSet = new Set(parenRanges.map(p => p.range));
        for (const { range: paren, closeLine } of parenRanges) {
            const closingText = codeBeforeTrailingComment(lines[closeLine] ?? '');
            const opensBody = closingText.endsWith('{') || closingText.endsWith('[');
            // F-12/R10: an Allman FUNCTION declaration whose closing-paren line
            // has no return annotation (`function f(` … `)`) still merges with
            // the body below it: a line that STARTS with the `function` keyword
            // is a declaration, never a call, so the parameter list provably
            // belongs to the block. (A method has no such marker, so it keeps
            // the conservative unmerged behavior.)
            const declarationParen =
                /^\s*(?:(?:export|declare|default|async)\s+)*function\b/.test(
                    codeBeforeTrailingComment(lines[paren.start] ?? '')
                );
            // F-12: an arrow whose body `{` sits on the NEXT line (`) =>` +
            // `{`). The `=>` makes this unambiguous — it cannot be a call, so
            // the signature must still merge with the body below it.
            const opensNextLineBody = closingText.endsWith('=>');
            // F-12 Allman declarations: the body's `{` sits on the line AFTER
            // the closing paren (walked back to this line), and the closing
            // line is a declaration tail like `): string` / `): Promise<void>`.
            // tsserver still emits ONE merged span — merge here too. The
            // required `:` annotation prevents merging a plain `)` call with
            // an unrelated block below it. Indented declarations (`    ): T`)
            // count too — only the brace test used to be indent-proof.
            const declarationTail = /^\s*[)\]]\s*:\s*\S/.test(closingText);
            if (
                !opensBody &&
                !opensNextLineBody &&
                !declarationTail &&
                !declarationParen
            ) {
                continue;
            }
            // A `(` that opens on the same line as another NON-paren bracket
            // range (e.g. `async (props: {` opens both `(` and `{`) must NOT
            // stretch: it would duplicate that line's start and VS Code
            // would drop one of the folds. Same-start sibling PARENS
            // (e.g. `call((`) are fine — stretching them converges on one
            // merged range that dedup collapses.
            if (ranges.some(r => r !== paren && r.start === paren.start && !parenSet.has(r))) {
                continue;
            }
            let body: SimpleFoldingRange | undefined;
            for (const candidate of ranges) {
                if (
                    candidate !== paren &&
                    candidate.kind === undefined &&
                    (candidate.start === closeLine ||
                        (declarationParen &&
                            candidate.start > closeLine &&
                            isWsOrCommentsOnly(lines.slice(closeLine + 1, candidate.start).join('\n')))) &&
                    candidate.end > paren.end &&
                    (body === undefined || candidate.end > body.end)
                ) {
                    body = candidate;
                }
            }
            if (!body) {
                continue;
            }
            paren.end = body.end;
            // In native mode tsserver emits ONLY the merged span — the body
            // has no separate range. In WebStorm mode the body keeps its own
            // range so progressive unfolding still works.
            if (!opts.singleLineFolds) {
                const idx = ranges.indexOf(body);
                if (idx !== -1) {
                    ranges.splice(idx, 1);
                }
            }
        }
    }

    const sorted = ranges.sort((a, b) => a.start - b.start || b.end - a.end);
    // Drop exact duplicates (e.g. a paren and a brace group covering the
    // same lines after single-line folding).
    return sorted.filter(
        (r, i) => i === 0 || sorted[i - 1].start !== r.start || sorted[i - 1].end !== r.end
    );
}

/**
 * Given the editor's visible ranges (as zero-based [startLine, endLine]
 * pairs), return the lines that end a visible range but are followed by
 * another visible range — i.e. the first lines of folded (hidden) regions,
 * where the ellipsis is rendered.
 */
export function foldedStartLines(visible: Array<{ startLine: number; endLine: number }>): number[] {
    const out: number[] = [];
    for (let i = 0; i < visible.length - 1; i++) {
        out.push(visible[i].endLine);
    }
    return out;
}

/**
 * E-7: start lines of every currently COLLAPSED fold, derived from the
 * editor's visible ranges plus the computed folding ranges.
 *
 * - A gap between two consecutive visible ranges is always a collapsed fold
 *   (plain scrolling cannot punch holes in the middle of the viewport).
 * - A fold whose hidden region reaches the end of the file leaves NO visible
 *   range after it, so the gap method misses it — that case is recovered
 *   from the folding ranges ONLY when the range actually reaches EOF
 *   (`end >= lineCount - 1`). The old heuristic trusted ANY range starting
 *   on the last visible line, which fabricated a phantom collapsed fold out
 *   of every open block whose header happened to be the viewport's last
 *   visible line.
 */
export function collapsedFoldStarts(
    visible: Array<{ startLine: number; endLine: number }>,
    ranges: SimpleFoldingRange[],
    lineCount: number
): number[] {
    const out = new Set(foldedStartLines(visible));
    if (visible.length >= 1) {
        const lastLine = visible[visible.length - 1].endLine;
        if (
            ranges.some(
                r =>
                    r.start === lastLine &&
                    r.end > lastLine &&
                    (r.end >= lineCount - 1 || (lineCount >= 3 && r.end >= lineCount - 3))
            )
        ) {
            out.add(lastLine);
        }
    }
    return [...out].sort((a, b) => a - b);
}

export type CollapsedFold = { header: number; hiddenEnd: number };

/**
 * Ground-truth collapsed folds derived from the editor's visible ranges: each
 * gap between two visible ranges IS a collapsed fold — `header` is the last
 * visible line above the gap and `hiddenEnd` the last hidden line. Unlike
 * matching against our own computed ranges, this stays correct even when the
 * active fold came from a DIFFERENT folding provider (or disagrees with our
 * scanner). A fold reaching EOF has no visible range below it, so it is
 * recovered from the ranges list — trusted only when at least two visible
 * ranges prove folding is active at all AND the range actually reaches EOF
 * (`end >= lineCount - 1`, see E-7).
 */
export function collapsedFolds(
    visible: Array<{ startLine: number; endLine: number }>,
    ranges: SimpleFoldingRange[],
    lineCount: number
): CollapsedFold[] {
    const out: CollapsedFold[] = [];
    for (let i = 0; i < visible.length - 1; i++) {
        const header = visible[i].endLine;
        const hiddenEnd = visible[i + 1].startLine - 1;
        if (hiddenEnd > header && !out.some(f => f.header === header)) {
            out.push({ header, hiddenEnd });
        }
    }
    if (visible.length >= 1) {
        const lastLine = visible[visible.length - 1].endLine;
        const r = ranges.find(
            x =>
                x.start === lastLine &&
                x.end > lastLine &&
                (x.end >= lineCount - 1 || (lineCount >= 3 && x.end >= lineCount - 3))
        );
        if (r && !out.some(f => f.header === lastLine)) {
            out.push({ header: lastLine, hiddenEnd: r.end });
        }
    }
    return out.sort((a, b) => a.header - b.header);
}

/**
 * When a mouse click lands on a line that is HIDDEN inside a collapsed fold
 * (VS Code can map clicks on/past a folded row's badge to the END of the
 * folded content instead of the header line), resolve it to that fold's
 * header. Returns the header line of the OUTERMOST collapsed fold containing
 * `line`, or undefined when the line is not hidden inside any collapsed fold.
 */
export function collapsedFoldHeaderForHiddenLine(
    collapsedHeaders: number[],
    ranges: SimpleFoldingRange[],
    line: number
): number | undefined {
    const hit = ranges.find(
        r => line > r.start && line <= r.end && collapsedHeaders.includes(r.start)
    );
    return hit?.start;
}

/**
 * Should a badge CLICK on the collapsed fold starting at `fold.header` drop
 * the cursor position remembered by Fold All?
 *
 * Yes when the remembered cursor sits ON the clicked header or anywhere
 * inside its hidden region: clicking the `···` badge of a block that is an
 * ANCESTOR of the remembered position is a deliberate, manual way of
 * expanding — the automatic "jump back to the remembered cursor and expand
 * the whole parent chain" restore must NOT kick in (that was the "clicking a
 * badge teleports the cursor to its old position" bug). Clicks on unrelated
 * blocks keep the remembered position, so Unfold All can still restore it.
 */
export function badgeClickDropsRememberedCursor(
    fold: CollapsedFold,
    rememberedLine: number
): boolean {
    return rememberedLine >= fold.header && rememberedLine <= fold.hiddenEnd;
}

/**
 * E-8: index of the cursor in `next` that was ADDED relative to `prev`
 * (a multi-cursor modifier click adds a cursor; the click handler should
 * target THAT one, not the first empty selection in document order).
 * Returns -1 when no new cursor is detectable.
 */
export function addedCursorIndex(
    prev: ReadonlyArray<{ line: number; character: number }>,
    next: ReadonlyArray<{ line: number; character: number }>
): number {
    for (let i = 0; i < next.length; i++) {
        const n = next[i];
        if (!prev.some(p => p.line === n.line && p.character === n.character)) {
            return i;
        }
    }
    return -1;
}

/**
 * First meaningful text line of a folded block comment — WebStorm shows this
 * instead of a plain ellipsis so collapsed JSDoc stays readable.
 *
 * Comment markers (the JSDoc/block open + close markers, `*`, `//`) are
 * stripped and the first
 * non-empty line is returned, truncated to `maxLength` characters. ALL lines
 * are scanned (the header's own text included) because the renderer hides
 * the header text and moves it into the badge.
 *
 * Pinned behavior (T-3): `maxLength <= 0` yields the fallback `'···'`.
 */
export function commentPreviewText(commentLines: string[], maxLength: number): string {
    if (maxLength <= 0) return '···';
    for (const raw of commentLines) {
        const stripped = raw
            .trim()
            .replace(/^\/\/+/, '')
            .replace(/^\/\*+/, '')
            .replace(/\*+\/\s*$/, '')
            .replace(/^\*+/, '')
            .trim();
        if (stripped.length === 0) continue;
        if (stripped.length <= maxLength) return stripped;
        return `${stripped.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
    }
    return '···';
}

/**
 * Normalize the `smartFolding.ellipsisBackground` setting value.
 *
 * Returns the trimmed CSS color string (e.g. "#46494e"), or `undefined` when
 * the setting is empty/whitespace — meaning "fall back to the theme's
 * selection color (`editor.selectionBackground`)".
 */
export function resolveEllipsisBackground(value: string | null | undefined): string | undefined {
    const trimmed = (value ?? '').trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Normalize the `smartFolding.ellipsisColor` setting value.
 *
 * Returns the trimmed CSS color string (e.g. "#9a9da5"), or `undefined` when
 * the setting is empty/whitespace — meaning "fall back to the theme's
 * foreground color (`editor.foreground`)".
 */
export function resolveEllipsisColor(value: string | null | undefined): string | undefined {
    const trimmed = (value ?? '').trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * T-5: PURE decision logic for rendering a collapsed fold's badge, extracted
 * from extension.ts so it can be unit-tested. The caller computes the
 * comment preview (needs document lines) and supplies the closing line's
 * text for suffix extraction.
 */
export interface FoldBadgeInput {
    /** Text of the folded header line. */
    lineText: string;
    /** Fold range kind (undefined = code block). */
    kind?: SimpleFoldingRange['kind'];
    /** Precomputed comment preview (first meaningful line, truncated). */
    previewText: string;
    commentPreviewEnabled: boolean;
    singleLineFolding: boolean;
    hideOpeningBracket: boolean;
    /**
     * Text of the closing line of the ACTUALLY hidden region (for extracting
     * a suffix like ` as const)`); undefined when unknown/unavailable.
     */
    closingLineText?: string;
}

export interface FoldBadgeResult {
    contentText: string;
    hiddenStart?: number;
    visibleMarkerEnd?: number;
    noMargin?: boolean;
}

export function computeFoldBadge(input: FoldBadgeInput): FoldBadgeResult {
    const { lineText, kind, previewText } = input;

    if (kind === 'comment' && input.commentPreviewEnabled) {
        // WebStorm-style readable comment folds: the WHOLE comment — its
        // `/**` header included — collapses into the gray badge, which shows
        // the first meaningful text line.
        const trimmed = lineText.trimStart();
        if (trimmed.startsWith('//')) {
            const markerIndex = lineText.indexOf('//');
            // VS Code does not expose click events for decorations; click-to-
            // expand is inferred from the caret position produced by a mouse
            // click. An `after` decoration anchored at absolute column 0 is a
            // special dead zone, so keep the real top-level `//` as a tiny,
            // stable text boundary and hide everything after it.
            if (markerIndex === 0) {
                // When the header line is ONLY the marker, the first hidden
                // column coincides with the LINE END — where other extensions
                // (e.g. GitLens inline blame) anchor their own end-of-line
                // decorations. Hiding the marker's last char and re-drawing it
                // inside the badge pulls the anchor strictly before the line
                // end, so the badge always renders first.
                if (lineText.length === 2) {
                    return {
                        contentText: `/ ${previewText} ···`,
                        hiddenStart: 1,
                        visibleMarkerEnd: 1,
                    };
                }
                return {
                    contentText: ` ${previewText} ···`,
                    hiddenStart: 2,
                    visibleMarkerEnd: 2,
                };
            }
            return {
                contentText: `// ${previewText} ···`,
                hiddenStart: lineText.indexOf('//'),
            };
        }
        const marker = trimmed.match(/\/\*+/)?.[0] ?? '/*';
        const markerIndex = lineText.indexOf(marker);
        // Same column-zero rule as `//` above: retain only the real marker as
        // a stable caret boundary.
        if (markerIndex === 0) {
            // Same line-end tie-break as `//`: on a bare `/**` header line,
            // anchoring at `marker.length` lands exactly ON the line end,
            // where GitLens & co. attach their inline blame — hide the
            // marker's last char and re-draw it inside the badge so the badge
            // deterministically renders before any end-of-line decoration.
            if (lineText.length === marker.length) {
                return {
                    contentText: `${marker.charAt(marker.length - 1)} ${previewText} */`,
                    hiddenStart: marker.length - 1,
                    visibleMarkerEnd: marker.length - 1,
                };
            }
            return {
                contentText: ` ${previewText} */`,
                hiddenStart: marker.length,
                visibleMarkerEnd: marker.length,
            };
        }
        return {
            contentText: `${marker} ${previewText} */`,
            hiddenStart: markerIndex >= 0 ? markerIndex : undefined,
        };
    }

    // hideOpeningBracket only applies with single-line folds: when
    // singleLineFolding is OFF the closing bracket stays visible on its own
    // line below, so a `{...}` badge would lie — fall through to the plain
    // ` ··· ` badge and leave the opening bracket visible.
    if (kind === undefined && input.singleLineFolding && input.hideOpeningBracket) {
        const codeLine = codeBeforeTrailingComment(lineText);
        const trimmedCode = codeLine.trimEnd();
        const lastChar = trimmedCode.charAt(trimmedCode.length - 1);
        const rawClosing = input.closingLineText;
        const trimmedClosing = rawClosing ? codeBeforeTrailingComment(rawClosing).trimEnd() : '';

        // If the header ends with `(` or `<` but folds to a body ending with `}`, treat as a merged body
        const isMergedBody = (lastChar === '(' || lastChar === '<') && trimmedClosing.endsWith('}');
        const effectiveOpener = isMergedBody ? '{' : lastChar;
        const closer =
            effectiveOpener === '{' ? '}' : effectiveOpener === '[' ? ']' : effectiveOpener === '(' ? ')' : undefined;

        if (closer) {
            let suffix = '';
            if (rawClosing !== undefined) {
                const mask = (text: string, re: RegExp): string => {
                    return text.replace(re, match => ' '.repeat(match.length));
                };
                const noStrings = mask(
                    rawClosing,
                    /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g
                );
                const noBlock = mask(noStrings, /\/\*.*?\*\//g);
                const lineCommentAt = noBlock.indexOf('//');
                const codeEnd = lineCommentAt === -1 ? noBlock.length : lineCommentAt;
                const codeMasked = noBlock.slice(0, codeEnd);
                const closerIndex = codeMasked.lastIndexOf(closer);
                if (closerIndex !== -1) {
                    const trailing = rawClosing.slice(closerIndex + 1, codeEnd);
                    if (!trailing.trimEnd().endsWith('{') && trailing.trim().length > 0) {
                        suffix = trailing.trimEnd();
                    }
                }
            }

            let hiddenStart: number | undefined = trimmedCode.length - 1;
            let prefix = '';
            let noMargin = false;

            if (isMergedBody) {
                // Keep the opening `(` visible; attach the `{...}` badge flush after it
                hiddenStart = undefined;
            } else if (lastChar === '{' || lastChar === '[') {
                const beforeBracket = trimmedCode.slice(0, trimmedCode.length - 1);
                const openParenIndex = beforeBracket.lastIndexOf('(');
                if (openParenIndex !== -1 && suffix.includes(')')) {
                    const between = beforeBracket.slice(openParenIndex + 1);
                    if (/^\s*$/.test(between)) {
                        hiddenStart = openParenIndex;
                        prefix = '(';
                        if (openParenIndex > 0 && !/\s/.test(trimmedCode.charAt(openParenIndex - 1))) {
                            noMargin = true;
                        }
                    }
                }
            }

            return {
                contentText: `${prefix}${effectiveOpener}...${closer}${suffix}`,
                hiddenStart,
                noMargin,
            };
        }
    }

    return { contentText: ' ··· ' };
}

/**
 * True when `line` is hidden INSIDE a fold: it falls in the gap between two
 * consecutive visible ranges reported by the editor. Lines that are merely
 * scrolled outside the viewport are NOT reported as fold-hidden.
 *
 * Used by the pre-fold cursor tracker to distinguish "the cursor's line was
 * swallowed by a fold" (VS Code then clamps the cursor up to the fold header)
 * from ordinary cursor movement.
 */
export function lineHiddenByFold(
    visible: Array<{ startLine: number; endLine: number }>,
    line: number
): boolean {
    for (let i = 0; i < visible.length - 1; i++) {
        if (line > visible[i].endLine && line < visible[i + 1].startLine) {
            return true;
        }
    }
    return false;
}

/**
 * Detect the cursor clamp VS Code performs when a fold swallows the cursor.
 * The cursor is moved from a line inside the folded range to that range's
 * header line. Unlike `visibleRanges`, this also works when the folded block
 * reaches the end of the file or the old cursor line is outside the viewport.
 */
export function isLikelyFoldClamp(
    ranges: SimpleFoldingRange[],
    previousLine: number,
    nextLine: number
): boolean {
    if (nextLine >= previousLine) return false;
    return ranges.some(
        range => range.start === nextLine && previousLine > range.start && previousLine <= range.end
    );
}

/**
 * True when at least one line that was hidden INSIDE a fold (a gap between
 * two consecutive visible ranges) is now rendered "in place" inside the new
 * visible ranges.
 *
 * This distinguishes a real unfold (a gap opens up right where the viewport
 * already was) from plain scrolling (the old gap lines end up outside the new
 * viewport span). Also used (E-5) as the state signal gating the restore
 * probe: visible ranges MERGING (cur.length < prev.length) means an unfold
 * happened somewhere.
 */
export function unfoldRevealedGapLines(
    previous: Array<{ startLine: number; endLine: number }>,
    next: Array<{ startLine: number; endLine: number }>
): boolean {
    for (let i = 0; i < previous.length - 1; i++) {
        const firstHidden = previous[i].endLine + 1;
        if (next.some(r => firstHidden >= r.startLine && firstHidden <= r.endLine)) {
            return true;
        }
    }
    return false;
}

/**
 * True when the fold-hidden gap that contained `line` in the PREVIOUS
 * visible ranges is now at least partially rendered in the NEXT visible
 * ranges. Retained for reference/testing; see `unfoldRevealedGapLines`.
 */
export function revealedGapContainingLine(
    previous: Array<{ startLine: number; endLine: number }>,
    next: Array<{ startLine: number; endLine: number }>,
    line: number
): boolean {
    for (let i = 0; i < previous.length - 1; i++) {
        const gapStart = previous[i].endLine + 1;
        const gapEnd = previous[i + 1].startLine - 1;
        if (line < gapStart || line > gapEnd) continue;
        return next.some(r => r.startLine <= gapEnd && r.endLine >= gapStart);
    }
    return false;
}

/**
 * Start lines of every folding range that contains `line`, ordered from the
 * OUTERMOST (top-level) block to the INNERMOST one.
 *
 * This is the exact order in which blocks must be unfolded so that `line`
 * becomes visible again after a Fold All, while every unrelated block stays
 * collapsed (WebStorm-style "expand parents at cursor").
 */
export function unfoldPathForLine(ranges: SimpleFoldingRange[], line: number): number[] {
    const containing = ranges.filter(r => r.start <= line && line <= r.end);
    containing.sort((a, b) => a.start - b.start || b.end - a.end);
    const out: number[] = [];
    for (const r of containing) {
        if (!out.includes(r.start)) out.push(r.start);
    }
    return out;
}

// --- Copying collapsed blocks ------------------------------------------------

export interface CopyRange {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
}

/**
 * Copying a collapsed block should copy the WHOLE block, not just its visible
 * header row — with single-line folding even the closing bracket is hidden,
 * so a native copy of the visible row pastes broken code.
 *
 * Given one selection, decide whether the copy must be widened:
 *
 * - An EMPTY selection copies the cursor's line (VS Code's line copy). When
 *   that line is a collapsed fold's header, the copy covers the whole block.
 * - A selection whose end reaches the header row's visible end (Shift+End, a
 *   mouse drag up to the `···` badge — pass the badge's first hidden column
 *   as `visibleEnd`) is extended through the hidden lines.
 *
 * Returns undefined when the native copy is already correct; the caller then
 * falls back to the built-in copy action, preserving its paste metadata.
 */
export function extendCopyRange(
    sel: CopyRange,
    folds: ReadonlyArray<{ header: number; hiddenEnd: number }>,
    lineLength: (line: number) => number,
    visibleEnd: (line: number) => number = lineLength
): (CopyRange & { isLineCopy: boolean }) | undefined {
    const isEmpty = sel.startLine === sel.endLine && sel.startCharacter === sel.endCharacter;
    if (isEmpty) {
        const fold = folds.find(f => f.header === sel.startLine);
        if (fold === undefined) return undefined;
        return {
            startLine: fold.header,
            startCharacter: 0,
            endLine: fold.hiddenEnd,
            endCharacter: lineLength(fold.hiddenEnd),
            isLineCopy: true,
        };
    }
    const fold = folds.find(f => f.header === sel.endLine && f.hiddenEnd > sel.endLine);
    if (fold === undefined || sel.endCharacter < visibleEnd(sel.endLine)) return undefined;
    return {
        startLine: sel.startLine,
        startCharacter: sel.startCharacter,
        endLine: fold.hiddenEnd,
        endCharacter: lineLength(fold.hiddenEnd),
        isLineCopy: false,
    };
}
