import { PerplexityAdapter } from "./perplexity.js";
import { YandexGPTAdapter } from "./yandex-gpt.js";

const adapters = {
  perplexity: PerplexityAdapter,
  yandex: YandexGPTAdapter,
  "yandex-gpt": YandexGPTAdapter,
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

export { PerplexityAdapter, YandexGPTAdapter };
