import OpenAI from "openai";

export class QwenAdapter {
  constructor() {
    this.name = "qwen";
    this.modelUri = `gpt://${process.env.YANDEX_FOLDER_ID}/qwen3-235b-a22b-fp8/latest`;

    // Инициализируем клиент один раз — быстрее и чище
    this.client = new OpenAI({
      apiKey: process.env.YANDEX_API_KEY,
      baseURL: "https://llm.api.cloud.yandex.net/v1",
      defaultHeaders: {
        "x-folder-id": process.env.YANDEX_FOLDER_ID,
      },
    });
  }

  async generateCode(prompt) {
    console.log(`QWEN → /chat/completions (OpenAI-совместимый)`);
    console.log(`   Модель: ${this.modelUri}`);

    const jsonSchema = {
      type: "array",
      minItems: 1,
      maxItems: 60,
      items: {
        type: "object",
        required: ["path", "action", "content"],
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          action: { type: "string", enum: ["create", "update", "delete"] },
          content: { type: ["string", "null"] },
        },
      },
    };

    const requestBody = {
      model: this.modelUri,
      temperature: 0.4,
      max_tokens: 16000,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "file_operations",
          strict: true,
          schema: jsonSchema,
        },
      },
      messages: [
        {
          role: "system",
          content: `Ты — автономный агент-программист, который общается с внешним миром ТОЛЬКО через строго структурированный JSON по указанной ниже схеме. 

Правила, которые ты обязан соблюдать без единого исключения:
1. Отвечай ИСКЛЮЧИТЕЛЬНО валидным JSON, соответствующим схеме. Никакого текста до, после или внутри JSON быть не должно.
2. Не пиши объяснения, не пиши комментарии, не используй markdown.
3. Если нужно создать/обновить файл — указывай точный относительный путь без начального слеша.
4. В поле content используй \\n для переноса строки и экранируй обратные слеши, кавычки и другие спецсимволы, если они есть в коде.
5. Если ничего делать не нужно — возвращай пустой массив [].`,
        },
        { role: "user", content: prompt },
      ],
    };

    console.log(`\nОТПРАВЛЯЕМ ПРОМПТ AI (${prompt.length} символов):`);
    console.log("═".repeat(80));
    console.log(prompt);
    console.log("═".repeat(80));

    console.log(`\nОТПРАВЛЯЕМ ЗАПРОС на /chat/completions...`);
    console.log(`   Body (полный):`);
    console.log(JSON.stringify(requestBody, null, 2));

    let completion;
    try {
      completion = await this.client.chat.completions.create(requestBody);
    } catch (error) {
      console.error(
        "\nYANDEX ERROR (OpenAI SDK):",
        error.status,
        error.message
      );
      if (error.response) {
        const errText = await error.response.text();
        console.error(errText.substring(0, 500));
      }
      throw new Error(`YandexGPT API error: ${error.message}`);
    }

    const rawContent = completion.choices?.[0]?.message?.content?.trim() || "";

    if (!rawContent) {
      console.error("Пустой content от YandexGPT!");
      throw new Error("Пустой ответ");
    }

    console.log(`\nОТВЕТ ПОЛУЧЕН! Длина: ${rawContent.length} символов`);
    console.log(`RAW ОТВЕТ (начало + середина + конец):`);

    const chunk = 600;
    const start = rawContent.substring(0, chunk);
    const middle =
      rawContent.length > chunk * 2
        ? rawContent.substring(
            Math.floor(rawContent.length / 2) - chunk / 2,
            Math.floor(rawContent.length / 2) + chunk / 2
          )
        : "";
    const end = rawContent.slice(-chunk);

    console.log(`   ┌─ НАЧАЛО ─────────────────────────────────────`);
    console.log(start);
    if (middle) {
      console.log(`   ├─ СЕРЕДИНА ───────────────────────────────────`);
      console.log(middle);
    }
    console.log(`   └─ КОНЕЦ ───────────────────────────────────────`);
    console.log(end);

    let parsed;
    try {
      parsed = JSON.parse(rawContent);
      console.log(
        `\nJSON УСПЕШНО РАСПАРСЕН! Получено ${parsed.length} операций`
      );
      parsed.forEach((op, i) => {
        const size = op.content ? Buffer.byteLength(op.content, "utf8") : 0;
        console.log(
          `   ${i + 1}. ${op.action.toUpperCase()} → ${op.path} (${size} байт)`
        );
      });
    } catch (e) {
      console.error(
        `\nФАТАЛЬНО: JSON.parse провалился даже с response_format!`
      );
      console.error(`Первые 1000 символов:`, rawContent.substring(0, 1000));
      throw new Error(`YandexGPT вернул невалидный JSON: ${e.message}`);
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("Пустой или не массив");
    }

    console.log(`\nВСЁ! Успешно получено ${parsed.length} файловых операций\n`);
    return parsed;
  }
}
