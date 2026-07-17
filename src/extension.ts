import * as vscode from 'vscode';
import {
    CollapsedFold,
    collapsedFolds,
    commentPreviewText,
    computeFoldingRanges,
    isLikelyFoldClamp,
    lineHiddenByFold,
    resolveEllipsisBackground,
    resolveEllipsisColor,
    SimpleFoldingRange,
    unfoldPathForLine,
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
 * selection and fold event.
 */
const rangeCache = new Map<
    string,
    { version: number; optsKey: string; ranges: SimpleFoldingRange[] }
>();

function rangesFor(document: vscode.TextDocument): SimpleFoldingRange[] {
    const c = vscode.workspace.getConfiguration('smartFolding');
    const opts = {
        singleLineFolds: c.get<boolean>('singleLineFolding', true),
        keepFunctionParamsVisible: c.get<boolean>('keepFunctionParamsVisible', true),
        foldComments: c.get<boolean>('foldComments', true),
    };
    const optsKey = `${opts.singleLineFolds}|${opts.keepFunctionParamsVisible}|${opts.foldComments}`;
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
 * Cursor/selection state remembered per document when the user runs
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
}

const savedStates = new Map<string, SavedFoldState>();

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

export function activate(context: vscode.ExtensionContext): void {
    // Resolve the real extension ID at runtime (rename-proof).
    EXTENSION_ID = context.extension.id;

    const cfg = () => vscode.workspace.getConfiguration('smartFolding');

    // Set while this extension itself is moving the selection (restore probe,
    // smart unfold, modifier-click expand) so the selection handlers below
    // ignore those synthetic events.
    let autoRestoring = false;

    // --- (4) Hide VS Code's native `···` fold placeholder --------------------
    // No decoration/extension API can suppress the built-in collapsed-text
    // indicator, but its THEME COLOR (`editor.foldPlaceholderForeground`,
    // VS Code ≥ 1.81) can be made fully transparent. Managed in the user's
    // global `workbench.colorCustomizations`: an existing user-set color is
    // never overwritten, and only our own transparent value is ever removed.
    const PLACEHOLDER_COLOR = 'editor.foldPlaceholderForeground';
    const TRANSPARENT_COLOR = '#00000000';
    const syncNativePlaceholder = async (): Promise<void> => {
        const hide = vscode.workspace
            .getConfiguration('smartFolding')
            .get<boolean>('hideNativeFoldPlaceholder', true);
        const workbench = vscode.workspace.getConfiguration('workbench');
        const colors = workbench.get<Record<string, unknown>>('colorCustomizations') ?? {};
        try {
            if (hide && colors[PLACEHOLDER_COLOR] === undefined) {
                await workbench.update(
                    'colorCustomizations',
                    { ...colors, [PLACEHOLDER_COLOR]: TRANSPARENT_COLOR },
                    vscode.ConfigurationTarget.Global
                );
            } else if (!hide && colors[PLACEHOLDER_COLOR] === TRANSPARENT_COLOR) {
                const next: Record<string, unknown> = { ...colors };
                delete next[PLACEHOLDER_COLOR];
                await workbench.update(
                    'colorCustomizations',
                    next,
                    vscode.ConfigurationTarget.Global
                );
            }
        } catch {
            // Writing user settings can fail (read-only profile) — non-fatal.
        }
    };
    void syncNativePlaceholder();

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

        return vscode.window.createTextEditorDecorationType({
            after: {
                // contentText comes from each decoration INSTANCE (the badge
                // text differs per fold). Defining it here TOO made VS Code
                // render a second ' ··· ' badge next to every {...} badge.
                margin: '0 0 0 0.5ch',
                fontWeight: 'bold',
                // CSS injection via textDecoration — a well-known decoration trick to
                // get rounded corners, padding and a pointer cursor.
                textDecoration: 'none; border-radius: 4px; padding: 0 5px; cursor: pointer;',
            },
            // VS Code automatically applies the block matching the active theme
            // kind, so the badge can be styled independently for dark & light.
            dark: { after: { backgroundColor: darkBackground, color: darkColor } },
            light: { after: { backgroundColor: lightBackground, color: lightColor } },
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
                e.affectsConfiguration('smartFolding.keepFunctionParamsVisible') ||
                e.affectsConfiguration('smartFolding.foldComments')
            ) {
                foldingRangesChanged.fire();
            }
            if (e.affectsConfiguration('smartFolding.hideNativeFoldPlaceholder')) {
                void syncNativePlaceholder();
            }
            if (e.affectsConfiguration('smartFolding.takeOverFolding')) {
                void ensureDefaultFoldingProvider();
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
            const ranges = rangesFor(editor.document);
            const folds = currentCollapsedFolds(editor, ranges);
            if (folds.length === 0) return;
            // Where did the click actually land? Clicking the badge of a
            // collapsed row does NOT reliably put the cursor on the header
            // line: VS Code may map a click on/past injected text to the END
            // of the folded (hidden) content instead. Both cases resolve to
            // the fold's header line here \u2014 relying on the header line only
            // was the "clicking {...} doesn't unfold" bug.
            const targetFoldStart = (p: vscode.Position): number | undefined => {
                const asHeader = folds.find(f => f.header === p.line);
                if (asHeader) {
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
                return folds.find(f => p.line > f.header && p.line <= f.hiddenEnd)?.header;
            };

            // Modifier+click: VS Code exposes no modifier keys on mouse
            // events, but the multi-cursor modifier ADDS a cursor — a mouse
            // selection event with 2+ selections. When the added cursor sits
            // on a collapsed fold's badge, treat it as modifier+click: drop
            // the extra cursor and expand that block recursively.
            if (
                e.selections.length >= 2 &&
                c.get<boolean>('modifierClickExpandsRecursively', true)
            ) {
                let hit: number | undefined;
                for (const s of e.selections) {
                    if (s.isEmpty) hit = targetFoldStart(s.active);
                    if (hit !== undefined) break;
                }
                if (hit === undefined) return;
                autoRestoring = true;
                try {
                    const p = new vscode.Position(hit, editor.document.lineAt(hit).text.length);
                    editor.selections = [new vscode.Selection(p, p)];
                    // editor.unfoldRecursively ignores selectionLines args —
                    // it acts on the current selection, set just above.
                    await vscode.commands.executeCommand('editor.unfoldRecursively');
                } finally {
                    autoRestoring = false;
                }
                return;
            }

            if (!c.get<boolean>('clickToExpand', true)) return;
            if (e.selections.length !== 1 || !e.selections[0].isEmpty) return;
            const target = targetFoldStart(e.selections[0].active);
            if (target === undefined) return;
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
    // So we continuously remember the last selections per document and detect
    // the fold-induced jump itself: a non-mouse/non-keyboard selection change
    // that moved the cursor UP while its previous line is now hidden INSIDE a
    // fold (not merely scrolled off-screen). The pre-fold selections are then
    // stored for Unfold All / Smart Unfold — no matter how the fold was made.
    const lastSelections = new Map<string, vscode.Selection[]>();
    const seedLastSelections = (editor: vscode.TextEditor | undefined): void => {
        if (!editor) return;
        lastSelections.set(editor.document.uri.toString(), cloneSelections(editor.selections));
    };
    for (const editor of vscode.window.visibleTextEditors) seedLastSelections(editor);
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(seedLastSelections),
        vscode.window.onDidChangeTextEditorSelection(e => {
            const editor = e.textEditor;
            const key = editor.document.uri.toString();
            const prev = lastSelections.get(key);
            const next = cloneSelections(e.selections);
            lastSelections.set(key, next);
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
                const state = savedStates.get(key);
                if (state && state.selections.length > 0) {
                    const line = next[0].active.line;
                    const savedLine = state.selections[0].active.line;
                    const clampedLine = state.clampedActive?.line;
                    if (line !== savedLine && line !== clampedLine) {
                        savedStates.delete(key);
                    }
                }
                return;
            }
            const prevActive = prev[0].active;
            const nextActive = next[0].active;
            // A fold clamp always moves the cursor UP (to the fold header line).
            if (nextActive.line >= prevActive.line) return;

            // Detect the clamp from the folding ranges themselves. This is the
            // reliable path for folds at EOF and for old cursor lines outside the
            // viewport, where `visibleRanges` cannot distinguish folded from merely
            // scrolled-away text.
            const ranges = rangesFor(editor.document);
            if (isLikelyFoldClamp(ranges, prevActive.line, nextActive.line)) {
                savedStates.set(key, { selections: prev, clampedActive: nextActive });
                return;
            }

            const docVersion = editor.document.version;
            // The folding model / visibleRanges apply asynchronously — verify
            // shortly afterwards, once the hidden areas are final.
            setTimeout(() => {
                if (editor.document.version !== docVersion) return; // text changed — not a pure fold
                if (!selectionsEqual(editor.selections, next)) return; // cursor moved again since
                const visible = editor.visibleRanges.map(r => ({
                    startLine: r.start.line,
                    endLine: r.end.line,
                }));
                if (!lineHiddenByFold(visible, prevActive.line)) return;
                savedStates.set(key, { selections: prev, clampedActive: nextActive });
            }, 60);
        })
    );

    // --- Fold All / Unfold All with cursor memory + Smart Unfold -------------
    context.subscriptions.push(
        vscode.commands.registerCommand('smartFolding.foldAll', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const remember = cfg().get<boolean>('rememberCursorOnFoldAll', true);
            const saved = cloneSelections(editor.selections);
            if (remember) {
                savedStates.set(editor.document.uri.toString(), { selections: saved });
            }
            await vscode.commands.executeCommand('editor.foldAll');
            if (remember) {
                // Give the folding model a moment to clamp the cursor, then
                // record the clamp position (the fold header). Deliberate
                // moves away from it later invalidate the remembered state.
                await sleep(40);
                const state = savedStates.get(editor.document.uri.toString());
                if (state && !state.clampedActive) {
                    state.clampedActive = editor.selection.active;
                }
            }
            // Do not assign the saved selection while its line is hidden. VS Code
            // clamps it to the fold header again (and can emit another selection
            // event), which was the source of the lost/overwritten cursor state.
            // Keep the saved position only in `savedStates`; restore it after unfold.
        }),

        vscode.commands.registerCommand('smartFolding.unfoldAll', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            await vscode.commands.executeCommand('editor.unfoldAll');
            const key = editor.document.uri.toString();
            const state = savedStates.get(key);
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
                if (restored) savedStates.delete(key);
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
    // This extension contributes NO keybindings: whatever key the user's own
    // keymap binds to Unfold / Unfold Recursively / Unfold All (Alt+W,
    // Ctrl+Shift+=, the Command Palette, a gutter chevron click…), the
    // BUILT-IN command runs and this extension reacts to its effect.
    //
    // VS Code fires no "unfolded" event. Comparing consecutive visible-range
    // snapshots (the previous approach) broke whenever the unfold and its
    // follow-up reveal-scroll arrived as SEPARATE events — which is exactly
    // why restore only worked for blocks that happened to be near the
    // viewport after the unfold. Detection is now SELF-VERIFYING instead:
    //
    // While a remembered cursor exists and the cursor is still parked where
    // the fold clamped it, every viewport change runs a silent probe that
    // tries to put the selection back on the remembered line:
    //   - It STICKS → every fold hiding the line is open (fold-hidden lines
    //     can never be selected — only a real unfold makes this possible) →
    //     restore the cursor (line AND column) + scroll, consume the state.
    //   - It clamps to a DEEPER fold header → the unfold opened the outer
    //     block but the line is still nested-hidden → finish opening the
    //     parent chain (smart unfold), keeping unrelated blocks folded.
    //   - It clamps straight back → unrelated unfold or plain scrolling →
    //     put the cursor back and keep waiting.
    // The probe assigns the selection WITHOUT scrolling, so failed probes are
    // invisible and never hijack the viewport.
    const probeRestore = async (editor: vscode.TextEditor): Promise<void> => {
        const key = editor.document.uri.toString();
        const state = savedStates.get(key);
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
            savedStates.delete(key);
            restoreView(editor, state.selections);
            return;
        }

        // Do not probe merely because the viewport changed after a FOLD.
        // Assigning a selection into a still-hidden line is not a harmless
        // query: VS Code clamps it to the deepest visible fold header. The old
        // probe interpreted that clamp as unfold progress and immediately
        // smart-unfolded the block that had just been folded. A real unfold of
        // the clamping fold necessarily renders its first body line; scrolling
        // (and a freshly collapsed fold) does not. Gate every mutating probe on
        // that observable transition instead of guessing from missing nested
        // ranges, which are absent simply because their parent is collapsed.
        const clampLine = state.clampedActive?.line;
        if (
            clampLine !== undefined &&
            clampLine + 1 < editor.document.lineCount &&
            !lineIsRendered(editor, clampLine + 1)
        ) {
            return;
        }

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
                savedStates.delete(key);
                restoreView(editor, state.selections);
                for (let attempt = 0; attempt < 4; attempt++) {
                    await sleep(30);
                    if (lineIsRendered(editor, saved.line)) break;
                    restoreView(editor, state.selections);
                }
                return;
            } else if (
                landedLine > (clampLine ?? parked.line) &&
                landedLine <= saved.line &&
                !lineIsRendered(editor, saved.line) &&
                c.get<boolean>('smartUnfold', true)
            ) {
                // Clamped to a DIFFERENT, deeper fold header → the user's
                // unfold opened the outer block → finish the parent chain.
                await smartUnfold(editor);
                if (!savedStates.has(key)) return; // consumed on success
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
            if (!savedStates.has(editor.document.uri.toString())) return;
            // Fold/unfold transitions fire bursts of events — debounce, then
            // probe once the folding model has settled.
            clearTimeout(probeTimer);
            probeTimer = setTimeout(() => void probeRestore(editor), 80);
        })
    );

    // --- (b) + (b.1) WebStorm-style folding ranges ---------------------------
    // Single-line folds (closing bracket folded away) and parameter lists kept
    // visible, both configurable.
    //
    // VS Code merges folding ranges from ALL providers (the built-in language
    // provider included) and, when two ranges start on the same line, the MOST
    // RECENTLY registered provider wins. Built-in language providers register
    // lazily when a language first loads — usually AFTER extension activation —
    // which silently demoted our ranges. Two defenses:
    //   1. `takeOverFolding` (default ON) sets `editor.defaultFoldingRangeProvider`
    //      to this extension — the GUARANTEED fix (see ensureDefaultFoldingProvider).
    //   2. The delayed re-registration below keeps our provider the most recent
    //      as a fallback when take-over is disabled.
    const provider: vscode.FoldingRangeProvider = {
        onDidChangeFoldingRanges: foldingRangesChanged.event,
        provideFoldingRanges(document) {
            return rangesFor(document).map(
                r =>
                    new vscode.FoldingRange(
                        r.start,
                        r.end,
                        r.kind === 'comment' ? vscode.FoldingRangeKind.Comment : undefined
                    )
            );
        },
    };

    let providerRegistration: vscode.Disposable | undefined;
    const registerProvider = () => {
        providerRegistration?.dispose();
        providerRegistration = undefined;
        const languages = cfg().get<string[]>('languages', []);
        if (languages.length > 0) {
            providerRegistration = vscode.languages.registerFoldingRangeProvider(
                languages,
                provider
            );
        }
    };

    let reRegisterTimer: NodeJS.Timeout;
    const scheduleReRegister = () => {
        clearTimeout(reRegisterTimer);
        const delay = Math.max(0, cfg().get<number>('providerDelay', 2000));
        reRegisterTimer = setTimeout(registerProvider, delay);
    };

    registerProvider();
    scheduleReRegister();
    context.subscriptions.push(
        {
            dispose: () => {
                clearTimeout(reRegisterTimer);
                providerRegistration?.dispose();
            },
        },
        vscode.workspace.onDidOpenTextDocument(document => {
            const languages = cfg().get<string[]>('languages', []);
            if (languages.includes(document.languageId)) scheduleReRegister();
        })
    );

    // The bullet-proof route (VS Code ≥1.73): `editor.defaultFoldingRangeProvider`
    // makes this extension the ONLY folding source, so folds are guaranteed to
    // look like WebStorm (single-line, params visible). Applied automatically —
    // the old one-time prompt was too easy to dismiss, which left the built-in
    // provider in charge and made folding look non-WebStorm.
    void ensureDefaultFoldingProvider();
}

