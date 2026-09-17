import * as vscode from 'vscode';
import {
    addedCursorIndex,
    badgeClickDropsRememberedCursor,
    CollapsedFold,
    collapsedFolds,
    commentPreviewText,
    computeFoldBadge,
    computeFoldingRanges,
    extendCopyRange,
    lineHiddenByFold,
    resolveEllipsisBackground,
    resolveEllipsisColor,
    SimpleFoldingRange,
    takeoverLanguages,
    unfoldPathForLine,
    unfoldRevealedGapLines,
} from './core/folding';

// Fallback only — the real ID is resolved at runtime in activate() from
// context.extension.id, so renaming the extension (name/publisher) can never
// silently break the defaultFoldingRangeProvider takeover again.
let EXTENSION_ID = 'SeyMi.smart-folding';

let ellipsisDecoration: vscode.TextEditorDecorationType | undefined;

// Styles the REAL `//` / `/**` prefix retained on top-level folded comments.
// Keeping those characters in the document gives VS Code a reliable non-zero
// caret position for click detection; this decoration visually joins them to
// the injected preview so the result still looks like one continuous badge.
let commentMarkerDecoration: vscode.TextEditorDecorationType | undefined;

// Hides the opening `{` of a collapsed block so the badge can render `{...}`
// in its place (the text itself can't be removed — decoration CSS trick).
let hiddenBracketDecoration: vscode.TextEditorDecorationType | undefined;

/**
 * Folding ranges per document, cached by document version + options: the
 * scanner is linear and fast, but it would otherwise run on every scroll,
 * selection and fold event. Evicted on document close (E-1).
 */
const rangeCache = new Map<
    string,
    { version: number; optsKey: string; ranges: SimpleFoldingRange[] }
>();

function rangesFor(document: vscode.TextDocument): SimpleFoldingRange[] {
    const c = vscode.workspace.getConfiguration('smartFolding');
    const opts = {
        singleLineFolds: c.get<boolean>('singleLineFolding', true),
        foldComments: c.get<boolean>('foldComments', true),
        languageId: document.languageId,
    };
    const optsKey = `${opts.singleLineFolds}|${opts.foldComments}|${document.languageId}`;
    const key = document.uri.toString();
    const cached = rangeCache.get(key);
    if (cached && cached.version === document.version && cached.optsKey === optsKey) {
        return cached.ranges;
    }
    const ranges = computeFoldingRanges(document.getText(), opts);
    rangeCache.set(key, { version: document.version, optsKey, ranges });
    return ranges;
}

/**
 * Cursor/selection state remembered when the user runs
 * "Fold All (Remember Cursor)".
 *
 * IMPORTANT: the state is kept until it is SUCCESSFULLY restored by
 * Unfold All / Smart Unfold (or replaced by the next Fold All). The previous
 * implementation deleted it up-front, so one failed unfold attempt lost the
 * remembered cursor forever — that was the main reason "restore cursor"
 * appeared not to work.
 */
interface SavedFoldState {
    selections: vscode.Selection[];
    /**
     * Where VS Code clamped the cursor when the fold swallowed it (the fold
     * header line). A deliberate mouse/keyboard move away from BOTH this line
     * and the remembered line means the user navigated elsewhere on purpose —
     * the remembered state is then stale and gets dropped.
     */
    clampedActive?: vscode.Position;
    /**
     * E-3: document version at the moment Fold All ran. Any later edit (even
     * one from a background tab or another extension, which never reaches the
     * edit listener for a non-visible editor) invalidates the remembered
     * positions — restoring them would land on the wrong logical position.
     */
    docVersion: number;
}

/**
 * E-2: editor-level state is keyed by the TextEditor itself (WeakMap), not
 * by document URI — a document shown in two editor groups no longer
 * overwrites its own selections, remembered folds or clamp bookkeeping, and
 * everything here is garbage-collected with the editor (E-1).
 */
interface EditorMemory {
    savedState?: SavedFoldState;
    lastSelections?: vscode.Selection[];
    rememberedFolds?: { version: number; folds: CollapsedFold[] };
    lastVisible?: Array<{ startLine: number; endLine: number }>;
    /** E-5: set when an UNFOLD transition was observed in the visible ranges. */
    unfoldSignal?: boolean;
}

const editorMemory = new WeakMap<vscode.TextEditor, EditorMemory>();

function mem(editor: vscode.TextEditor): EditorMemory {
    let m = editorMemory.get(editor);
    if (!m) {
        m = {};
        editorMemory.set(editor, m);
    }
    return m;
}

/**
 * E-3/F-G: remembered cursor state is only valid for the document version it
 * was saved at. Returns the state, discarding it when the document changed —
 * this also covers edits applied to a NON-visible editor (background tab,
 * formatter, source control), which the edit listener never sees because
 * `visibleTextEditors` only lists the editors currently rendered.
 */
function liveState(editor: vscode.TextEditor): SavedFoldState | undefined {
    const state = mem(editor).savedState;
    if (state && state.docVersion !== editor.document.version) {
        mem(editor).savedState = undefined;
        return undefined;
    }
    return state;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(() => resolve(), ms));

function cloneSelections(selections: readonly vscode.Selection[]): vscode.Selection[] {
    return selections.map(s => new vscode.Selection(s.anchor, s.active));
}

function selectionsEqual(a: readonly vscode.Selection[], b: readonly vscode.Selection[]): boolean {
    if (a.length !== b.length) return false;
    return a.every(
        (s, i) =>
            s.anchor.line === b[i].anchor.line &&
            s.anchor.character === b[i].anchor.character &&
            s.active.line === b[i].active.line &&
            s.active.character === b[i].active.character
    );
}

// --- (4) Hide VS Code's native `···` fold placeholder ----------------------
// No decoration/extension API can suppress the built-in collapsed-text
// indicator, but its THEME COLOR (`editor.foldPlaceholderForeground`,
// VS Code ≥ 1.81) can be made fully transparent. Managed in the user's
// global `workbench.colorCustomizations`: an existing user-set color is
// never overwritten, and only our own transparent value is ever removed
// (E-10 merges from the GLOBAL value only; E-11 tracks ownership).
const PLACEHOLDER_COLOR = 'editor.foldPlaceholderForeground';
const TRANSPARENT_COLOR = '#00000000';
/** globalState key recording whether the transparent value is OURS (E-11). */
const OWNED_PLACEHOLDER_KEY = 'smartFolding.ownedPlaceholderColor';
/** True when the transparent value currently in settings was written by us. */
let ownedPlaceholderColor = false;

const syncNativePlaceholder = async (context?: vscode.ExtensionContext): Promise<void> => {
    try {
        const hide = vscode.workspace
            .getConfiguration('smartFolding')
            .get<boolean>('hideNativeFoldPlaceholder', true);
        const workbench = vscode.workspace.getConfiguration('workbench');
        // E-10: NEVER use `workbench.get('colorCustomizations')` as the merge
        // base — `get()` returns the EFFECTIVE (workspace-merged) value, and
        // writing that to ConfigurationTarget.Global silently persists
        // workspace keys into the user's global settings.json.
        const inspected = workbench.inspect<Record<string, unknown>>('colorCustomizations');
        const colors = inspected?.globalValue ?? {};
        const current = colors[PLACEHOLDER_COLOR];
        // E-11: ownership is PERSISTED, so a value the USER writes later (even
        // one equal to our transparent marker) is never mistaken for ours and
        // deleted. No record at all means a pre-persistence install: fall back
        // to value equality once, exactly like earlier versions did.
        const recorded = context?.globalState.get<boolean | undefined>(OWNED_PLACEHOLDER_KEY);
        if (recorded !== undefined) {
            ownedPlaceholderColor = recorded;
        } else if (current === TRANSPARENT_COLOR) {
            ownedPlaceholderColor = true;
        }
        if (hide && current === undefined) {
            await workbench.update(
                'colorCustomizations',
                { ...colors, [PLACEHOLDER_COLOR]: TRANSPARENT_COLOR },
                vscode.ConfigurationTarget.Global
            );
            ownedPlaceholderColor = true;
        } else if (!hide && current === TRANSPARENT_COLOR && ownedPlaceholderColor) {
            const next: Record<string, unknown> = { ...colors };
            delete next[PLACEHOLDER_COLOR];
            await workbench.update('colorCustomizations', next, vscode.ConfigurationTarget.Global);
            ownedPlaceholderColor = false;
        }
        await context?.globalState.update(OWNED_PLACEHOLDER_KEY, ownedPlaceholderColor);
    } catch {
        // E-12: writing user settings can fail (read-only profile, remote) —
        // non-fatal, never an unhandled rejection.
    }
};

