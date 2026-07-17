/**
 * Pure folding-range computation (unit tested).
 *
 * A lightweight bracket scanner for C-like languages that understands line
 * comments, block comments, and single/double/backtick strings, so brackets
 * inside those are ignored. (Template-literal `${…}` interpolation is treated
 * as part of the string — good enough in practice for folding.)
 */

export interface FoldingOptions {
    /**
     * WebStorm behavior: the folding range INCLUDES the closing-bracket line,
     * so a collapsed block renders as a single line. When false the closing
     * bracket keeps its own line (VS Code default).
     */
    singleLineFolds: boolean;
    /**
     * WebStorm behavior: parameter lists `(...)` are NOT offered as folding
     * ranges, so function parameters stay visible when the body is folded.
     * When false, multi-line parenthesized groups are foldable too.
     */
    keepFunctionParamsVisible: boolean;
    /**
     * Fold multi-line block comments / JSDoc and runs of consecutive
     * whole-line `//` comments (collapsing them down to their first line).
     * A single-line comment never produces a range, so it can never be
     * collapsed.
     */
    foldComments?: boolean;
}

export interface SimpleFoldingRange {
    /** Zero-based first line (stays visible; the fold starts after it). */
    start: number;
    /** Zero-based last folded line. */
    end: number;
    /** Set for block-comment/JSDoc folds (rendered with a text preview). */
    kind?: 'comment';
}

interface OpenBracket {
    char: string;
    line: number;
}

const OPEN = '{([';
const CLOSE = '})]';

export function computeFoldingRanges(text: string, opts: FoldingOptions): SimpleFoldingRange[] {
    const ranges: SimpleFoldingRange[] = [];
    const stack: OpenBracket[] = [];
    const lineCommentLines: number[] = [];
    const parenRanges: SimpleFoldingRange[] = [];

    let line = 0;
    let lineStart = 0;
    let inLineComment = false;
    let inBlockComment = false;
    let blockCommentStartLine = 0;
    let stringQuote: string | undefined;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];

        if (ch === '\n') {
            line++;
            lineStart = i + 1;
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
            } else if (ch === stringQuote) {
                stringQuote = undefined;
            }
            continue;
        }

        if (ch === '/' && next === '/') {
            inLineComment = true;
            // A line whose first non-whitespace text is `//` is a whole-line
            // comment; consecutive ones fold as one block (WebStorm style).
            if (opts.foldComments && /^\s*$/.test(text.slice(lineStart, i))) {
                lineCommentLines.push(line);
            }
            i++;
            continue;
        }
        if (ch === '/' && next === '*') {
            inBlockComment = true;
            blockCommentStartLine = line;
            i++;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            stringQuote = ch;
            continue;
        }

        if (OPEN.includes(ch)) {
            stack.push({ char: ch, line });
            continue;
        }

        const closeIndex = CLOSE.indexOf(ch);
        if (closeIndex !== -1) {
            const expectedOpen = OPEN[closeIndex];
            // Pop until we find the matching opener (tolerate unbalanced input).
            let open: OpenBracket | undefined;
            while (stack.length > 0) {
                const candidate = stack.pop()!;
                if (candidate.char === expectedOpen) {
                    open = candidate;
                    break;
                }
            }
            if (!open || line <= open.line) continue;

            if (ch === ')' && opts.keepFunctionParamsVisible) {
                // Don't offer parameter lists / parenthesized groups as folds
                // so function params stay visible (WebStorm behavior).
                continue;
            }

            const end = opts.singleLineFolds ? line : line - 1;
            if (end > open.line) {
                const range: SimpleFoldingRange = { start: open.line, end };
                ranges.push(range);
                if (ch === ')') parenRanges.push(range);
            }
        }
    }

    // An unterminated block comment running to EOF still folds.
    if (inBlockComment && opts.foldComments && line > blockCommentStartLine) {
        ranges.push({ start: blockCommentStartLine, end: line, kind: 'comment' });
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
            ranges.push({ start: lineCommentLines[idx], end: lineCommentLines[j], kind: 'comment' });
        }
        idx = j + 1;
    }

    // With keepFunctionParamsVisible OFF the parameter list itself folds —
    // and WebStorm then folds the whole signature+body as ONE region:
    // `async function f(...)`. A parameter-list range whose closing `)` line
    // immediately opens the body (e.g. `): Promise<void> {`) swallows that
    // body range; without this, Fold All left an ugly dangling
    // `): Promise<void> {` line visible between two separate folds.
    if (!opts.keepFunctionParamsVisible && parenRanges.length > 0) {
        const lines = text.split('\n');
        for (const paren of parenRanges) {
            const closingLine = (lines[paren.end] ?? '').trimEnd();
            if (!closingLine.endsWith('{') && !closingLine.endsWith('[')) continue;
            const closeLine = paren.end;
            let mergedEnd = paren.end;
            for (const body of ranges) {
                if (
                    body !== paren &&
                    body.kind !== 'comment' &&
                    body.start === closeLine &&
                    body.end > mergedEnd
                ) {
                    mergedEnd = body.end;
                }
            }
            paren.end = mergedEnd;
        }
    }

    return ranges.sort((a, b) => a.start - b.start || b.end - a.end);
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
 * Start lines of every currently COLLAPSED fold, derived from the editor's
 * visible ranges plus the computed folding ranges.
 *
 * - A gap between two consecutive visible ranges is always a collapsed fold
 *   (plain scrolling cannot punch holes in the middle of the viewport).
 * - A fold whose hidden region reaches the end of the file leaves NO visible
 *   range after it, so the gap method misses it — that was the "no ellipsis
 *   badge on the last function of the file" bug. It is recovered from the
 *   folding ranges: the last rendered line starts a multi-line range. Because
 *   "scrolled below the viewport" looks identical in `visibleRanges`, this
 *   extra case is only trusted while other collapsed folds are on screen
 *   (>= 2 visible ranges) — e.g. right after a Fold All.
 */
