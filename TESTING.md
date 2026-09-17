# 🧪 TESTING.md — Smart Folding Test Architecture

This document describes how Smart Folding is tested, how the tsserver parity contract works, and how to add regression coverage for a reported folding edge case. ✨

---

## 🏗️ Test Architecture Overview

There are three testing tiers. Each tier answers a different question:

### 1️⃣ Unit Tests — `npm test` ⚡

Fast `node:test` suite for the pure core logic in `src/core/folding.ts`:

- Bracket scanning (`computeFoldingRanges`) in both modes: `singleLineFolds: true` (WebStorm) and `singleLineFolds: false` (VS Code-like).
- Badge rendering (`computeFoldBadge`), comment previews, copy-range widening, cursor-clamp helpers (`isLikelyFoldClamp`, `lineHiddenByFold`), unfold detection, and malformed-input / EOF recovery.
- Lives in `src/test/*.test.ts`, compiled to `out/test/*.test.js` and run with `node --test`.

```bash
npm test   # clean + tsc build + node --test "out/test/**/*.test.js"
```

### 2️⃣ Parity Harness — `npm run test:parity` / `test:parity:strict` 🔍

Byte-for-byte comparison of the scanner against the native TypeScript language service (`tsserver.getOutliningSpans`), converted exactly the way VS Code's `typescript-language-features` extension does (see `scripts/compare-with-tsserver.js`).

- The "smart" side runs `computeFoldingRanges` in VS Code-like mode (`singleLineFolds: false`), so closing-bracket lines stay visible exactly like native folds.
- Fixtures live in `fixtures/parity/*.ts` / `*.tsx` / `*.js` / `*.jsx`.
- **Missing ranges policy:** if tsserver produces a native range the scanner does not, the harness reports `MISSING` and **fails the build** (both lenient and strict modes). Missing native folds must be implemented or documented — never silently allowlisted as extras.
- **Lenient vs strict:** `npm run test:parity` reports extras without failing; `npm run test:parity:strict` (CI/release) additionally fails on any *unexpected* extra Smart range not recorded in `fixtures/parity/allowlist.json`.

```bash
npm run test:parity         # lenient: extras reported, not failed
npm run test:parity:strict  # strict: unexpected extras fail (CI)
```

### 3️⃣ Integration Tests — `npm run test:integration` 🖥️

Headless / real extension-host tests powered by `@vscode/test-electron` (see `src/integration/suite/` and `scripts/run-integration.js`):

- Validate end-to-end behavior inside a real VS Code instance: fold-all cursor clamping, viewport scrolling, restore-on-unfold, and the takeover exclusion for C/C++/C#/Java/PHP.
- Need a display; on headless Linux CI use `xvfb-run`.

```bash
npm run test:integration              # needs a display
xvfb-run -a npm run test:integration  # headless Linux CI
```

---

## 📋 Parity Allowlist Contract (`fixtures/parity/allowlist.json`)

Intentional WebStorm divergences — ranges Smart Folding *deliberately* adds on top of native tsserver folds — are recorded per fixture file as `{ start, end, kind?, reason }` entries:

- Example: runs of consecutive whole-line `//` comments fold in Smart Folding, but tsserver emits no line-comment-run span.
- Example: mapped-type / type-literal `{...}` blocks inside conditional generics fold WebStorm-style, but tsserver emits no outlining span for them.
- Every entry must carry a `reason` starting with `Intentional WebStorm extra:` so reviewers can tell deliberate behavior apart from regressions.
- Strict mode passes only when every extra Smart range is allowlisted; anything unlisted fails the build.

---

## ➕ How to Add a Regression Test / Fixture

To reproduce a reported folding edge case:

1. Create a minimal fixture file in `fixtures/parity/`, e.g. `fixtures/parity/my-case.ts` (use `.tsx` for JSX).
2. Add its key to `fixtures/parity/allowlist.json` — use `[]` when no intentional extras are expected.
3. Run the harness and inspect the diff:
   ```bash
   npm run build
   node scripts/compare-with-tsserver.js
   ```
4. If the diff shows `MISSING` native ranges, fix the scanner in `src/core/folding.ts` (no second parser — reuse the existing bracket scanner).
5. If the diff shows intentional WebStorm-only `EXTRA` ranges, document each one in `allowlist.json` with a `reason`.
6. Add focused unit tests in `src/test/folding.test.ts` or `src/test/folding.language.test.ts` pinning the fixed behavior (both `singleLineFolds: true` and `false` where relevant).
7. Verify all tiers:
   ```bash
   npm run checktype
   npm test
   npm run test:parity:strict
   ```

---

---

## Manual UX & Edge Case Testing

### Click-to-Expand Hit-Testing & Selection Behavior
- **Monaco Hit-Testing Mechanism:** Since injected decorations (`after` / `before`) lack native click listeners in VS Code, click expansion relies on cursor repositioning via mouse selection events.
- **Verification Rule:** When manually testing click-to-expand, verify that clicking on the badge properly dispatches `editor.unfold`. Note that if the cursor is already resting on the exact anchor column (e.g. after navigating directly to the hidden bracket with arrow keys), clicking at the exact same caret position emits no selection change. Clicking within the badge or using the hover action triggers unfolding reliably.

---

## 🤖 CI & Local Execution

```bash
npm install
npm run checktype           # tsc --noEmit, zero diagnostics required
npm test                    # unit tests (193 passing, 0 failing)
npm run test:parity         # lenient parity check
npm run test:parity:strict  # strict parity check (CI gate)
npm run test:integration    # extension-host tests (display or xvfb-run required)
```