export function activate(context: vscode.ExtensionContext): void {
    // Resolve the real extension ID at runtime (rename-proof). NOTE: no
    // self-check against `vscode.extensions.getExtension(EXTENSION_ID)` — the
    // uninstall cleanup does NOT run through activation (the manifest's
    // `vscode:uninstall` "activation event" was never a valid one; see
    // `scripts/uninstall.js`), so the old check was dead code whose only
    // possible effect was to disable the extension when the lookup failed.
    EXTENSION_ID = context.extension.id;

    const cfg = () => vscode.workspace.getConfiguration('smartFolding');

    // Set while this extension itself is moving the selection (restore probe,
    // smart unfold, modifier-click expand) so the selection handlers below
    // ignore those synthetic events.
    let autoRestoring = false;

    void syncNativePlaceholder(context);

    // Fired when a setting that changes the COMPUTED ranges flips, so VS Code
    // re-queries the provider immediately instead of waiting for an edit.
    const foldingRangesChanged = new vscode.EventEmitter<void>();
    context.subscriptions.push(foldingRangesChanged);

    // --- (a) Bigger, highlighted, hover/click-expandable '···' badge ---------
    const createEllipsisDecoration = (): vscode.TextEditorDecorationType => {
        const c = cfg();
        // Shared colors — used for BOTH themes unless a dark/light-specific
        // setting overrides them below.
        const sharedBackground = resolveEllipsisBackground(
            c.get<string>('ellipsisBackground', '#46494e')
        );
        const sharedColor = resolveEllipsisColor(c.get<string>('ellipsisColor', '#9a9da5'));
        // Resolution order per theme: theme-specific setting → shared setting →
        // the current theme's own color (selection background / foreground).
        const pick = (
            themeSpecific: string | undefined,
            shared: string | undefined,
            themeColorId: string
        ): string | vscode.ThemeColor =>
            themeSpecific ?? shared ?? new vscode.ThemeColor(themeColorId);

        const darkBackground = pick(
            resolveEllipsisBackground(c.get<string>('ellipsisBackgroundDark', '')),
            sharedBackground,
            'editor.selectionBackground'
        );
        const darkColor = pick(
            resolveEllipsisColor(c.get<string>('ellipsisColorDark', '')),
            sharedColor,
            'editor.foreground'
        );
        const lightBackground = pick(
            resolveEllipsisBackground(c.get<string>('ellipsisBackgroundLight', '')),
            sharedBackground,
            'editor.selectionBackground'
        );
        const lightColor = pick(
            resolveEllipsisColor(c.get<string>('ellipsisColorLight', '')),
            sharedColor,
            'editor.foreground'
        );

        const baseStyles = {
            // contentText comes from each decoration INSTANCE (the badge
            // text differs per fold). Defining it here TOO made VS Code
            // render a second ' ··· ' badge next to every {...} badge.
            margin: '0 0 0 0.5ch',
            fontWeight: 'bold',
            // CSS injection via textDecoration — a well-known decoration trick to
            // get rounded corners, padding and a pointer cursor.
            textDecoration: 'none; border-radius: 4px; padding: 0 5px; cursor: pointer;',
        };

        return vscode.window.createTextEditorDecorationType({
            after: baseStyles,
            before: baseStyles,
            // VS Code automatically applies the block matching the active theme
            // kind, so the badge can be styled independently for dark & light.
            dark: {
                after: { backgroundColor: darkBackground, color: darkColor },
                before: { backgroundColor: darkBackground, color: darkColor },
            },
            light: {
                after: { backgroundColor: lightBackground, color: lightColor },
                before: { backgroundColor: lightBackground, color: lightColor },
            },
        });
    };

    const createCommentMarkerDecoration = (): vscode.TextEditorDecorationType => {
        const c = cfg();
        const sharedBackground = resolveEllipsisBackground(
            c.get<string>('ellipsisBackground', '#46494e')
        );
        const sharedColor = resolveEllipsisColor(c.get<string>('ellipsisColor', '#9a9da5'));
        const pick = (
            themeSpecific: string | undefined,
            shared: string | undefined,
            themeColorId: string
        ): string | vscode.ThemeColor =>
            themeSpecific ?? shared ?? new vscode.ThemeColor(themeColorId);

        const darkBackground = pick(
            resolveEllipsisBackground(c.get<string>('ellipsisBackgroundDark', '')),
            sharedBackground,
            'editor.selectionBackground'
        );
        const darkColor = pick(
            resolveEllipsisColor(c.get<string>('ellipsisColorDark', '')),
            sharedColor,
            'editor.foreground'
        );
        const lightBackground = pick(
            resolveEllipsisBackground(c.get<string>('ellipsisBackgroundLight', '')),
            sharedBackground,
            'editor.selectionBackground'
        );
        const lightColor = pick(
            resolveEllipsisColor(c.get<string>('ellipsisColorLight', '')),
            sharedColor,
            'editor.foreground'
        );

        return vscode.window.createTextEditorDecorationType({
            fontWeight: 'bold',
            // The right half is supplied by ellipsisDecoration's `after`
            // attachment. Zero right padding/radius makes both halves meet.
            textDecoration: 'none; border-radius: 4px 0 0 4px; padding: 0 0 0 5px;',
            dark: { backgroundColor: darkBackground, color: darkColor },
            light: { backgroundColor: lightBackground, color: lightColor },
        });
    };
    ellipsisDecoration = createEllipsisDecoration();
    commentMarkerDecoration = createCommentMarkerDecoration();
    context.subscriptions.push({ dispose: () => ellipsisDecoration?.dispose() });
    context.subscriptions.push({ dispose: () => commentMarkerDecoration?.dispose() });

    // Visually removes a collapsed block's opening `{` so the `{...}` badge
    // can take its place. Well-known decoration trick (used e.g. by the
    // Inline Fold extension): the document text is untouched and the bracket
    // reappears the moment the block is unfolded.
    hiddenBracketDecoration = vscode.window.createTextEditorDecorationType({
        textDecoration: 'none; display: none;',
    });
    context.subscriptions.push({ dispose: () => hiddenBracketDecoration?.dispose() });

    const refresh = (editor: vscode.TextEditor | undefined) => {
        if (editor) updateEllipsisDecorations(editor, cfg().get<boolean>('enhancedEllipsis', true));
    };

    // E-13: decorations must also refresh after EDITS — the range cache is
    // version-aware, so a refresh recomputes cheaply only when needed.
    // Debounced: typing fires bursts of change events. The pending set keeps
    // EVERY editor showing the edited document fresh (a document shown in two
    // editor groups does not share decorations) and burst edits in several
    // documents all refresh instead of only the last one.
    let editRefreshTimer: NodeJS.Timeout;
    const pendingEditRefresh = new Set<vscode.TextEditor>();
    context.subscriptions.push(
        {
            dispose: () => {
                clearTimeout(editRefreshTimer);
                pendingEditRefresh.clear();
            },
        },
        vscode.workspace.onDidChangeTextDocument(e => {
            for (const editor of vscode.window.visibleTextEditors) {
                if (editor.document === e.document) pendingEditRefresh.add(editor);
            }
            if (pendingEditRefresh.size === 0) return;
            clearTimeout(editRefreshTimer);
            editRefreshTimer = setTimeout(() => {
                const editors = [...pendingEditRefresh];
                pendingEditRefresh.clear();
                for (const editor of editors) {
                    if (vscode.window.visibleTextEditors.includes(editor)) {
                        refresh(editor);
                    }
                }
            }, 50);
        })
    );

    // E-1/E-3: document lifecycle — evict cached ranges on close and DISCARD
    // remembered cursor state on ANY edit (a Selection refers to positions
    // from the moment Fold All ran; restoring it after an edit could land on
    // the wrong logical position — discard instead of rebasing).
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(document => {
            rangeCache.delete(document.uri.toString());
            // Editor-level state lives in editorMemory (WeakMap<TextEditor>)
            // and is garbage-collected with the editor — nothing to evict.
        }),
        vscode.workspace.onDidChangeTextDocument(e => {
            for (const editor of vscode.window.visibleTextEditors) {
                if (editor.document === e.document) {
                    mem(editor).savedState = undefined;
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorVisibleRanges(e => refresh(e.textEditor)),
        vscode.window.onDidChangeActiveTextEditor(e => refresh(e)),
        vscode.workspace.onDidChangeConfiguration(e => {
            const badgeColorSettings = [
                'smartFolding.ellipsisBackground',
                'smartFolding.ellipsisBackgroundDark',
                'smartFolding.ellipsisBackgroundLight',
                'smartFolding.ellipsisColor',
                'smartFolding.ellipsisColorDark',
                'smartFolding.ellipsisColorLight',
            ];
            if (badgeColorSettings.some(s => e.affectsConfiguration(s))) {
                // The decoration type is immutable — recreate it with the new colors.
                ellipsisDecoration?.dispose();
                ellipsisDecoration = createEllipsisDecoration();
                commentMarkerDecoration?.dispose();
                commentMarkerDecoration = createCommentMarkerDecoration();
            }
            if (
                e.affectsConfiguration('smartFolding.singleLineFolding') ||
                e.affectsConfiguration('smartFolding.foldComments')
            ) {
                foldingRangesChanged.fire();
            }
            if (e.affectsConfiguration('smartFolding.hideNativeFoldPlaceholder')) {
                void syncNativePlaceholder(context);
            }
            if (
                e.affectsConfiguration('smartFolding.takeOverFolding') ||
                e.affectsConfiguration('smartFolding.languages')
            ) {
                void ensureDefaultFoldingProvider(context);
            }
            if (e.affectsConfiguration('smartFolding')) {
                for (const editor of vscode.window.visibleTextEditors) refresh(editor);
            }
        })
    );
    refresh(vscode.window.activeTextEditor);

    // Expand command (used by the hover link on the badge).
    context.subscriptions.push(
        vscode.commands.registerCommand('smartFolding.expandHere', async (line?: number) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const target = typeof line === 'number' ? line : editor.selection.active.line;
            await vscode.commands.executeCommand('editor.unfold', {
                levels: 1,
                selectionLines: [target],
            });
        })
    );

    // --- Copying collapsed blocks -------------------------------------------
    // With single-line folding the closing bracket line is hidden too, so a
    // native copy of the visible row yields BROKEN code. This Ctrl+C/Cmd+C
    // override (bound only while `smartFolding.copyFoldedBlocks` is on — the
    // keybinding's `when` clause checks the setting) widens the copy: a line
    // copy (empty selection) on a collapsed header copies the whole block,
    // and a selection reaching the collapsed row's visible end is extended
    // through the hidden lines. Every other copy falls back to the built-in
    // action, keeping its paste metadata (line paste, multi-cursor spread…).
    context.subscriptions.push(
        vscode.commands.registerCommand('smartFolding.clipboardCopy', async () => {
            const native = (): Thenable<unknown> =>
                vscode.commands.executeCommand('editor.action.clipboardCopyAction');
            const editor = vscode.window.activeTextEditor;
            if (!editor) return native();
            const c = cfg();
            const ranges = rangesFor(editor.document);
            const folds = currentCollapsedFolds(editor, ranges);
            if (folds.length === 0) return native();
            const doc = editor.document;
            const len = (l: number): number => doc.lineAt(l).text.length;
            // The badge may visually replace the end of the header row, so a
            // mouse drag "to the end" stops at the first hidden column —
            // before the line's real end. Treat that as selected-to-the-end.
            const visibleEnd = (l: number): number => {
                const fold = folds.find(f => f.header === l);
                if (!fold) return len(l);
                const { hiddenStart } = foldBadge(editor, l, ranges, c, fold.hiddenEnd);
                return Math.min(hiddenStart ?? len(l), len(l));
            };
            let widened = false;
            let anyPiece = false;
            // E-9: a line-copy trailing newline is added only when EVERY
            // piece is a line copy (one unrelated line-copy selection must
            // not turn the whole multi-cursor clipboard into a line copy).
            let allLineCopy = true;
            const pieces: string[] = [];
            for (const sel of editor.selections) {
                const ext = extendCopyRange(
                    {
                        startLine: sel.start.line,
                        startCharacter: sel.start.character,
                        endLine: sel.end.line,
                        endCharacter: sel.end.character,
                    },
                    folds,
                    len,
                    visibleEnd
                );
                if (ext === undefined) {
                    anyPiece = true;
                    pieces.push(
                        sel.isEmpty
                            ? doc.lineAt(sel.start.line).text
                            : doc.getText(new vscode.Range(sel.start, sel.end))
                    );
                    if (!sel.isEmpty) allLineCopy = false;
                    continue;
                }
                widened = true;
                anyPiece = true;
                if (!ext.isLineCopy) allLineCopy = false;
                pieces.push(
                    doc.getText(
                        new vscode.Range(
                            new vscode.Position(ext.startLine, ext.startCharacter),
                            new vscode.Position(ext.endLine, ext.endCharacter)
                        )
                    )
                );
            }
            // No collapsed block was touched: the built-in copy handles it.
            if (!widened) return native();
            // E-9: use the document's real EOL; any clipboard failure falls
            // back to the native copy instead of breaking copy entirely.
            const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
            try {
                await vscode.env.clipboard.writeText(
                    pieces.join(eol) + (allLineCopy && anyPiece ? eol : '')
                );
            } catch {
                return native();
            }
        })
    );

    // Click-to-expand: clicking on the badge area of a folded start line
    // unfolds that block — emulating WebStorm's large clickable ellipsis.
    // Holding the multi-cursor modifier (Alt by default — see VS Code's
    // `editor.multiCursorModifier` setting) while clicking expands the block
    // RECURSIVELY, folded descendants included. Only reacts to mouse clicks.
    //
    // The badge may visually REPLACE the end of the header line (the hidden
    // `{` / the hidden `/**…` comment text), in which case a click on the
    // badge lands BEFORE the line end — the clickable area therefore starts
    // at the first hidden column, not at the line end. (Requiring the line
    // end was the "clicking {...} stopped unfolding" regression.)
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(async e => {
            if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) return;
            if (autoRestoring) return;
            const c = cfg();
            const editor = e.textEditor;
            const m = mem(editor);
            const ranges = rangesFor(editor.document);
            const folds = currentCollapsedFolds(editor, ranges);
            if (folds.length === 0) return;
            // Where did the click actually land? Clicking the badge of a
            // collapsed row does NOT reliably put the cursor on the header
            // line: VS Code may map a click on/past injected text to the END
            // of the folded (hidden) content instead. Both cases resolve to
            // the fold's header line here — relying on the header line only
            // was the "clicking {...} doesn't unfold" bug.
            const targetFoldStart = (p: vscode.Position): number | undefined => {
                const asHeader = folds.find(f => f.header === p.line);
                if (asHeader) {
                    // clickLineToExpand: the WHOLE header row is a click
                    // target — any click on the collapsed line expands the
                    // block, no need to aim at the `···` badge itself.
                    if (c.get<boolean>('clickLineToExpand', false)) return p.line;
                    const { hiddenStart } = foldBadge(
                        editor,
                        p.line,
                        ranges,
                        c,
                        asHeader.hiddenEnd
                    );
                    const threshold = hiddenStart ?? editor.document.lineAt(p.line).text.length;
                    return p.character >= threshold ? p.line : undefined;
                }
                // The gap itself tells us the header — no range guessing.
                const gap = folds.find(f => p.line > f.header && p.line <= f.hiddenEnd);
                if (!gap) return undefined;
                return gap.header;
            };

            // A badge click that expands a block CONTAINING the cursor
            // position remembered by Fold All is a deliberate, manual way of
            // expanding — drop the remembered state BEFORE unfolding, so the
            // automatic restore (probe + Smart Unfold) cannot kick in and
            // teleport the cursor back to its old position. Without this,
            // clicking the badge of an ANCESTOR of the remembered cursor
            // expanded the whole parent chain and jumped the cursor there.
            // Clicks on unrelated blocks keep the remembered position, so
            // Unfold All can still restore it later.
            const dropRememberedCursorFor = (headerLine: number): void => {
                const state = m.savedState;
                if (!state || state.selections.length === 0) return;
                const fold = folds.find(f => f.header === headerLine);
                if (!fold) return;
                if (badgeClickDropsRememberedCursor(fold, state.selections[0].active.line)) {
                    m.savedState = undefined;
                }
            };

            // Modifier+click: VS Code exposes no modifier keys on mouse
            // events, but the multi-cursor modifier ADDS a cursor — a mouse
            // selection event with 2+ selections. When the added cursor sits
            // on a collapsed fold's badge, treat it as modifier+click.
            if (
                e.selections.length >= 2 &&
                c.get<boolean>('modifierClickExpandsRecursively', true)
            ) {
                // E-8: target the NEWLY-ADDED cursor (diff against the
                // pre-event selections), not the first empty selection in
                // document order — a pre-existing cursor above the clicked
                // badge used to win.
                const prevPositions = (m.lastSelections ?? []).map(s => ({
                    line: s.active.line,
                    character: s.active.character,
                }));
                const added = addedCursorIndex(
                    prevPositions,
                    e.selections.map(s => ({ line: s.active.line, character: s.active.character }))
                );
                let hit: number | undefined;
                if (added >= 0) {
                    const s = e.selections[added];
                    if (s.isEmpty) {
                        hit = targetFoldStart(s.active);
                    }
                }
                if (hit === undefined) {
                    // Fallback: no detectable new cursor — first empty one.
                    for (const s of e.selections) {
                        if (s.isEmpty) {
                            hit = targetFoldStart(s.active);
                        }
                        if (hit !== undefined) break;
                    }
                }
                if (hit === undefined) return;
                dropRememberedCursorFor(hit);
                autoRestoring = true;
                try {
                    const p = new vscode.Position(hit, editor.document.lineAt(hit).text.length);
                    editor.selections = [new vscode.Selection(p, p)];
                    await vscode.commands.executeCommand('editor.unfoldRecursively');
                    // Keep cursor on the clicked block to prevent visual bounce / flicker
                    editor.selections = [new vscode.Selection(p, p)];
                } finally {
                    autoRestoring = false;
                }
                return;
            }

            if (!c.get<boolean>('clickToExpand', true)) return;
            if (e.selections.length !== 1 || !e.selections[0].isEmpty) return;
            const target = targetFoldStart(e.selections[0].active);
            if (target === undefined) return;
            dropRememberedCursorFor(target);
            await vscode.commands.executeCommand('editor.unfold', {
                levels: 1,
                selectionLines: [target],
            });
        })
    );

    // --- Badge click dead-zone fix -------------------------------------------
    // A badge click only works when it CHANGES the selection. After a fold
    // clamps the cursor to the header-line end, the cursor already sits
    // exactly where the next badge click lands — that click then fires NO
    // selection event at all, so the badge looks "focused" but dead until the
    // user clicks somewhere else first. Whenever folding leaves the cursor
    // resting inside a badge's click zone, nudge it one column back out of
    // the zone. Same line, so the cursor-restore bookkeeping (which compares
    // lines) is unaffected. Top-level comment badges deliberately retain
    // their real comment marker (`/**` / `//`) as a stable caret boundary,
    // so their injected badge is never anchored at VS Code's unreliable
    // column-zero decoration hit-test position.
    const parkCursorOutsideBadge = (editor: vscode.TextEditor): void => {
        if (autoRestoring) return;
        if (editor.selections.length !== 1 || !editor.selection.isEmpty) return;
        const pos = editor.selection.active;
        const ranges = rangesFor(editor.document);
        const folds = currentCollapsedFolds(editor, ranges);
        const fold = folds.find(f => f.header === pos.line);
        if (!fold) return;
        const { hiddenStart } = foldBadge(editor, pos.line, ranges, cfg(), fold.hiddenEnd);
        const threshold = hiddenStart ?? editor.document.lineAt(pos.line).text.length;
        if (pos.character < threshold) return;
        // NEVER park on a different line: the restore probe compares the
        // landed line against the parked line, and a cross-line park made it
        // misread its own probe as an unfold-in-progress — smartUnfold then
        // instantly reopened the block the user had just folded.
        let parked: vscode.Position;
        if (threshold > 0) {
            parked = new vscode.Position(pos.line, Math.max(0, threshold - 1));
        } else {
            // Badge clicks on a FULLY-hidden header line (top-level
            // comments) resolve to column 0 — parking the cursor there made
            // the next click a no-op selection change, so it was swallowed
            // (the dead click). The line END is away from that landing spot
            // but still on the same line.
            parked = new vscode.Position(pos.line, editor.document.lineAt(pos.line).text.length);
        }
        if (pos.line === parked.line && pos.character === parked.character) return;
        autoRestoring = true;
        try {
            editor.selections = [new vscode.Selection(parked, parked)];
        } finally {
            autoRestoring = false;
        }
    };
    let parkTimer: NodeJS.Timeout;
    context.subscriptions.push(
        { dispose: () => clearTimeout(parkTimer) },
        vscode.window.onDidChangeTextEditorVisibleRanges(e => {
            if (autoRestoring) return;
            if (e.textEditor !== vscode.window.activeTextEditor) return;
            clearTimeout(parkTimer);
            parkTimer = setTimeout(() => parkCursorOutsideBadge(e.textEditor), 120);
        })
    );

    // --- Pre-fold cursor tracker ---------------------------------------------
    // THE key fix for "restore cursor doesn't work": when ANY fold swallows the
    // cursor's line (built-in Fold All, gutter fold icons, fold-level commands,
    // our own Fold All…), VS Code CLAMPS the cursor up to the end of the fold
    // header line — e.g. from "} finally {<cursor>" up to
    // "…): Promise<boolean> => {<cursor>". If only our own Fold All command
    // saved the position, folds made any other way lost it forever.
    //
    // So we continuously remember the last selections per editor and detect
    // the fold-induced jump itself: a non-mouse/non-keyboard selection change
    // that moved the cursor UP while its previous line is now hidden INSIDE a
    // fold (not merely scrolled off-screen). The pre-fold selections are then
    // stored for Unfold All / Smart Unfold — no matter how the fold was made.
    const seedLastSelections = (editor: vscode.TextEditor | undefined): void => {
        if (!editor) return;
        mem(editor).lastSelections = cloneSelections(editor.selections);
    };
    for (const editor of vscode.window.visibleTextEditors) seedLastSelections(editor);
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(seedLastSelections),
        vscode.window.onDidChangeTextEditorSelection(e => {
            const editor = e.textEditor;
            const m = mem(editor);
            const prev = m.lastSelections;
            const next = cloneSelections(e.selections);
            m.lastSelections = next;
            if (autoRestoring) return; // our own probe/restore moves
            if (!prev || prev.length === 0 || next.length === 0) return;
            const c = cfg();
            if (
                !c.get<boolean>('rememberCursorOnFoldAll', true) &&
                !c.get<boolean>('smartUnfold', true)
            ) {
                return;
            }
            // Deliberate cursor moves are never fold clamps. They also mean
            // the user chose a new place in the file: once the cursor leaves
            // both the remembered line and the fold-header line it was clamped
            // to, drop the remembered state so a later Unfold All doesn't
            // teleport the user back unexpectedly.
            if (
                e.kind === vscode.TextEditorSelectionChangeKind.Mouse ||
                e.kind === vscode.TextEditorSelectionChangeKind.Keyboard
            ) {
                const state = m.savedState;
                if (state && state.selections.length > 0) {
                    const line = next[0].active.line;
                    const savedLine = state.selections[0].active.line;
                    const clampedLine = state.clampedActive?.line;
                    if (line !== savedLine && line !== clampedLine) {
                        m.savedState = undefined;
                    }
                }
                return;
            }
            const prevActive = prev[0].active;
            const nextActive = next[0].active;
            // A fold clamp always moves the cursor UP (to the fold header line).
            if (nextActive.line >= prevActive.line) {
                return;
            }

            // E-6: the candidate is verified AFTER the folding model settles
            // (60 ms) — a programmatic jump (Go to Definition from a body
            // line to the header line of the SAME range) looks identical to
            // a fold clamp in the instant it happens, but the previous line
            // is then NOT hidden inside a fold (and the range does not reach
            // EOF). Genuine clamps pass exactly one of those two checks, so
            // ordinary upward navigation never arms saved fold state.
            const docVersion = editor.document.version;
            setTimeout(() => {
                if (editor.document.version !== docVersion) {
                    return;
                }
                // Allow same-line nudge from parkCursorOutsideBadge
                const currentActive = editor.selection.active;
                const onSameClampLine = currentActive.line === nextActive.line;
                if (!selectionsEqual(editor.selections, next) && !onSameClampLine) {
                    return;
                }
                const visible = editor.visibleRanges.map(r => ({
                    startLine: r.start.line,
                    endLine: r.end.line,
                }));
                const hidden = lineHiddenByFold(visible, prevActive.line);
                const rs = rangesFor(editor.document);
                
                // Find last non-empty code line to safely handle trailing blank lines near EOF
                let lastCodeLine = editor.document.lineCount - 1;
                while (lastCodeLine > 0 && editor.document.lineAt(lastCodeLine).text.trim().length === 0) {
                    lastCodeLine--;
                }
                const reachesEof = rs.some(
                    r =>
                        r.start === nextActive.line &&
                        prevActive.line > r.start &&
                        prevActive.line <= r.end &&
                        r.end >= lastCodeLine
                );
                if (!hidden && !reachesEof) {
                    return;
                }
                m.savedState = {
                    selections: prev,
                    clampedActive: nextActive,
                    docVersion,
                };
            }, 60);
        })
    );

    // --- Fold All / Unfold All with cursor memory + Smart Unfold -------------
    context.subscriptions.push(
        vscode.commands.registerCommand('smartFolding.foldAll', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const remember = cfg().get<boolean>('rememberCursorOnFoldAll', true);
            // Capture BEFORE folding so we can tell whether a clamp happened.
            const before = cloneSelections(editor.selections);
            await vscode.commands.executeCommand('editor.foldAll');
            if (!remember) return;
            // Give the folding model a moment to clamp the cursor.
            await sleep(100);
            const m = mem(editor);
            // E-4: keep restore state ONLY when the fold actually clamped the
            // cursor (post-fold selection ≠ pre-fold selection). A no-op Fold
            // All previously armed the restore logic unconditionally, and a
            // later mere scroll "restored" the viewport to a stale position.
            if (!selectionsEqual(before, cloneSelections(editor.selections))) {
                m.savedState = {
                    selections: before,
                    clampedActive: editor.selection.active,
                    docVersion: editor.document.version,
                };
            } else {
                m.savedState = undefined;
            }
            // Do not assign the saved selection while its line is hidden. VS Code
            // clamps it to the fold header again (and can emit another selection
            // event), which was the source of the lost/overwritten cursor state.
            // Keep the saved position only in memory; restore it after unfold.
        }),

        vscode.commands.registerCommand('smartFolding.unfoldAll', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            await vscode.commands.executeCommand('editor.unfoldAll');
            const m = mem(editor);
            const state = liveState(editor);
            if (state && cfg().get<boolean>('rememberCursorOnFoldAll', true)) {
                // The folding model applies asynchronously: keep re-applying the
                // selection + scroll until the cursor line is actually rendered.
                restoreView(editor, state.selections);
                let restored = false;
                for (let attempt = 0; attempt < 5; attempt++) {
                    await sleep(40);
                    restoreView(editor, state.selections);
                    if (lineIsRendered(editor, state.selections[0].active.line)) {
                        restored = true;
                        break;
                    }
                }
                // Never discard the remembered position until restoration succeeds.
                if (restored) m.savedState = undefined;
            }
        }),

        vscode.commands.registerCommand('smartFolding.smartUnfold', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            if (!cfg().get<boolean>('smartUnfold', true)) {
                await vscode.commands.executeCommand('editor.unfold');
                return;
            }
            await smartUnfold(editor, 'editor.unfold');
        }),

        // Same focus mode for UNFOLD RECURSIVELY: after a Fold All, this opens
        // the whole parent chain down to the remembered cursor AND — true to
        // its "recursive" nature — the children of the block the cursor is in,
        // while every unrelated block stays folded. Without a remembered
        // position it behaves exactly like the built-in editor.unfoldRecursively.
        vscode.commands.registerCommand('smartFolding.smartUnfoldRecursively', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            if (!cfg().get<boolean>('smartUnfold', true)) {
                await vscode.commands.executeCommand('editor.unfoldRecursively');
                return;
            }
            await smartUnfold(editor, 'editor.unfoldRecursively');
        })
    );

    // --- Restore cursor after ANY unfold — no hardcoded shortcuts -------------
    // This extension contributes NO unfold keybindings: whatever key the user's own
    // keymap binds to Unfold / Unfold Recursively / Unfold All (Alt+W,
    // Ctrl+Shift+=, the Command Palette, a gutter chevron click…), the
    // BUILT-IN command runs and this extension reacts to its effect.
    //
    // VS Code fires no "unfolded" event. Detection is SELF-VERIFYING: while a
    // remembered cursor exists and the cursor is still parked where the fold
    // clamped it, an observed UNFOLD TRANSITION triggers a silent probe that
    // tries to put the selection back on the remembered line:
    //   - It STICKS → every fold hiding the line is open → restore the cursor
    //     (line AND column) + scroll, consume the state.
    //   - It clamps to a DEEPER fold header → the unfold opened the outer
    //     block but the line is still nested-hidden → finish opening the
    //     parent chain (smart unfold), keeping unrelated blocks folded.
    //   - It clamps straight back → unrelated change → put the cursor back
    //     and keep waiting.
    // The probe assigns the selection WITHOUT scrolling, so failed probes are
    // invisible and never hijack the viewport.
    const probeRestore = async (editor: vscode.TextEditor): Promise<void> => {
        const m = mem(editor);
        const state = liveState(editor);
        if (!state || state.selections.length === 0) return;
        const c = cfg();
        if (!c.get<boolean>('rememberCursorOnFoldAll', true)) return;
        if (!c.get<boolean>('restoreOnAnyUnfold', true)) return;
        const saved = state.selections[0].active;
        const parked = editor.selection.active;
        // Only act while the cursor still sits where the fold clamped it — a
        // deliberate move elsewhere already dropped the state (see tracker).
        if (parked.line !== state.clampedActive?.line && parked.line !== saved.line) return;
        // Fast path: the remembered line is already rendered → folds are open.
        if (lineIsRendered(editor, saved.line)) {
            m.savedState = undefined;
            restoreView(editor, state.selections);
            return;
        }

        // E-5: gate on the STATE SIGNAL ("did an unfold actually happen?"),
        // not on viewport-relative visibility. The old gate — "is
        // clampLine+1 rendered" — silently skipped restoration whenever the
        // user had scrolled the clamp line away, then surprised them with a
        // delayed smartUnfold when they scrolled back.
        if (!m.unfoldSignal) return;
        m.unfoldSignal = false;

        autoRestoring = true;
        try {
            editor.selections = cloneSelections(state.selections);
            await sleep(30);
            const landedLine = editor.selection.active.line;
            if (landedLine === saved.line) {
                // The selection stuck → folds are open → the restore itself
                // already succeeded. Consume the state IMMEDIATELY: holding it
                // until the line scrolled into view meant every later scroll
                // event re-probed and yanked the viewport back up (the
                // "can't scroll down after Unfold All" jump).
                m.savedState = undefined;
                restoreView(editor, state.selections);
                for (let attempt = 0; attempt < 4; attempt++) {
                    await sleep(30);
                    if (lineIsRendered(editor, saved.line)) break;
                    restoreView(editor, state.selections);
                }
                return;
            } else if (
                landedLine > (state.clampedActive?.line ?? parked.line) &&
                landedLine <= saved.line &&
                !lineIsRendered(editor, saved.line) &&
                c.get<boolean>('smartUnfold', true)
            ) {
                // Clamped to a DIFFERENT, deeper fold header → the user's
                // unfold opened the outer block → finish the parent chain.
                await smartUnfold(editor);
                if (m.savedState === undefined) return; // consumed on success
            }
            // Not restorable yet — park the cursor back where it was and keep
            // the remembered state for the next unfold.
            editor.selections = [new vscode.Selection(parked, parked)];
        } finally {
            autoRestoring = false;
        }
        // The parked position sits inside the badge's click zone — nudge the
        // cursor out so the next badge click still fires a selection event.
        parkCursorOutsideBadge(editor);
    };

    let probeTimer: NodeJS.Timeout;
    context.subscriptions.push(
        { dispose: () => clearTimeout(probeTimer) },
        vscode.window.onDidChangeTextEditorVisibleRanges(e => {
            if (autoRestoring) return;
            const editor = e.textEditor;
            if (editor !== vscode.window.activeTextEditor) return;
            const m = mem(editor);
            const cur = e.visibleRanges.map(r => ({
                startLine: r.start.line,
                endLine: r.end.line,
            }));
            const prev = m.lastVisible ?? [];
            m.lastVisible = cur;
            // E-5: an unfold MERGES previously separated visible ranges (or
            // reveals a fold-hidden gap in place); a fold or plain scroll
            // never does. This is the state signal the probe gates on.
            if (cur.length < prev.length || unfoldRevealedGapLines(prev, cur)) {
                m.unfoldSignal = true;
            }
            if (!m.savedState) return;
            // Fold/unfold transitions fire bursts of events — debounce, then
            // probe once the folding model has settled.
            clearTimeout(probeTimer);
            probeTimer = setTimeout(() => void probeRestore(editor), 80);
        })
    );

    // --- (b) + (b.1) WebStorm-style folding ranges ---------------------------
    // Single-line folds (closing bracket folded away), configurable.
    //
    // The provider below is the SOLE folding source for takeover languages
    // (see `editor.defaultFoldingRangeProvider`, applied by
    // ensureDefaultFoldingProvider): it returns a unified, deterministic
    // folding model — native-equivalent ranges from the same bracket scanner
    // the parity harness checks (singleLineFolds=false reproduces tsserver
    // outlining spans) PLUS the intentional WebStorm differences (single-line
    // closing-bracket behavior, comment runs, and other scanner extras).
    // Same-start conflicts are resolved inside computeFoldingRanges by
    // deterministic dedup/merging, never by provider registration order.
    const provider: vscode.FoldingRangeProvider = {
        onDidChangeFoldingRanges: foldingRangesChanged.event,
        provideFoldingRanges(document) {
            return rangesFor(document).map(
                r =>
                    new vscode.FoldingRange(
                        r.start,
                        r.end,
                        r.kind === 'comment'
                            ? vscode.FoldingRangeKind.Comment
                            : r.kind === 'region'
                              ? vscode.FoldingRangeKind.Region
                              : r.kind === 'imports'
                                ? vscode.FoldingRangeKind.Imports
                                : undefined
                    )
            );
        },
    };

    let providerRegistration: vscode.Disposable | undefined;
    const registerProvider = () => {
        providerRegistration?.dispose();
        providerRegistration = undefined;
        // F-13: languages with unmodeled multiline literals (C/C++/C#/Java/PHP)
        // keep NATIVE folding — do not register our provider for them at all.
        const languages = takeoverLanguages(cfg().get<string[]>('languages', []));
        if (languages.length > 0) {
            providerRegistration = vscode.languages.registerFoldingRangeProvider(
                languages,
                provider
            );
        }
    };

    registerProvider();
    context.subscriptions.push(
        {
            dispose: () => {
                providerRegistration?.dispose();
            },
        }
    );

    // The takeover route (VS Code ≥1.73): `editor.defaultFoldingRangeProvider`
    // makes this extension the ONLY folding source for the configured
    // languages, so folds are guaranteed to look like WebStorm (single-line).
    // The provider returns the unified native-equivalent + Smart model, so no
    // second provider is needed for correctness.
    void ensureDefaultFoldingProvider(context);
}

