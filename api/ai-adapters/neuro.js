export class NeuroAdapter {
  constructor() {
    this.name = "neuro";
    this.modelUri = "gemini-3-pro-preview-thinking";
  }

  async generateCode(prompt) {
    console.log(`GEMINI (NeuroAPI) → /v1/chat/completions`);
    console.log(`   Модель: ${this.modelUri}`);

    // Схема для Gemini (без enum, type как массив)
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
          action: { type: "string" },
          content: { type: ["string", "null"] },
        },
      },
    };

    const requestBody = {
      model: this.modelUri,
      temperature: 0.2,
      max_tokens: 32000,
      generation_config: {
        response_mime_type: "application/json",
        response_schema: jsonSchema,
      },
      messages: [
        {
          role: "system",
          content: `Ты — автономный агент-программист, который общается с внешним миром ТОЛЬКО через строго структурированный JSON по указанной ниже схеме.

Правила, которые ты обязан соблюдать без единого исключения:
1. Отвечай ИСКЛЮЧИТЕЛЬНО валидным JSON, соответствующим схеме. Никакого текста до, после или внутри JSON быть не должно. НЕ добавляй markdown, backticks или \`\`\`json.
2. Не пиши объяснения, не пиши комментарии, не используй markdown.
3. Если нужно создать/обновить файл — указывай точный относительный путь без начального слеша.
4. В поле content используй \\n для переноса строки и экранируй обратные слеши, кавычки и другие спецсимволы, если они есть в коде. Если контент пустой — используй null.
5. action может быть ТОЛЬКО: "create", "update" или "delete". НИКОГДА не используй другие значения.
6. Если ничего делать не нужно — возвращай пустой массив [].`,
        },
        { role: "user", content: prompt },
      ],
    };

    console.log(`\nОТПРАВЛЯЕМ ПРОМПТ AI (${prompt.length} символов):`);
    console.log("═".repeat(80));
    console.log(prompt);
    console.log("═".repeat(80));

    console.log(`\nОТПРАВЛЯЕМ ЗАПРОС на /v1/chat/completions...`);
    console.log(`   Body (полный):`);
    console.log(JSON.stringify(requestBody, null, 2));

    const response = await fetch("https://neuroapi.host/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.NEURO_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(
        `\nNEUROAPI ERROR ${response.status}: ${err.substring(0, 500)}`
      );
      throw new Error(`NeuroAPI/Gemini: ${response.status} ${err}`);
    }

    const data = await response.json();
    let rawContent = data.choices?.[0]?.message?.content?.trim() || "";

    if (!rawContent) {
      console.error("Пустой content от Gemini!");
      throw new Error("Пустой ответ");
    }

    // Убираем \`\`\`json и \`\`\`
    rawContent = rawContent
      .replace(/^```json\s*\n?/, "")
      .replace(/\n?```\s*$/, "")
      .trim();

    console.log(
      `\nОЧИЩЕННЫЙ RAW ОТВЕТ (после удаления MD): Длина: ${rawContent.length} символов`
    );

    console.log(`ОЧИЩЕННЫЙ RAW (начало + середина + конец):`);
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
      console.error(`\nФАТАЛЬНО: JSON.parse провалился даже после очистки!`);
      console.error(
        `Первые 1000 символов очищенного:`,
        rawContent.substring(0, 1000)
      );
      throw new Error(`Gemini вернул невалидный JSON: ${e.message}`);
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("Пустой или не массив");
    }

    console.log(`\nВСЁ! Успешно получено ${parsed.length} файловых операций\n`);
    return parsed;
  }
}