/**
 * Enforce (or release) `editor.defaultFoldingRangeProvider` according to the
 * `smartFolding.takeOverFolding` setting:
 *
 * - take-over ON  + setting unset            → point it at this extension.
 * - take-over ON  + user chose ANOTHER one   → respect the user's choice.
 * - take-over OFF + setting points at us     → clear it back to the default.
 */
async function ensureDefaultFoldingProvider(): Promise<void> {
    const takeOver = vscode.workspace
        .getConfiguration('smartFolding')
        .get<boolean>('takeOverFolding', true);
    const editorCfg = vscode.workspace.getConfiguration('editor');
    let current = editorCfg.get<string>('defaultFoldingRangeProvider');

    if (takeOver) {
        if (!current) {
            await editorCfg.update(
                'defaultFoldingRangeProvider',
                EXTENSION_ID,
                vscode.ConfigurationTarget.Global
            );
            void vscode.window.showInformationMessage(
                'Smart Folding is now the default folding provider, so folds are ' +
                    'single-line with parameters kept visible (WebStorm style). Disable ' +
                    "'smartFolding.takeOverFolding' to undo this."
            );
        }
    } else if (current === EXTENSION_ID) {
        await editorCfg.update(
            'defaultFoldingRangeProvider',
            undefined,
            vscode.ConfigurationTarget.Global
        );
    }
}