/**
 * Enforce (or release) `editor.defaultFoldingRangeProvider` according to the
 * `smartFolding.takeOverFolding` setting:
 *
 * - take-over ON  + setting unset            → point it at this extension.
 * - take-over ON  + user chose ANOTHER one   → respect the user's choice.
 * - take-over OFF + setting points at us     → clear it back to the default.
 *
 * F-13: languages with unmodeled multiline literals are filtered OUT — native
 * folding remains active for them.
 *
 * E-11: cleanup is ownership-aware (only values that point at THIS extension
 * are touched — never a newer user change). E-12: the whole operation is
 * failure-tolerant (read-only profiles, remote scenarios).
 */
/**
 * F-E: extension IDs compare case-insensitively in VS Code (a user can type
 * `seymi.smart-folding` and it still selects this extension), so ownership
 * checks must ignore case — a strict compare left such overrides behind.
 */
function isOurProviderId(id: string | undefined): boolean {
    return id !== undefined && id.toLowerCase() === EXTENSION_ID.toLowerCase();
}

async function ensureDefaultFoldingProvider(context?: vscode.ExtensionContext): Promise<void> {
    try {
        const c = vscode.workspace.getConfiguration('smartFolding');
        const takeOver = c.get<boolean>('takeOverFolding', true);
        const languages = takeoverLanguages(c.get<string[]>('languages', []));

        // Clean up any legacy global override set by previous versions
        const globalEditorCfg = vscode.workspace.getConfiguration('editor');
        if (isOurProviderId(globalEditorCfg.get<string>('defaultFoldingRangeProvider'))) {
            await globalEditorCfg.update(
                'defaultFoldingRangeProvider',
                undefined,
                vscode.ConfigurationTarget.Global
            );
        }

        // Apply or remove language-scoped overrides. `inspect` distinguishes an
        // explicit user override from an inherited default: only write when no
        // explicit value exists, and only clear what this extension set.
        for (const lang of languages) {
            const langCfg = vscode.workspace.getConfiguration('editor', { languageId: lang });
            const inspected = langCfg.inspect<string>('defaultFoldingRangeProvider');
            // Language-scoped writes land in `[lang]` sections, which `inspect`
            // reports via the *LanguageValue fields — `globalValue` stays
            // undefined for them, so it must not be consulted first.
            const explicit =
                inspected?.globalLanguageValue ??
                inspected?.workspaceLanguageValue ??
                inspected?.workspaceFolderLanguageValue ??
                inspected?.globalValue ??
                inspected?.workspaceValue ??
                inspected?.workspaceFolderValue;

            if (takeOver) {
                if (!explicit) {
                    await langCfg.update(
                        'defaultFoldingRangeProvider',
                        EXTENSION_ID,
                        vscode.ConfigurationTarget.Global,
                        true
                    );
                }
            } else if (isOurProviderId(explicit)) {
                await langCfg.update(
                    'defaultFoldingRangeProvider',
                    undefined,
                    vscode.ConfigurationTarget.Global,
                    true
                );
            }
        }

        // Orphan cleanup: a language removed from `smartFolding.languages` keeps
        // a `[lang]` override in settings.json unless it is cleared. Track every
        // language this extension ever configured and clear entries that are no
        // longer wanted.
        if (context) {
            const key = 'smartFolding.configuredTakeOverLanguages';
            const previous = context.globalState.get<string[]>(key, []);
            const wanted = new Set<string>(takeOver ? languages : []);
            for (const lang of previous) {
                if (!wanted.has(lang)) {
                    const langCfg = vscode.workspace.getConfiguration('editor', {
                        languageId: lang,
                    });
                    const inspected = langCfg.inspect<string>('defaultFoldingRangeProvider');
                    const explicit =
                        inspected?.globalLanguageValue ??
                        inspected?.workspaceLanguageValue ??
                        inspected?.workspaceFolderLanguageValue ??
                        inspected?.globalValue ??
                        inspected?.workspaceValue ??
                        inspected?.workspaceFolderValue;
                    if (isOurProviderId(explicit)) {
                        await langCfg.update(
                            'defaultFoldingRangeProvider',
                            undefined,
                            vscode.ConfigurationTarget.Global,
                            true
                        );
                    }
                }
            }
            await context.globalState.update(key, takeOver ? languages : []);
        }
    } catch {
        // E-12: read-only profiles / remote scenarios — degrade gracefully.
    }
}

