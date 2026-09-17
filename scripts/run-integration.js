// Runs the extension-host integration suite (src/integration → out/integration).
// Requires: npm install (devDependency @vscode/test-electron) and a display
// (use xvfb-run on headless CI). Not part of `npm test` (needs the vscode host).
'use strict';

const path = require('path');

async function main() {
    try {
        const { runTests } = require('@vscode/test-electron');
        const extensionDevelopmentPath = path.resolve(__dirname, '..');
        const extensionTestsPath = path.resolve(__dirname, '..', 'out', 'integration', 'suite');
        await runTests({ extensionDevelopmentPath, extensionTestsPath });
    } catch (err) {
        console.error('Integration tests failed to run:', err);
        process.exit(1);
    }
}

void main();
