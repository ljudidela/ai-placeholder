export class YandexGPTAdapter {
  constructor() {
    this.name = "yandex-gpt";
    this.modelUri = `gpt://${process.env.YANDEX_FOLDER_ID}/yandexgpt-5-1-pro-rc`; // Фикс: Нативная модель (Qwen не в gRPC API)
  }

  async generateCode(prompt) {
    console.log(
      `YANDEX GPT 5.1 Pro СТАРТУЕТ (folder: ${process.env.YANDEX_FOLDER_ID})`
    );

    const response = await fetch(
      "https://llm.api.cloud.yandex.net/foundationModels/v1/completion", // Фикс: Стандартный endpoint (НЕ /chat/completions — 404 там)
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`, // Или Bearer IAM_TOKEN, если используешь IAM
        },
        body: JSON.stringify({
          modelUri: this.modelUri,
          completionOptions: {
            // Фикс: Параметры в completionOptions (обязательно для /completion)
            stream: false,
            temperature: 0.3,
            maxTokens: 16000,
          },
          messages: [
            // Фикс: messages с text (не content — для Yandex spec)
            {
              role: "system",
              text: "Ты агент-программист. Следуй инструкциям и схеме. Отвечай ТОЛЬКО чистым JSON-массивом операций (без текста, markdown).", // Минимальный reminder
            },
            {
              role: "user",
              text: prompt,
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`YANDEX GPT ERROR RESPONSE:`, {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: errorText,
      });
      throw new Error(`YandexGPT error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    let content = data.result.alternatives[0].message.text.trim(); // Фикс: .text (Yandex spec)

    // Fallback для JSON-очистки (если добавит мусор — редко с UI-инструкцией)
    const jsonMatch = content.match(/[\[\{].*[\]\}]/s);
    if (jsonMatch) {
      content = jsonMatch[0];
    }

    console.log("YANDEX GPT ОТВЕТИЛ (первые 1000 символов):");
    console.log(
      content.substring(0, 1000) +
        (content.length > 1000 ? "\n... (обрезано)" : "")
    );

    try {
      return JSON.parse(content);
    } catch (parseError) {
      console.error("JSON PARSE ERROR:", parseError.message);
      console.error("RAW CONTENT:", content);
      throw new Error(
        `AI (yandex) вернул невалидный JSON: ${
          parseError.message
        }. Raw: ${content.substring(0, 500)}`
      );
    }
  }
}