export function deactivate(): Thenable<void> | void {
    // E-11: best-effort cleanup of the transparent placeholder color this
    // extension wrote into GLOBAL settings. Ownership-aware: only our own
    // transparent value is removed — a user-modified value is left untouched.
    // (Language-scoped defaultFoldingRangeProvider entries are cleaned up on
    // the next activation; the extension host may not survive awaiting
    // settings writes during uninstall.)
    if (!ownedPlaceholderColor) {
        return;
    }
    try {
        const workbench = vscode.workspace.getConfiguration('workbench');
        const inspected = workbench.inspect<Record<string, unknown>>('colorCustomizations');
        const colors = inspected?.globalValue;
        if (colors && colors[PLACEHOLDER_COLOR] === TRANSPARENT_COLOR) {
            const next: Record<string, unknown> = { ...colors };
            delete next[PLACEHOLDER_COLOR];
            return workbench
                .update('colorCustomizations', next, vscode.ConfigurationTarget.Global)
                .then(
                    () => undefined,
                    () => undefined
                );
        }
    } catch {
        // Best effort only.
    }
}

/**
 * Collapsed folds for the editor, bridged over the viewport's bottom edge.
 *
 * Gap detection only SEES a collapsed fold once something below it is
 * scrolled into view. While a fold's header sits at the very BOTTOM of the
 * viewport, a collapsed fold and the viewport simply ending look identical —
 * so the badge used to vanish mid-scroll and the hidden `{` popped back in.
 * Folds are therefore remembered per editor while collapsed and trusted again
 * exactly in that ambiguous bottom-edge case (E-2: the memory is per editor,
 * not per document URI). A remembered fold is forgotten as soon as any of its
 * hidden lines is actually rendered (i.e. it was opened) or the document
 * changes.
 */