export function collapsedFoldStarts(
    visible: Array<{ startLine: number; endLine: number }>,
    ranges: SimpleFoldingRange[]
): number[] {
    const out = new Set(foldedStartLines(visible));
    if (visible.length >= 2) {
        const lastLine = visible[visible.length - 1].endLine;
        if (ranges.some(r => r.start === lastLine && r.end > lastLine)) {
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
 * ranges prove folding is active at all.
 */
export function collapsedFolds(
    visible: Array<{ startLine: number; endLine: number }>,
    ranges: SimpleFoldingRange[]
): CollapsedFold[] {
    const out: CollapsedFold[] = [];
    for (let i = 0; i < visible.length - 1; i++) {
        const header = visible[i].endLine;
        const hiddenEnd = visible[i + 1].startLine - 1;
        if (hiddenEnd > header && !out.some(f => f.header === header)) {
            out.push({ header, hiddenEnd });
        }
    }
    if (visible.length >= 2) {
        const lastLine = visible[visible.length - 1].endLine;
        const r = ranges.find(x => x.start === lastLine && x.end > lastLine);
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
 * First meaningful text line of a folded block comment — WebStorm shows this
 * instead of a plain ellipsis so collapsed JSDoc stays readable.
 *
 * Comment markers (the JSDoc/block open + close markers, `*`, `//`) are
 * stripped and the first
 * non-empty line is returned, truncated to `maxLength` characters. ALL lines
 * are scanned (the header's own text included) because the renderer hides
 * the header text and moves it into the badge.
 */
export function commentPreviewText(commentLines: string[], maxLength: number): string {
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
 * selection color (`editor.selectionBackground`)".
 */
export function resolveEllipsisColor(value: string | null | undefined): string | undefined {
    const trimmed = (value ?? '').trim();
    return trimmed.length > 0 ? trimmed : undefined;
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
 * viewport span). Retained for reference/testing; the extension now uses a
 * self-verifying selection probe instead, because the unfold and its
 * follow-up reveal-scroll can arrive as separate events.
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
