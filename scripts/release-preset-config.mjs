/** Prepare public configuration without mutating the source installation. */
export function prepareReleasePresetConfig(input) {
  const cfg = structuredClone(input);
  function clean(value) {
    if (!value || typeof value !== 'object') return;
    // These registered providers execute local scripts even when an old preset
    // omitted the executor entirely. Missing configuration is never "ready".
    const localScriptProvider = typeof value.id === 'string' && /^local_.+_openclaw$/.test(value.id);
    if (localScriptProvider || Object.hasOwn(value, 'executor')) {
      if (!value.executor || typeof value.executor !== 'object' || Array.isArray(value.executor)) value.executor = {};
      value.executor.python_path = '';
      value.executor.script_path = '';
      if ('voices_dir' in value.executor) value.executor.voices_dir = '';
      value.enabled = false;
      value.enabled_without_key = false;
      value.default = false;
      value.notes = '可选本地扩展。请先配置本机 Python、执行脚本和模型，再启用。';
      if ('notes_detail' in value) value.notes_detail = value.notes;
    }
    for (const child of Object.values(value)) clean(child);
  }
  clean(cfg);

  if (cfg?.id === 'image_provider' && Array.isArray(cfg.options)) {
    const demo = cfg.options.find(option => option.id === 'local_card_image');
    if (!demo || demo.executor) throw new Error('Public image presets require a local demo option');
    // A distributed installation has no creator credentials or GPU scripts.
    // Start with an explicit sample renderer; never silently substitute it on failure.
    for (const option of cfg.options) option.default = false;
    Object.assign(demo, {
      label_zh: '本地演示卡片（非 AI 生图）',
      label_en: 'Local Demo Card (not AI-generated)',
      notes: '免费绘制提示词卡片，用于熟悉制作流程，不代表 AI 生图效果。真实生成请配置并选择自己的图像模型；模型调用失败不会自动切换为演示卡片。',
      notes_detail: '本地使用图像渲染器制作样稿，无需模型凭据。需要真实画面时，请选择已配置的图像模型，或导入自己的图片。',
      enabled: true,
      enabled_without_key: true,
      default: true,
    });
  }

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