function currentCollapsedFolds(
    editor: vscode.TextEditor,
    ranges: SimpleFoldingRange[]
): CollapsedFold[] {
    const visible = editor.visibleRanges.map(r => ({
        startLine: r.start.line,
        endLine: r.end.line,
    }));
    const detected = collapsedFolds(visible, ranges, editor.document.lineCount);
    const m = mem(editor);
    const version = editor.document.version;
    const prev = m.rememberedFolds;
    const remembered = prev && prev.version === version ? prev.folds : [];

    const hiddenRegionRendered = (f: CollapsedFold): boolean =>
        visible.some(v => Math.max(v.startLine, f.header + 1) <= Math.min(v.endLine, f.hiddenEnd));
    const kept = remembered.filter(
        f => !detected.some(d => d.header === f.header) && !hiddenRegionRendered(f)
    );

    const folds = [...detected];
    const lastLine = visible.length > 0 ? visible[visible.length - 1].endLine : -1;
    for (const f of kept) {
        if (f.header === lastLine) folds.push(f);
    }
    folds.sort((a, b) => a.header - b.header);

    m.rememberedFolds = { version, folds: [...detected, ...kept] };
    return folds;
}

/**
 * How the collapsed fold starting at `line` is rendered: the badge text plus
 * the column from which the header line's own text is visually hidden so the
 * badge can take its place (undefined = nothing hidden, the badge simply
 * follows the line end). Shared by the renderer and the click handler so the
 * clickable area always matches what is drawn. T-5: the decision logic lives
 * in core (`computeFoldBadge`) and is unit-tested.
 */
