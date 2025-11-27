export class YandexGPTAdapter {
  constructor() {
    this.name = "yandex-gpt";
    // Любая модель из твоего списка в UI — просто пиши как строку
    this.modelUri = `gpt://${process.env.YANDEX_FOLDER_ID}/yandexgpt-5-1-pro-rc`;
    // Если хочешь Qwen3 — просто: "qwen3-235b-a22b-fp8/latest"
  }

  async generateCode(prompt) {
    console.log(`YANDEX GPT (OpenAI API) → ${this.modelUri}`);

    const response = await fetch(
      "https://llm.api.cloud.yandex.net/foundationModels/v1/chat/completions", // ← ЭТОТ ЭНДПОИНТ РАБОТАЕТ КАК В UI
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`,
          "X-Folder-Id": process.env.YANDEX_FOLDER_ID, // ← Обязательно для OpenAI-совместимого режима!
        },
        body: JSON.stringify({
          modelUri: this.modelUri,
          temperature: 0.3,
          max_tokens: 16000,
          messages: [
            { role: "user", content: prompt },
            // ← system-промпт НЕ НУЖЕН — у тебя уже вшит в UI как "Инструкция"
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "file_operations",
              strict: true,
              schema: {
                type: "array",
                minItems: 1,
                maxItems: 50,
                items: {
                  type: "object",
                  required: ["path", "action", "content"],
                  additionalProperties: false,
                  properties: {
                    path: {
                      type: "string",
                      description:
                        "Путь к файлу без слеша в начале (например, 'src/app/page.tsx')",
                    },
                    action: {
                      type: "string",
                      enum: ["create", "update", "delete"],
                    },
                    content: {
                      type: ["string", "null"],
                      description:
                        "Содержимое файла. Для 'delete' — null. \\n для переносов строк.",
                    },
                  },
                },
              },
            },
          },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error("YANDEX ERROR:", response.status, err);
      throw new Error(`YandexGPT: ${response.status} ${err}`);
    }

    const data = await response.json();
    const content = data.choices[0].message.content.trim();

    console.log("YANDEX ОТВЕТИЛ (первые 1000 символов):");
    console.log(
      content.substring(0, 1000) +
        (content.length > 1000 ? "\n... (обрезано)" : "")
    );

    return JSON.parse(content); // ← с strict: true всегда чистый JSON
  }
}
