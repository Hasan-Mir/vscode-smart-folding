# 🧠 Smart Folding — WebStorm-Style Code Folding for VS Code

Bring JetBrains/WebStorm's beloved folding experience to VS Code: single-line folds, a big clickable `{...}` badge, readable comment previews, and a cursor that always comes back to where you left it. ✨

> 🎹 **No fold/unfold keybindings are contributed** — Smart Folding reacts to VS Code's **built-in** fold/unfold commands, so it works with _your_ keymap (IntelliJ IDEA Keybindings, `Alt+W`, the Command Palette, or the gutter chevrons). The only keybinding contributed is a **conditional `Ctrl+C`/`Cmd+C` override** for `smartFolding.clipboardCopy` (active only while `smartFolding.copyFoldedBlocks` is enabled), which copies whole collapsed blocks instead of broken visible rows.

---

## 🚀 Features

### 🧩 WebStorm-style single-line folds

A collapsed block renders as **one line** — the closing bracket is folded away too:

```ts
function activate(context: vscode.ExtensionContext) {...}
```

### 🏷️ A real `{...}` badge (clickable!)

- The block's own opening `{` is visually hidden and a themed **`{...}`** badge takes its place (also `[...]` / `(...)` for arrays and groups).
- 🖱️ **Click the badge** (or hover → _Expand_) to unfold that block.
- ⚡ **Alt+click the badge** to expand the block **recursively** — folded descendants included. The modifier follows VS Code's `editor.multiCursorModifier` setting (set it to `ctrlCmd` for Ctrl/Cmd+click).
- 🎨 Colors are theme-aware with separate **dark/light** overrides.
- 🧲 The badge sticks right after the visible code — BEFORE end-of-line decorations from other extensions such as GitLens inline blame.

> 💡 **Click-to-expand UX note:** Because the VS Code Extension API does not provide direct DOM click events for text decorations, clicking a badge is detected via editor caret movement (`onDidChangeTextEditorSelection`). If your cursor is already parked directly on the opening bracket (e.g. bracket-matching border is active), click slightly towards the middle/right of the badge or use the hover tooltip's **[Expand]** action. You can also enable `"smartFolding.clickLineToExpand": true` to expand by clicking anywhere on the collapsed line.

### 💬 Comment folding with readable previews

- Multi-line block comments & JSDoc fold — and so do runs of consecutive whole-line `//` comments _(new in 1.4)_.
- The **entire comment — `/**` header included — collapses into the gray badge**, which shows the comment's first meaningful text line (WebStorm style), truncated to a configurable length:

```ts
/** Remembers the cursor position when folding… */
```

