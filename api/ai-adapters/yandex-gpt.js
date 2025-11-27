export class YandexGPTAdapter {
  constructor() {
    this.name = "yandex-gpt";
    // Для OpenAI API: модель как строка (не modelUri). Qwen3 — ок, или "yandexgpt-5-1-pro-rc"
    this.model = "qwen3-235b-a22b-fp8/latest";
  }

  async generateCode(prompt) {
    console.log(
      `YANDEX GPT Qwen3 OpenAI API СТАРТУЕТ (folder: ${process.env.YANDEX_FOLDER_ID})`
    );

    const response = await fetch(
      "https://llm.api.cloud.yandex.net/foundationModels/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`,
          // Добавь folder_id в header, если API требует (из docs для некоторых моделей)
          "X-Folder-ID": process.env.YANDEX_FOLDER_ID,
        },
        body: JSON.stringify({
          model: this.model, // Фикс: 'model' как строка (OpenAI-style)
          messages: [
            // Фикс: Стандартные messages (без completionOptions)
            {
              role: "system",
              content:
                "Ты агент-программист. Следуй инструкциям и схеме. Отвечай ТОЛЬКО чистым JSON-массивом операций (без текста, markdown).", // Минимальный, опционально удали
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0.3,
          max_tokens: 16000, // Фикс: max_tokens (не maxTokens)
          response_format: {
            // Фикс: Native json_schema support в OpenAI API!
            type: "json_schema",
            json_schema: {
              name: "file_operations",
              strict: true,
              schema: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    path: {
                      type: "string",
                      description:
                        "Путь к файлу без слеша в начале (например, 'src/index.js')",
                    },
                    action: {
                      type: "string",
                      enum: ["create", "update", "delete"],
                    },
                    content: {
                      type: ["string", "null"],
                      description:
                        "Содержимое файла, \\n для переносов. Для delete можно null",
                    },
                  },
                  required: ["path", "action"],
                  additionalProperties: false,
                },
              },
            },
          },
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
    const content = data.choices[0].message.content.trim(); // Фикс: OpenAI-style path (.choices[0].message.content)

    console.log("YANDEX GPT ОТВЕТИЛ (первые 1000 символов):");
    console.log(
      content.substring(0, 1000) +
        (content.length > 1000 ? "\n... (обрезано)" : "")
    );

    // С strict: true — всегда чистый JSON, fallback не нужен, но оставил для safety
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
