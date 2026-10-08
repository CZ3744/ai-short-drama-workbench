import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { prepareReleasePresetConfig } from '../../../../scripts/release-preset-config.mjs';

describe('public release preset configuration', () => {
  it('exports every real preset with exactly one enabled default and clears local executors', () => {
    const presetsDir = path.join(process.cwd(), 'config/presets');
    for (const name of fs.readdirSync(presetsDir).filter(name => name.endsWith('.json'))) {
      const original = JSON.parse(fs.readFileSync(path.join(presetsDir, name), 'utf8'));
      const before = JSON.stringify(original);
      const output = prepareReleasePresetConfig(original);
      const defaults = output.options.filter(option => option.default);
      assert.equal(defaults.length, 1, `${name}: exactly one default must survive export`);
      assert.equal(defaults[0].enabled, true, `${name}: the default must be enabled`);
      for (const option of output.options.filter(option => option.executor)) {
        assert.equal(option.enabled, false);
        assert.equal(option.default, false);
        for (const key of ['python_path', 'script_path', 'voices_dir']) {
          if (key in option.executor) assert.equal(option.executor[key], '');
        }
      }
      assert.equal(JSON.stringify(original), before, 'export must not rewrite local source settings');
    }
  });

  it('replaces an unavailable local video default with an explicitly labeled demo', () => {
    const output = prepareReleasePresetConfig({ id: 'video_provider', options: [
      { id: 'local_extension', enabled: true, default: true, executor: { python_path: 'python', script_path: 'local.py' } },
      { id: 'local_mock_video', enabled: true, default: false },
    ] });
    const defaults = output.options.filter(option => option.default);
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].id, 'local_mock_video');
    assert.equal(defaults[0].enabled_without_key, true);
    assert.match(defaults[0].label_zh, /演示.*非 AI/);
    assert.match(defaults[0].notes, /失败不会自动切换/);
  });

  it('preserves an enabled configured video default', () => {
    const output = prepareReleasePresetConfig({ id: 'video_provider', options: [
      { id: 'configured_video', enabled: true, default: true },
      { id: 'local_mock_video', enabled: true, default: false },
    ] });
    assert.deepEqual(output.options.filter(option => option.default).map(option => option.id), ['configured_video']);
  });

  it('fails export when no valid video default or explicit demo option exists', () => {
    assert.throws(() => prepareReleasePresetConfig({ id: 'video_provider', options: [
      { id: 'local_extension', enabled: true, default: true, executor: { script_path: 'local.py' } },
    ] }), /require a local demo option/);
  });
});