- 🙅 **Single-line comments** like `/* one liner */` are **never** collapsed (unlike WebStorm's `/**...*/`).

### 📍 Remember & restore the cursor

- **Fold All (Remember Cursor)** stores your exact cursor **line and column** and scroll position.
- Any later unfold that frees that line — **Unfold All, Unfold Recursively, plain Unfold, a chevron click, any shortcut** — puts the cursor right back and scrolls it into view.
- Detection is **self-verifying** (a silent selection probe checks whether the remembered line is really reachable), so it works for _every_ block in the file regardless of scroll position — not just blocks near the viewport. _(fixed in 1.3)_

### 🔦 Smart Unfold (focus mode)

After a Fold All, **Smart Unfold** opens _only_ the parent chain around your remembered cursor and keeps every other block folded — instant focus on what you were editing.

---

## 📦 Commands (Command Palette)

| Command                                       | What it does                                              |
| --------------------------------------------- | --------------------------------------------------------- |
| `Smart Folding: Fold All (Remember Cursor)`   | Folds everything and remembers your exact cursor + scroll |
| `Smart Folding: Unfold All (Restore Cursor)`  | Unfolds everything and jumps back to your cursor          |
| `Smart Folding: Smart Unfold (Reveal Cursor)` | Opens only the blocks containing your cursor              |
| `Smart Folding: Smart Unfold Recursively`     | Same, but opens the chain recursively                     |
| `Smart Folding: Copy (Whole Collapsed Blocks)`| Copies whole collapsed blocks (bound to Ctrl+C / Cmd+C)   |
| `Smart Folding: Expand Folded Block on This Line` | Unfolds the block on the active line (badge hover action) |

💡 You don't have to use these commands — the built-in `editor.foldAll` / `editor.unfoldAll` / `editor.unfold` / `editor.unfoldRecursively` (with your own keybindings) are detected automatically.

---

## ⚙️ Settings

| Setting                                         | Default          | Description                                                                                                                                         |
| ----------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smartFolding.enhancedEllipsis`                 | `true`           | Show the clickable badge on collapsed blocks                                                                                                        |
| `smartFolding.hideOpeningBracket`               | `true`           | Render collapsed blocks as `{...}` (hides the real `{`)                                                                                             |
| `smartFolding.hideNativeFoldPlaceholder`        | `true`           | 🫥 Hides VS Code's built-in `⋯` collapsed-text indicator (makes `editor.foldPlaceholderForeground` transparent in your global color customizations) |
| `smartFolding.foldComments`                     | `true`           | Fold block comments, JSDoc & `//` comment runs (never single-line ones)                                                                             |
| `smartFolding.commentPreview`                   | `true`           | Show the comment's first text line instead of `···`                                                                                                 |
| `smartFolding.commentPreviewLength`             | `60`             | Max characters of the comment preview                                                                                                               |
| `smartFolding.ellipsisBackground`               | `#46494e`        | Badge background (base)                                                                                                                             |
| `smartFolding.ellipsisColor`                    | `#9a9da5`        | Badge text color (base)                                                                                                                             |
| `smartFolding.ellipsisBackgroundDark` / `Light` | `""` / `#dfe1e5` | Theme-specific background overrides                                                                                                                 |
| `smartFolding.ellipsisColorDark` / `Light`      | `""` / `#6a6f77` | Theme-specific text color overrides                                                                                                                 |
| `smartFolding.clickToExpand`                    | `true`           | Click a collapsed line to expand it                                                                                                                 |
| `smartFolding.clickLineToExpand`                | `false`          | Click ANYWHERE on a collapsed line (not just the `···` badge) to expand it                                                                          |
| `smartFolding.copyFoldedBlocks`                 | `true`           | `Ctrl+C` on a collapsed line copies the WHOLE hidden block, not just the visible row                                                                |
| `smartFolding.modifierClickExpandsRecursively`  | `true`           | Alt+click a badge to expand recursively (modifier = `editor.multiCursorModifier`)                                                                   |
| `smartFolding.singleLineFolding`                | `true`           | Fold the closing bracket line too (WebStorm style)                                                                                                  |
| `smartFolding.rememberCursorOnFoldAll`          | `true`           | Remember cursor + scroll on Fold All                                                                                                                |
| `smartFolding.restoreOnAnyUnfold`               | `true`           | Restore the cursor after _any_ unfold, any shortcut                                                                                                 |
| `smartFolding.smartUnfold`                      | `true`           | Enable smart (focus) unfolding                                                                                                                      |
| `smartFolding.takeOverFolding`                  | `true`           | Be the sole folding provider (unified model verified against the tsserver parity suite + WebStorm single-line folds)                                |
| `smartFolding.languages`                        | JS/TS family     | Languages the folding provider applies to                                                                                                           |

> **Language coverage note (takeover):** Smart Folding's scanner does not yet safely model the language-specific multiline literals of **C, C++, C#, Java and PHP** (raw strings, verbatim/interpolated strings, text blocks, heredoc). Those languages keep **native VS Code folding** even when listed in `smartFolding.languages` — they are excluded from both the folding-provider registration and the `defaultFoldingRangeProvider` takeover until support lands.

---

## 🛠️ Build & Install

```bash
npm install
npx @vscode/vsce package   # produces smart-folding-1.4.0.vsix
```

Then in VS Code: **Extensions → ⋯ → Install from VSIX…**

---

## 🧪 Development

```bash
npm run build              # tsc -p ./
npm test                   # unit tests (node --test on out/test)
npm run test:parity        # tsserver parity harness (lenient extras reporting)
npm run test:parity:strict # strict mode: unexpected extras fail (CI)
npm run test:integration   # real extension-host tests (needs a display / xvfb)
```

The folding scanner and all detection logic live in `src/core/folding.ts` as pure, unit-tested functions. The parity fixtures in `fixtures/parity/` are diffed against a real tsserver; intentional WebStorm divergences are recorded in `fixtures/parity/allowlist.json`.

> 📖 See [TESTING.md](./TESTING.md) for the detailed testing architecture (unit, parity, and integration tiers).

---

## 📄 License

[MIT](./LICENSE.md) © 2026 SeyMi
