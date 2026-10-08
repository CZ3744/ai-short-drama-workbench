/** Reproducible product screenshots from original, clearly labelled sample media. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const runner = fileURLToPath(new URL('./run-safe-tests.mjs', import.meta.url));
const child = spawn(process.execPath, [runner, '--showcase'], { windowsHide: true, stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });
