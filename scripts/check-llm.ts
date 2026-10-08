import { JobLogger } from "../packages/core/src/index";
import { loadLlmConfig, MockLlmProvider, OpenAiCompatibleProvider } from "../packages/providers/src/index";

async function main() {
  const config = loadLlmConfig();
  const logger = new JobLogger("outputs/logs");
  const provider = config.mock ? new MockLlmProvider(config, logger) : new OpenAiCompatibleProvider(config, logger);
  const result = await provider.callJson<{ ok: boolean; message: string }>({
    agentName: "LLM Check Agent",
    promptFile: "inline-check",
    inputSummary: "LLM connectivity check",
    system: "Return JSON only.",
    user: "Return {\"ok\":true,\"message\":\"ready\"} as JSON."
  });
  console.log(JSON.stringify({
    provider: config.provider,
    base_url: config.baseUrl,
    model: config.model,
    mock: config.mock,
    api_key_present: Boolean(config.apiKey),
    subtitle_mode: config.subtitleMode,
    result
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
