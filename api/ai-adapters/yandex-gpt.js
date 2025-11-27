export class YandexGPTAdapter {
  constructor() {
    this.name = "yandex-gpt";
    // Твоя модель, не трогаю
    this.modelUri = `gpt://${process.env.YANDEX_FOLDER_ID}/yandexgpt/rc`;
  }

  async generateCode(prompt) {
    console.log(`YANDEX GPT → ${this.modelUri}`);

    const response = await fetch(
      "https://llm.api.cloud.yandex.net/foundationModels/v1/completion", // Фикс: Правильный endpoint (без /chat/completions)
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`,
          // Убираю X-Folder-Id — он только для OpenAI-compat, а не для /completion
        },
        body: JSON.stringify({
          modelUri: this.modelUri,
          completionOptions: {
            // Фикс: Обязательно в completionOptions для /completion
            temperature: 0.3,
            maxTokens: 16000, // Фикс: maxTokens, не max_tokens
          },
          messages: [
            // Фикс: messages с text, не content
            {
              role: "system",
              text: `Ты агент-программист. Отвечай ТОЛЬКО валидным JSON-массивом операций по схеме:
{
  "type": "array",
  "minItems": 1,
  "maxItems": 50,
  "items": {
    "type": "object",
    "required": ["path", "action", "content"],
    "additionalProperties": false,
    "properties": {
      "path": {"type": "string", "description": "Путь к файлу без слеша в начале"},
      "action": {"type": "string", "enum": ["create", "update", "delete"]},
      "content": {"type": ["string", "null"], "description": "Содержимое файла. Для 'delete' — null"}
    }
  }
}
Никакого текста, markdown, объяснений. Если задача большая — создай базовые файлы.`, // Фикс: Схема в system-text (response_format не поддерживается)
            },
            {
              role: "user",
              text: prompt, // Фикс: text, не content
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error("YANDEX ERROR:", response.status, err);
      throw new Error(`YandexGPT: ${response.status} ${err}`);
    }

    const data = await response.json();
    // Фикс: Правильный путь для /completion (не OpenAI choices)
    const content = data.result?.alternatives?.[0]?.message?.text?.trim() || "";

    if (!content) {
      throw new Error("Empty response from YandexGPT");
    }

    console.log("YANDEX ОТВЕТИЛ (первые 1000 символов):");
    console.log(
      content.substring(0, 1000) +
        (content.length > 1000 ? "\n... (обрезано)" : "")
    );

    // Фикс: Обрезка JSON (fallback, т.к. response_format не работает)
    const jsonMatch = content.match(/(\[.*?\]|\{.*?\})/s);
    const cleanContent = jsonMatch ? jsonMatch[0] : content;

    return JSON.parse(cleanContent);
  }
}