function foldBadge(
    editor: vscode.TextEditor,
    line: number,
    ranges: SimpleFoldingRange[],
    c: vscode.WorkspaceConfiguration,
    hiddenEnd?: number
): { contentText: string; hiddenStart?: number; visibleMarkerEnd?: number; noMargin?: boolean } {
    // The range matching the ACTUALLY hidden region decides how the collapsed
    // block is rendered. Requiring the exact end line keeps the fancy badges
    // honest: when the active fold came from another folding provider and
    // hides a DIFFERENT region than our range, pretending it was ours painted
    // the ellipsis in the wrong place. Such folds get the plain badge.
    const range = ranges.find(
        r => r.start === line && (hiddenEnd === undefined || r.end === hiddenEnd)
    );
    if (!range) return { contentText: ' ··· ' };

    let previewText = '';
    if (range.kind === 'comment' && c.get<boolean>('commentPreview', true)) {
        const previewLength = Math.max(4, c.get<number>('commentPreviewLength', 60));
        const commentLines: string[] = [];
        const lastLine = Math.min(range.end, editor.document.lineCount - 1);
        for (let l = range.start; l <= lastLine; l++) {
            commentLines.push(editor.document.lineAt(l).text);
        }
        previewText = commentPreviewText(commentLines, previewLength);
    }
    let closingLineText: string | undefined;
    if (hiddenEnd !== undefined && hiddenEnd > line && hiddenEnd < editor.document.lineCount) {
        closingLineText = editor.document.lineAt(hiddenEnd).text;
    }
    return computeFoldBadge({
        lineText: editor.document.lineAt(line).text,
        kind: range.kind,
        previewText,
        commentPreviewEnabled: c.get<boolean>('commentPreview', true),
        singleLineFolding: c.get<boolean>('singleLineFolding', true),
        hideOpeningBracket: c.get<boolean>('hideOpeningBracket', true),
        closingLineText,
    });
}