export function deactivate(): void {}

/**
 * Collapsed folds for the editor, bridged over the viewport's bottom edge.
 *
 * Gap detection only SEES a collapsed fold once something below it is
 * scrolled into view. While a fold's header sits at the very BOTTOM of the
 * viewport, a collapsed fold and the viewport simply ending look identical —
 * so the badge used to vanish mid-scroll and the hidden `{` popped back in.
 * Folds are therefore remembered per document while collapsed and trusted
 * again exactly in that ambiguous bottom-edge case. A remembered fold is
 * forgotten as soon as any of its hidden lines is actually rendered (i.e. it
 * was opened) or the document changes.
 */
const rememberedFolds = new Map<string, { version: number; folds: CollapsedFold[] }>();

function currentCollapsedFolds(
    editor: vscode.TextEditor,
    ranges: SimpleFoldingRange[]
): CollapsedFold[] {
    const visible = editor.visibleRanges.map(r => ({
        startLine: r.start.line,
        endLine: r.end.line,
    }));
    const detected = collapsedFolds(visible, ranges);
    const key = editor.document.uri.toString();
    const version = editor.document.version;
    const prev = rememberedFolds.get(key);
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

    rememberedFolds.set(key, { version, folds: [...detected, ...kept] });
    return folds;
}

/**
 * How the collapsed fold starting at `line` is rendered: the badge text plus
 * the column from which the header line's own text is visually hidden so the
 * badge can take its place (undefined = nothing hidden, the badge simply
 * follows the line end). Shared by the renderer and the click handler so the
 * clickable area always matches what is drawn.
 */
