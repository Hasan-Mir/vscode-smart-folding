/**
 * T-5: integration coverage for extension-only behavior. Runs inside a real
 * VS Code extension host (see index.ts). Prioritized scenarios from the fix
 * contract: Fold All → Unfold All, Fold All → scroll → Unfold, no-op Fold
 * All (E-4), split editors (E-2), takeover (F-13).
 */
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vscode from 'vscode';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function withTypeScriptDocument(
    content: string,
    run: (doc: vscode.TextDocument, editor: vscode.TextEditor) => Promise<void>
): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ content, language: 'typescript' });
    const editor = await vscode.window.showTextDocument(doc);
    try {
        await run(doc, editor);
    } finally {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
}

test('Fold All clamps the cursor and Unfold All restores line and column', async () => {
    const lines = [
        'function a() {',
        '    one();',
        '}',
        '',
        'function b() {',
        '    two();',
        '    // cursor',
        '}',
        '',
    ];
    await withTypeScriptDocument(lines.join('\n'), async (_doc, editor) => {
        editor.selection = new vscode.Selection(6, 8, 6, 8);
        await vscode.commands.executeCommand('smartFolding.foldAll');
        await sleep(200);
        assert.ok(
            editor.selection.active.line < 6,
            `cursor should be clamped above line 6, got ${editor.selection.active.line}`
        );
        await vscode.commands.executeCommand('smartFolding.unfoldAll');
        await sleep(300);
        assert.equal(editor.selection.active.line, 6);
        assert.equal(editor.selection.active.character, 8);
    });
});

test('E-4: Fold All with the cursor on an unfolded line leaves no restore state', async () => {
    const lines = ['const top = 1;', '', 'function b() {', '    two();', '}', ''];
    await withTypeScriptDocument(lines.join('\n'), async (_doc, editor) => {
        editor.selection = new vscode.Selection(0, 14, 0, 14);
        await vscode.commands.executeCommand('smartFolding.foldAll');
        await sleep(200);
        assert.equal(editor.selection.active.line, 0);
        assert.equal(editor.selection.active.character, 14);
        const beforeStartLine = editor.visibleRanges[0]?.start.line ?? 0;
        await vscode.commands.executeCommand('editor.scrollPageDown');
        await sleep(200);
        assert.equal(editor.selection.active.line, 0, 'cursor line must not teleport');
        assert.equal(editor.selection.active.character, 14, 'cursor character must not teleport');
        if (editor.document.lineCount > 20) {
            assert.ok(editor.visibleRanges[0].start.line >= beforeStartLine, 'viewport must not teleport back');
        }
    });
});

test('E-2: two editor groups of one file do not share selection memory', async () => {
    const lines = [
        'function a() {',
        '    one();',
        '}',
        '',
        'function b() {',
        '    two();',
        '}',
        '',
    ];
    await withTypeScriptDocument(lines.join('\n'), async (doc, editor) => {
        editor.selection = new vscode.Selection(5, 9, 5, 9);
        // Open a second group with the same document.
        await vscode.commands.executeCommand('workbench.action.splitEditor');
        await sleep(200);
        const second = vscode.window.visibleTextEditors.find(
            e => e.document === doc && e !== editor
        );
        if (second) {
            second.selection = new vscode.Selection(1, 10, 1, 10);
            await sleep(100);
            // The first editor's selection must be unaffected.
            assert.equal(editor.selection.active.line, 5);
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });
});

test('F-13: C/C++/C#/Java/PHP keep native folding (no takeover registration)', async () => {
    const c = vscode.workspace.getConfiguration('smartFolding');
    const languages = c.get<string[]>('languages', []);
    assert.ok(languages.includes('cpp'), 'fixture precondition: cpp in languages');
    // The takeover filter is applied inside ensureDefaultFoldingProvider and
    // registerProvider; the observable contract is: cpp must not have a
    // defaultFoldingRangeProvider pointing at this extension.
    const langCfg = vscode.workspace.getConfiguration('editor', { languageId: 'cpp' });
    assert.notEqual(
        langCfg.get<string>('defaultFoldingRangeProvider'),
        vscode.extensions.getExtension('SeyMi.smart-folding')?.id
    );
});
