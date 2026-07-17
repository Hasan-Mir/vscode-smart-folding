# 🧠 Smart Folding — WebStorm-Style Code Folding for VS Code

Bring JetBrains/WebStorm's beloved folding experience to VS Code: single-line folds, a big clickable `{...}` badge, readable comment previews, visible function params, and a cursor that always comes back to where you left it. ✨

> 🎹 **No keybindings are contributed by this extension.** It reacts to VS Code's **built-in** fold/unfold commands, so it works with _your_ keymap — IntelliJ IDEA Keybindings (`Ctrl+Shift+-` / `Ctrl+Shift+=`), `Alt+W`, the Command Palette, or the gutter chevrons. Nothing to configure, nothing to conflict.

---

## 🚀 Features

### 🧩 WebStorm-style single-line folds

A collapsed block renders as **one line** — the closing bracket is folded away too:

```ts
function activate(context: vscode.ExtensionContext) {...}
```

### 🎯 Function parameters stay visible

Parameter lists `(...)` are never offered as folds, so folding a function keeps its full signature readable — exactly like WebStorm.

### 🏷️ A real `{...}` badge (clickable!)

- The block's own opening `{` is visually hidden and a themed **`{...}`** badge takes its place (also `[...]` / `(...)` for arrays and groups).
- 🖱️ **Click the badge** (or hover → _Expand_) to unfold that block.
- ⚡ **Alt+click the badge** to expand the block **recursively** — folded descendants included. The modifier follows VS Code's `editor.multiCursorModifier` setting (set it to `ctrlCmd` for Ctrl/Cmd+click).
- 🎨 Colors are theme-aware with separate **dark/light** overrides.
- 🧲 The badge sticks right after the visible code — BEFORE end-of-line decorations from other extensions such as GitLens inline blame.

### 💬 Comment folding with readable previews

- Multi-line block comments & JSDoc fold — and so do runs of consecutive whole-line `//` comments _(new in 1.4)_.
- The **entire comment — `/**` header included — collapses into the gray badge\*\*, which shows the comment's first meaningful text line (WebStorm style), truncated to a configurable length:

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
| `smartFolding.modifierClickExpandsRecursively`  | `true`           | Alt+click a badge to expand recursively (modifier = `editor.multiCursorModifier`)                                                                   |
| `smartFolding.singleLineFolding`                | `true`           | Fold the closing bracket line too (WebStorm style)                                                                                                  |
| `smartFolding.keepFunctionParamsVisible`        | `true`           | Never fold parameter lists                                                                                                                          |
| `smartFolding.rememberCursorOnFoldAll`          | `true`           | Remember cursor + scroll on Fold All                                                                                                                |
| `smartFolding.restoreOnAnyUnfold`               | `true`           | Restore the cursor after _any_ unfold, any shortcut                                                                                                 |
| `smartFolding.smartUnfold`                      | `true`           | Enable smart (focus) unfolding                                                                                                                      |
| `smartFolding.takeOverFolding`                  | `true`           | Register as the default folding range provider                                                                                                      |
| `smartFolding.providerDelay`                    | `2000`           | Delay (ms) before re-registering the provider                                                                                                       |
| `smartFolding.languages`                        | JS/TS family     | Languages the folding provider applies to                                                                                                           |

---

## 🛠️ Build & Install

```bash
npm install
npx @vscode/vsce package   # produces smart-folding-1.6.0.vsix
```

Then in VS Code: **Extensions → ⋯ → Install from VSIX…**

---

## 🧪 Development

```bash
npm run compile   # tsc -p ./
node --test out/test/*.test.js
```

The folding scanner and all detection logic live in `src/core/folding.ts` as pure, unit-tested functions.

---

## 📄 License

[MIT](./LICENSE.md) © 2026 SeyMi