function foldBadge(
    editor: vscode.TextEditor,
    line: number,
    ranges: SimpleFoldingRange[],
    c: vscode.WorkspaceConfiguration,
    hiddenEnd?: number
): { contentText: string; hiddenStart?: number; visibleMarkerEnd?: number } {
    const lineText = editor.document.lineAt(line).text;
    // The range matching the ACTUALLY hidden region decides how the collapsed
    // block is rendered. Requiring the exact end line keeps the fancy badges
    // honest: when the active fold came from another folding provider and
    // hides a DIFFERENT region than our range (e.g. a comment fold that
    // leaves its closing `*/` visible), pretending it was ours painted the
    // ellipsis in the wrong place. Such folds now get the plain badge.
    const range = ranges.find(
        r => r.start === line && (hiddenEnd === undefined || r.end === hiddenEnd)
    );

    if (range?.kind === 'comment' && c.get<boolean>('commentPreview', true)) {
        // WebStorm-style readable comment folds: the WHOLE comment — its
        // `/**` header included — collapses into the gray badge, which shows
        // the first meaningful text line:  /** Folding ranges per document… */
        const previewLength = Math.max(4, c.get<number>('commentPreviewLength', 60));
        const commentLines: string[] = [];
        const lastLine = Math.min(range.end, editor.document.lineCount - 1);
        for (let l = range.start; l <= lastLine; l++) {
            commentLines.push(editor.document.lineAt(l).text);
        }
        const preview = commentPreviewText(commentLines, previewLength);
        const trimmed = lineText.trimStart();
        if (trimmed.startsWith('//')) {
            const markerIndex = lineText.indexOf('//');
            // VS Code does not expose click events for decorations; click-to-
            // expand is inferred from the caret position produced by a mouse
            // click. An `after` decoration anchored at absolute column 0 is a
            // special dead zone: depending on font/layout, clicking it may not
            // move the caret (or may not emit a selection event at all). Keep
            // the real top-level `//` as a tiny, stable text boundary and hide
            // everything after it. The gray preview is then anchored at column
            // 2, where VS Code reliably produces a mouse selection event.
            if (markerIndex === 0) {
                // When the header line is ONLY the marker, the first hidden
                // column coincides with the LINE END — the exact position where
                // other extensions (e.g. GitLens inline blame) anchor their own
                // end-of-line `after` decorations. VS Code offers no cross-
                // extension ordering for decorations at the SAME position, so
                // blame can squeeze in BEFORE the badge. Hiding the marker's
                // last char and re-drawing it inside the badge pulls the anchor
                // strictly before the line end — position order then guarantees
                // the badge always renders first.
                if (lineText.length === 2) {
                    return {
                        contentText: `/ ${preview} ···`,
                        hiddenStart: 1,
                        visibleMarkerEnd: 1,
                    };
                }
                return {
                    contentText: ` ${preview} ···`,
                    hiddenStart: 2,
                    visibleMarkerEnd: 2,
                };
            }
            return { contentText: `// ${preview} ···`, hiddenStart: lineText.indexOf('//') };
        }
        const marker = trimmed.match(/\/\*+/)?.[0] ?? '/*';
        const markerIndex = lineText.indexOf(marker);
        // Same column-zero rule as `//` above. Retaining only the real marker
        // is intentionally preferable to parking the cursor on another line:
        // cross-line parking interferes with cursor-restore state, while a
        // real text boundary makes every click on the injected preview change
        // the selection without touching restore logic at all.
        if (markerIndex === 0) {
            // Same line-end tie-break as `//` above: on a bare `/**` header
            // line, anchoring at `marker.length` lands exactly ON the line
            // end, where GitLens & co. attach their inline blame — rendering
            // order between extensions at identical positions is undefined.
            // Hide the marker's last char and re-draw it inside the badge so
            // the anchor sits strictly before the line end and the badge
            // deterministically renders before any end-of-line decoration.
            if (lineText.length === marker.length) {
                return {
                    contentText: `${marker.charAt(marker.length - 1)} ${preview} */`,
                    hiddenStart: marker.length - 1,
                    visibleMarkerEnd: marker.length - 1,
                };
            }
            return {
                contentText: ` ${preview} */`,
                hiddenStart: marker.length,
                visibleMarkerEnd: marker.length,
            };
        }
        return {
            contentText: `${marker} ${preview} */`,
            hiddenStart: markerIndex >= 0 ? markerIndex : undefined,
        };
    }

    // hideOpeningBracket only applies with single-line folds: when
    // singleLineFolding is OFF the closing bracket stays visible on its own
    // line below, so a `{...}` badge would lie — fall through to the plain
    // ` ··· ` badge and leave the opening bracket visible.
    if (
        range?.kind !== 'comment' &&
        c.get<boolean>('singleLineFolding', true) &&
        c.get<boolean>('hideOpeningBracket', true)
    ) {
        // Render `function foo() {...}`: the real opening bracket is
        // visually hidden and the badge takes its place.
        const trimmed = lineText.trimEnd();
        const lastChar = trimmed.charAt(trimmed.length - 1);
        const closer =
            lastChar === '{' ? '}' : lastChar === '[' ? ']' : lastChar === '(' ? ')' : undefined;
        if (closer) {
            return { contentText: `${lastChar}...${closer}`, hiddenStart: trimmed.length - 1 };
        }
    }

    return { contentText: ' ··· ' };
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
        const { contentText, hiddenStart, visibleMarkerEnd } = foldBadge(
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
            `[$(unfold)\u00a0Expand](command:smartFolding.expandHere?${encodeURIComponent(
                JSON.stringify([line])
            )} "Expand this folded block")`
        );
        hover.isTrusted = true;
        // Anchoring the badge at the first HIDDEN column (instead of the
        // line end) keeps it flush after the visible code and makes it render
        // BEFORE other extensions' end-of-line decorations \u2014 e.g. GitLens
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
            renderOptions: {
                after:
                    visibleMarkerEnd !== undefined
                        ? {
                              contentText,
                              // Join the injected preview to the decorated real
                              // marker. It remains two rendering primitives only
                              // internally; visually it is one rounded badge.
                              margin: '0',
                              textDecoration:
                                  'none; border-radius: 0 4px 4px 0; padding: 0 5px 0 0; cursor: pointer;',
                          }
                        : { contentText },
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
    const key = editor.document.uri.toString();
    const state = savedStates.get(key);

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
    if (restored) savedStates.delete(key);

    restoreView(editor, selections);
}
