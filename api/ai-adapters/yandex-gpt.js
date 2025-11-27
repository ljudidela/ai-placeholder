export class YandexGPTAdapter {
  constructor() {
    this.name = "yandex-gpt";
    // Используем именно новую модель (RC тоже работает)
    this.modelUri = `gpt://${process.env.YANDEX_FOLDER_ID}/qwen3-235b-a22b-fp8/latest`;
  }

  async generateCode(prompt) {
    console.log(
      `YANDEX GPT 5.1 Pro СТАРТУЕТ (folder: ${process.env.YANDEX_FOLDER_ID})`
    );

    const response = await fetch(
      "https://llm.api.cloud.yandex.net/foundationModels/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`,
        },
        body: JSON.stringify({
          modelUri: this.modelUri,
          temperature: 0.3,
          maxTokens: 16000,
          responseFormat: {
            type: "json_schema",
            jsonSchema: {
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
          messages: [
            {
              role: "system",
              text: `Ты автономный агент-программист. Отвечай ТОЛЬКО валидным JSON строго по схеме ниже. 
Никакого текста, markdown, объяснений. Если ничего делать не нужно — верни пустой массив [].`,
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
    const content = data.result.alternatives[0].message.content.trim();

    console.log("YANDEX GPT ОТВЕТИЛ (первые 1000 символов):");
    console.log(
      content.substring(0, 1000) +
        (content.length > 1000 ? "\n... (обрезано)" : "")
    );

    // Теперь можно безопасно парсить — Yandex гарантирует валидный JSON при strict: true
    return JSON.parse(content);
  }
}