function updateEllipsisDecorations(editor: vscode.TextEditor, enabled: boolean): void {
    if (!ellipsisDecoration) return;
    if (!enabled) {
        editor.setDecorations(ellipsisDecoration, []);
        if (commentMarkerDecoration) editor.setDecorations(commentMarkerDecoration, []);
        if (hiddenBracketDecoration) editor.setDecorations(hiddenBracketDecoration, []);
        return;
    }

    const c = vscode.workspace.getConfiguration('smartFolding');
    const ranges = rangesFor(editor.document);
    const folds = currentCollapsedFolds(editor, ranges);

    const badges: vscode.DecorationOptions[] = [];
    const visibleCommentMarkers: vscode.Range[] = [];
    const hiddenRanges: vscode.Range[] = [];
    for (const { header: line, hiddenEnd } of folds) {
        const end = editor.document.lineAt(line).range.end;
        const { contentText, hiddenStart, visibleMarkerEnd, noMargin } = foldBadge(
            editor,
            line,
            ranges,
            c,
            hiddenEnd
        );
        if (hiddenStart !== undefined) {
            hiddenRanges.push(new vscode.Range(new vscode.Position(line, hiddenStart), end));
        }
        if (visibleMarkerEnd !== undefined) {
            visibleCommentMarkers.push(
                new vscode.Range(
                    new vscode.Position(line, 0),
                    new vscode.Position(line, visibleMarkerEnd)
                )
            );
        }

        const hover = new vscode.MarkdownString(
            `[$(unfold) Expand](command:smartFolding.expandHere?${encodeURIComponent(
                JSON.stringify([line])
            )} "Expand this folded block")`
        );
        hover.isTrusted = true;
        // Anchoring the badge at the first HIDDEN column (instead of the
        // line end) keeps it flush after the visible code and makes it render
        // BEFORE other extensions' end-of-line decorations — e.g. GitLens
        // inline blame no longer squeezes in before the {...} badge.
        // The anchor must sit exactly at the START boundary of the hidden
        // span: anchoring strictly INSIDE it (e.g. column 1 of a fully
        // hidden line) inherits the span's `display: none` and the badge
        // vanishes entirely. Clicks on the injected badge resolve to this
        // anchor position — the cursor park logic keeps the cursor away
        // from it so those clicks always fire a selection event.
        const anchor = hiddenStart !== undefined ? new vscode.Position(line, hiddenStart) : end;
        badges.push({
            range: new vscode.Range(anchor, anchor),
            hoverMessage: hover,
            renderOptions:
                visibleMarkerEnd !== undefined
                    ? {
                          after: {
                              contentText,
                              // Join the injected preview to the decorated real
                              // marker. It remains two rendering primitives only
                              // internally; visually it is one rounded badge.
                              margin: '0',
                              textDecoration:
                                  'none; border-radius: 0 4px 4px 0; padding: 0 5px 0 0; cursor: pointer;',
                          },
                      }
                    : hiddenStart !== undefined
                      ? {
                            after: noMargin ? { contentText, margin: '0' } : { contentText },
                        }
                      : {
                            before: { contentText },
                        },
        });
    }

    editor.setDecorations(ellipsisDecoration, badges);
    if (commentMarkerDecoration) {
        editor.setDecorations(commentMarkerDecoration, visibleCommentMarkers);
    }
    if (hiddenBracketDecoration) editor.setDecorations(hiddenBracketDecoration, hiddenRanges);
}

