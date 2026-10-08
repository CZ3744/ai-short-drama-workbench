/** Export a clean distributable tree. Never copy local data, keys, or Git history. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { prepareReleasePresetConfig } from './release-preset-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || path.join(root, '.quality-reports', `release-${Date.now()}`));
if (output === root || !output.startsWith(path.join(root, '.quality-reports') + path.sep)) throw new Error('Release must be a new directory inside .quality-reports');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.mkdir(output, { recursive: false });
const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' });
const docs = new Set(['GETTING_STARTED.md', 'DISTRIBUTION.md', 'RELEASE_NOTES.md', 'VISUAL_REVIEW.md', 'UPGRADE_BRIEF_2026-10-08.md', 'AI_SETUP.md', 'SHOWCASE.md']);
const productHandbooks = new Set(['content_planner.md', 'storyboard_director.md', 'visual_director.md', 'provider_prompt_adapter.md']);
const rootFiles = new Set(['package.json', 'package-lock.json', 'tsconfig.json', '.node-version', '.nvmrc', '.gitignore', '.env.example', 'README.md', 'LICENSE', 'start-studio-hidden.vbs', 'start-studio.ps1', 'stop-studio.ps1', 'stop-studio.vbs', 'studio-common.ps1', 'start-dev.bat']);
const approvedScripts = new Set(['run-safe-tests.mjs', 'test-network-guard.mjs', 'browser-smoke.ts', 'verify-clean-install.mjs', 'codebase-health.ts', 'health-extension-completeness.ts', 'consolidate-project-roots.ts', 'audit-historical-assets.mjs', 'inspect-memory-recovery.mjs', 'run-sample.ts', 'validate-output.ts', 'check-llm.ts', 'smoke-phase-stable.ts', 'test-e2e-auto.ts', 'migrate-shot-picked-video.ts', 'export-release.mjs', 'whisper_transcribe.py', 'check-release-privacy.mjs']);
const files = [...new Set([...git('ls-files', '-z').split('\0'), ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0')])].filter(Boolean);
for (const file of ['README.en.md', 'CONTRIBUTING.md', 'SECURITY.md', 'llms.txt']) rootFiles.add(file);
docs.add('FAQ.md');
for (const file of ['doctor.mjs', 'browser-showcase.ts', 'run-showcase.mjs']) approvedScripts.add(file);
approvedScripts.add('dev.mjs');
approvedScripts.add('studio-web-identity.ts');
approvedScripts.add('browser-workflow-checks.ts');
approvedScripts.add('release-preset-config.mjs');
approvedScripts.add('browser-test-environment.mjs');
approvedScripts.add('browser-test-environment.d.mts');
const remote = git('remote', 'get-url', 'origin').trim();
const owner = remote.match(/github\.com[/:]([^/]+)/)?.[1];
const privateWords = [os.userInfo().username, owner].filter(word => word && word.length >= 4 && !['root', 'runner', 'user', 'example'].includes(word));
const privateRoots = [root, path.dirname(root), path.dirname(path.dirname(root))].filter(p => p.length > 4).sort((a,b) => b.length-a.length);
function sanitize(text) {
  // The published project's clone URL is intentional attribution, not a local account secret.
  const projectUrls = [];
  text = text.replace(/https:\/\/github\.com\/[A-Za-z0-9-]+\/video-generate-studio(?:\.git)?/g, url => {
    projectUrls.push(url); return `__PROJECT_REPO_URL_${projectUrls.length - 1}__`;
  });
  for (const original of privateRoots) {
    for (const variant of [original, original.replaceAll('\\','/'), original.replaceAll('\\','\\\\')]) text = text.split(variant).join('C:/Projects/video-studio');
  }
  for (const word of privateWords) text = text.split(word).join('example');
  text = text.replace(/__PROJECT_REPO_URL_(\d+)__/g, (_, index) => projectUrls[Number(index)]);
  return text;
}
const manifest = [];
for (const relative of files.sort()) {
  const basename = path.basename(relative);
  if ((/^\.env(?:\.|$)/i.test(basename) && relative !== '.env.example') || /\.local\.json$|\.(?:pem|key|p12|pfx)$/i.test(basename)) continue;
  const approved = rootFiles.has(relative) || /^(apps|packages|prompts|samples)\//.test(relative) || relative.startsWith('.github/') ||
    (relative.startsWith('agent_handbooks/') && productHandbooks.has(relative.slice('agent_handbooks/'.length))) ||
    (relative.startsWith('scripts/') && approvedScripts.has(path.basename(relative))) ||
    (relative.startsWith('docs/') && (docs.has(relative.slice(5)) || relative.startsWith('docs/screenshots/') || relative.startsWith('docs/media/'))) ||
    (relative.startsWith('config/') && relative.endsWith('.json') && !/local-settings\.json|backup|secret/i.test(relative));
  if (!approved || /(?:^|\/)(?:node_modules|dist|data|outputs|\.git)(?:\/|$)|\.(?:db|sqlite|log|pyc)(?:-|$)/.test(relative)) continue;
  const from = path.join(root, relative);
  const stat = await fs.lstat(from).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) continue;
  let bytes;
  // Tracked runtime presets may be locally customized: start from repository defaults.
  if (relative.startsWith('config/') && !relative.endsWith('.example.json')) bytes = Buffer.from(git('show', `HEAD:${relative}`));
  else bytes = await fs.readFile(from);
  if (/\.(?:[cm]?[jt]sx?|json|md|txt|css|html|svg|ya?ml|toml|ps1|vbs|bat|py)$|(?:^|\/)(?:\.gitignore|\.env\.example|\.node-version|\.nvmrc|LICENSE)$/i.test(relative)) {
    let text = sanitize(bytes.toString('utf8'));
    if (relative.startsWith('config/') && relative.endsWith('.json')) {
      const cfg = prepareReleasePresetConfig(JSON.parse(text));
      text = JSON.stringify(cfg, null, 2) + '\n';
    }
    bytes = Buffer.from(text);
  }
  const to = path.join(output, relative);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.writeFile(to, bytes);
  manifest.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await fs.writeFile(path.join(output, 'RELEASE_MANIFEST.json'), JSON.stringify({ schema: 1, files: manifest }, null, 2) + '\n');
console.log(JSON.stringify({ output, files: manifest.length, historyIncluded: false, runtimeDataIncluded: false }));
