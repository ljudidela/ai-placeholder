import { PerplexityAdapter } from "./perplexity.js";
import { YandexGPTAdapter } from "./yandex-gpt.js";
import { QwenAdapter } from "./qwen.js";
import { NeuroAdapter } from "./neuro.js";

const adapters = {
  perplexity: PerplexityAdapter,
  yandex: YandexGPTAdapter,
  "yandex-gpt": YandexGPTAdapter,
  qwen: QwenAdapter,
  neuro: NeuroAdapter,
};

export function getAdapter(providerName) {
  const AdapterClass = adapters[providerName.toLowerCase()];
  if (!AdapterClass) {
    throw new Error(
      `Неизвестный AI провайдер: ${providerName}. Доступные: ${Object.keys(
        adapters
      ).join(", ")}`
    );
  }
  return new AdapterClass();
}

export { PerplexityAdapter, YandexGPTAdapter, QwenAdapter, NeuroAdapter };