/** Restore selections (line AND column) and scroll the cursor into view. */
function restoreView(editor: vscode.TextEditor, selections: vscode.Selection[]): void {
    if (selections.length === 0) return;
    editor.selections = selections;
    const active = selections[0].active;
    editor.revealRange(
        new vscode.Range(active, active),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport
    );
}

/** Is the line currently rendered on screen (i.e. not hidden inside a fold and inside the viewport)? */
function lineIsRendered(editor: vscode.TextEditor, line: number): boolean {
    return editor.visibleRanges.some(r => line >= r.start.line && line <= r.end.line);
}

/**
 * WebStorm-style "expand parents at cursor": recursively unfolds ONLY the
 * chain of blocks containing the remembered (or current) cursor position —
 * from the top level down to the innermost — leaving every unrelated block
 * collapsed, then restores the cursor (line AND column) and scrolls it into
 * view.
 *
 * Robustness fixes vs. the previous version:
 * - The remembered state is only consumed AFTER the cursor line is actually
 *   rendered again (a failed attempt no longer loses the cursor).
 * - Ancestors are unfolded through TWO independent routes per attempt:
 *   `editor.unfold direction:"up"` on the editor's real folding model, plus
 *   explicit unfolds at each ancestor start line computed by our own scanner
 *   (outermost → innermost) — whichever model is active, the chain opens.
 * - Selection & scroll are re-applied after the folding model settles.
 */
async function smartUnfold(
    editor: vscode.TextEditor,
    fallbackCommand: 'editor.unfold' | 'editor.unfoldRecursively' = 'editor.unfold'
): Promise<void> {
    const m = mem(editor);
    const state = liveState(editor);

    const selections = state?.selections ?? cloneSelections(editor.selections);
    if (selections.length === 0) {
        await vscode.commands.executeCommand(fallbackCommand);
        return;
    }
    const target = selections[0].active;

    // No remembered state and the cursor line is already visible on screen →
    // behave exactly like the built-in unfold.
    if (!state && lineIsRendered(editor, target.line)) {
        await vscode.commands.executeCommand(fallbackCommand);
        return;
    }

    // Put the cursor back first so folding commands target the right spot.
    editor.selections = selections;

    // Ancestor chain (start lines, outermost first) from our own scanner —
    // used as an explicit second route in case `direction: "up"` misses.
    const ranges = rangesFor(editor.document);
    const ancestorStartLines = unfoldPathForLine(ranges, target.line);

    let restored = false;
    for (let attempt = 0; attempt < 6; attempt++) {
        // Route 1: unfold the region containing the line AND all of its ancestor
        // regions on VS Code's REAL folding model (works for brackets, #region
        // markers, comment/import folds and indentation folds alike).
        await vscode.commands.executeCommand('editor.unfold', {
            direction: 'up',
            levels: 999,
            selectionLines: [target.line],
        });
        // Route 2: explicitly unfold every ancestor at its start line,
        // outermost → innermost.
        if (ancestorStartLines.length > 0) {
            await vscode.commands.executeCommand('editor.unfold', {
                levels: 1,
                selectionLines: ancestorStartLines,
            });
        }
        // Recursive flavor: additionally expand the innermost block's own
        // children (WebStorm's "Expand Recursively"), still leaving every
        // unrelated sibling block collapsed.
        if (fallbackCommand === 'editor.unfoldRecursively') {
            await vscode.commands.executeCommand('editor.unfoldRecursively', {
                selectionLines: [target.line],
            });
        }
        restoreView(editor, selections);
        // Give the folding model a moment to apply before checking visibility.
        await sleep(30);
        if (lineIsRendered(editor, target.line)) {
            restored = true;
            break;
        }
    }

    // Only consume the remembered cursor once it was successfully restored.
    if (restored) m.savedState = undefined;

    restoreView(editor, selections);
}
