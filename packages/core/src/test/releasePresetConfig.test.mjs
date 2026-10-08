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
      for (const option of output.options.filter(option => /^local_.+_openclaw$/.test(option.id))) {
        assert.equal(option.enabled, false, `${name}: uninstalled local script provider must stay disabled`);
        assert.equal(option.default, false);
      }
      if (output.id === 'image_provider') assert.equal(defaults[0].id, 'local_card_image');
      assert.equal(JSON.stringify(original), before, 'export must not rewrite local source settings');
    }
  });

  it('disables an exec image preset whose executor was omitted and replaces its first-run promise', () => {
    const original = { id: 'image_provider', options: [
      { id: 'local_sdxl_openclaw', enabled: true, default: true, notes: '首跑即可用', notes_detail: '已安装于原机器' },
      { id: 'local_card_image', enabled: false, default: false },
    ] };
    const before = structuredClone(original);
    const output = prepareReleasePresetConfig(original);
    const extension = output.options[0];
    assert.equal(extension.enabled, false);
    assert.equal(extension.enabled_without_key, false);
    assert.equal(extension.default, false);
    assert.deepEqual(extension.executor, { python_path: '', script_path: '' });
    assert.match(extension.notes, /先配置/);
    assert.doesNotMatch(extension.notes + extension.notes_detail, /首跑即可用|原机器/);
    const demo = output.options[1];
    assert.equal(demo.enabled, true);
    assert.equal(demo.default, true);
    assert.equal(demo.enabled_without_key, true);
    assert.match(demo.label_zh, /演示.*非 AI/);
    assert.match(demo.notes, /失败不会自动切换/);
    assert.deepEqual(original, before);
    assert.deepEqual(prepareReleasePresetConfig(output), output, 'safe to reapply to an existing public preset');
  });

  it('disables unconfigured script-based video and speech providers without touching ordinary APIs', () => {
    const output = prepareReleasePresetConfig({ options: [
      { id: 'local_wan_openclaw', enabled: true, default: true },
      { id: 'local_gpt_sovits_openclaw', enabled: true, default: true, executor: null },
      { id: 'custom_local_script', enabled: true, default: true, executor: { python_path: 'python' } },
      { id: 'custom_cloud', enabled: true, default: true, base_url: 'https://api.example.test/v1' },
    ] });
    for (const option of output.options.slice(0, 3)) {
      assert.equal(option.enabled, false);
      assert.equal(option.default, false);
      assert.equal(option.executor.python_path, '');
      assert.equal(option.executor.script_path, '');
    }
    assert.deepEqual(output.options[3], { id: 'custom_cloud', enabled: true, default: true, base_url: 'https://api.example.test/v1' });
  });

  it('fails image export instead of choosing an unavailable extension when the demo is missing', () => {
    assert.throws(() => prepareReleasePresetConfig({ id: 'image_provider', options: [
      { id: 'local_sdxl_openclaw', enabled: true, default: true },
    ] }), /Public image presets require a local demo option/);
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
