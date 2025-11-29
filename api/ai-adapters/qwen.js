export class QwenAdapter {
  constructor() {
    this.name = "qwen";
    this.modelUri = `gpt://${process.env.YANDEX_FOLDER_ID}/qwen3-235b-a22b-fp8/latest`;
  }

  async generateCode(prompt) {
    console.log(`QWEN → /chat/completions (OpenAI-совместимый)`);
    console.log(`   Модель: ${this.modelUri}`);

    // Твоя схема — копия из настроек Yandex Cloud
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
      model: this.modelUri, // ← model, а не modelUri
      temperature: 0.3,
      max_tokens: 32000,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "file_operations",
          strict: true, // ← ЭТО КЛЮЧЕВОЕ: модель не посмеет выебнуться
          schema: jsonSchema,
        },
      },
      messages: [
        {
          role: "system",
          content: `Ты — senior full-stack разработчик. Анализируй проект и задачу.
Возвращай ТОЛЬКО массив изменений файлов по схеме выше.
Никакого текста, markdown, пояснений — только чистый JSON.`,
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

    const response = await fetch(
      "https://llm.api.cloud.yandex.net/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`,
        },
        body: JSON.stringify(requestBody),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error(
        `\nYANDEX ERROR ${response.status}: ${err.substring(0, 500)}`
      );
      throw new Error(`YandexGPT: ${response.status} ${err}`);
    }

    const data = await response.json();
    const rawContent = data.choices?.[0]?.message?.content?.trim() || "";

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

    // Чистый JSON — парсим без хаков
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
