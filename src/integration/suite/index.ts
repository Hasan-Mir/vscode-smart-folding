/**
 * Extension-host integration suite entry (run via `npm run test:integration`).
 * Executes the node:test suite inside a REAL VS Code extension host so
 * `vscode` APIs (folding commands, selection events, configuration) are
 * available. Requires `npm install` (devDependency @vscode/test-electron)
 * and a display (use xvfb-run on CI).
 *
 * These tests cannot run under plain `node --test` (they import 'vscode'),
 * so they live outside out/test/ and are excluded from `npm test`.
 */
import * as path from 'node:path';

async function main(): Promise<void> {
    const { run } = await import('node:test');
    let failures = 0;
    const stream = run({ files: [path.join(__dirname, 'extension.test.js')] });
    stream.on('test:fail', () => {
        failures++;
    });
    try {
        // Drain the stream to completion. for-await consumes the Readable,
        // which is required for it to finish ('end' never fires on a paused
        // stream); TestsStream.completed is not available in all @types/node
        // versions, so we do not rely on it.
        for await (const _ of stream) {
            // individual events are counted via the 'test:fail' listener above
        }
    } catch {
        // A stream-level error means the suite did not run cleanly.
        failures++;
    }
    if (failures > 0) process.exitCode = 1;
}

void main();
