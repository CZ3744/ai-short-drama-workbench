/** Prepare public configuration without mutating the source installation. */
export function prepareReleasePresetConfig(input) {
  const cfg = structuredClone(input);
  function clean(value) {
    if (!value || typeof value !== 'object') return;
    if (value.executor) {
      for (const key of ['python_path', 'script_path', 'voices_dir']) if (key in value.executor) value.executor[key] = '';
      value.enabled = false;
      value.enabled_without_key = false;
      value.default = false;
      value.notes = '可选本地扩展。请先配置本机 Python、执行脚本和模型，再启用。';
    }
    for (const child of Object.values(value)) clean(child);
  }
  clean(cfg);

  if (cfg?.id === 'video_provider' && Array.isArray(cfg.options)) {
    const demo = cfg.options.find(option => option.id === 'local_mock_video');
    if (demo) {
      demo.label_zh = '本地演示视频（非 AI 生成）';
      demo.label_en = 'Local Demo Video (not AI-generated)';
      demo.notes = '用于免费演示制作流程，不代表 AI 视频生成质量。真实生成请配置并选择自己的视频模型；模型调用失败不会自动切换为演示视频。';
    }
    // Removing a machine-specific default must not leave a fresh install without a selection.
    if (!cfg.options.some(option => option.default === true && option.enabled === true)) {
      if (!demo || demo.executor) throw new Error('Public video presets require a local demo option when no enabled default remains');
      for (const option of cfg.options) option.default = false;
      demo.enabled = true;
      demo.enabled_without_key = true;
      demo.default = true;
    }
  }
  return cfg;
}
