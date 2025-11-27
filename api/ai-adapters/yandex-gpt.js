export class YandexGPTAdapter {
  constructor() {
    this.name = "yandex-gpt";
    this.modelUri = `gpt://${process.env.YANDEX_FOLDER_ID}/qwen3-235b-a22b-fp8/latest`;
  }

  async generateCode(prompt) {
    console.log(
      `YANDEX GPT Qwen3 СТАРТУЕТ (folder: ${process.env.YANDEX_FOLDER_ID})`
    );

    const response = await fetch(
      "https://llm.api.cloud.yandex.net/foundationModels/v1/completion", // Фикс: правильный endpoint (не /chat/completions)
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`,
        },
        body: JSON.stringify({
          modelUri: this.modelUri,
          completionOptions: {
            // Фикс: параметры в completionOptions (docs требуют)
            stream: false,
            temperature: 0.3,
            maxTokens: 16000,
          },
          messages: [
            // Фикс: messages для chat-режима (работает в /completion)
            // System-промпт минимальный (или удали, если UI-инструкция хватит)
            {
              role: "system",
              text: "Ты агент-программист. Следуй инструкциям и схеме. Отвечай ТОЛЬКО чистым JSON-массивом операций (без текста, markdown).",
            },
            {
              role: "user",
              text: prompt, // Задача от пользователя
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
    let content = data.result.alternatives[0].message.text.trim(); // Фикс: .text (не .content)

    // Fallback для очистки JSON (если добавит мусор)
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
