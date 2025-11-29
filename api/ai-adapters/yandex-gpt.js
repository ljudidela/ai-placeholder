export class YandexGPTAdapter {
  constructor() {
    this.name = "yandex-gpt";
    this.modelUri = `gpt://${process.env.YANDEX_FOLDER_ID}/yandexgpt/rc`;
  }

  async generateCode(prompt) {
    console.log(`🚀 YANDEX GPT → Запуск модели: ${this.modelUri}`);
    console.log(`📤 ПРОМПТ (полный, без обрезки):`);
    console.log(`──────────────────────────────────────────────────`);
    console.log(prompt);
    console.log(`──────────────────────────────────────────────────\n`);

    const requestBody = {
      modelUri: this.modelUri,
      completionOptions: { temperature: 0.2, maxTokens: 32000 },
      messages: [
        {
          role: "system",
          text: `Ты агент-программист. Отвечай ТОЛЬКО чистым JSON-массивом:

[
  {"path": "src/components/Header.tsx", "action": "create", "content": "код...\\n..."},
  {"path": "src/app/page.tsx", "action": "update", "content": "обновлённый код..."}
]

Без markdown, без текста. Только массив. В content используй \\n и \\t.`,
        },
        { role: "user", text: prompt },
      ],
    };

    console.log(`📡 ОТПРАВЛЯЕМ ЗАПРОС на /completion...`);
    console.log(`   Headers: Authorization: Api-Key *** (скрыто)`);
    console.log(`   Body (полный):`);
    console.log(JSON.stringify(requestBody, null, 2));
    console.log(`\n⏳ Ждём ответа от YandexGPT...\n`);

    const response = await fetch(
      "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
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
        `❌ YANDEX ERROR ${response.status}: ${err.substring(0, 500)}`
      );
      throw new Error(`YandexGPT: ${response.status} ${err}`);
    }

    const data = await response.json();
    const rawText = data.result?.alternatives?.[0]?.message?.text?.trim() || "";

    if (!rawText) {
      console.error(
        `⚠️ ПУСТОЙ ОТВЕТ от YandexGPT! data:`,
        JSON.stringify(data, null, 2)
      );
      throw new Error("Пустой ответ от YandexGPT");
    }

    console.log(`✅ ОТВЕТ ПОЛУЧЕН! Длина rawText: ${rawText.length} символов`);
    console.log(`📥 RAW ОТВЕТ (начало + середина + конец):`);

    const chunkSize = 600;
    const start = rawText.substring(0, chunkSize);
    const middle =
      rawText.length > chunkSize * 2
        ? rawText.substring(
            Math.floor(rawText.length / 2) - chunkSize / 2,
            Math.floor(rawText.length / 2) + chunkSize / 2
          )
        : "";
    const end = rawText.substring(-chunkSize);

    console.log(`   ┌─ НАЧАЛО ─────────────────────────────────────`);
    console.log(start);
    if (middle) {
      console.log(`   ├─ СЕРЕДИНА ───────────────────────────────────`);
      console.log(middle);
    }
    console.log(`   └─ КОНЕЦ ───────────────────────────────────────`);
    console.log(end);
    console.log(`\n🔍 Ищем JSON-массив в ответе...`);

    const jsonStart = rawText.indexOf("[");
    const jsonEnd = rawText.lastIndexOf("]");
    if (jsonStart === -1 || jsonEnd <= jsonStart) {
      console.error(
        `🚨 JSON-массив НЕ НАЙДЕН! jsonStart: ${jsonStart}, jsonEnd: ${jsonEnd}`
      );
      throw new Error("Нет JSON-массива в ответе");
    }

    let jsonStr = rawText.substring(jsonStart, jsonEnd + 1);
    console.log(
      `✂️ Вырезан JSON: ${jsonStr.length} символов (от ${jsonStart} до ${jsonEnd})`
    );

    // Попробуем распарсить как есть
    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log(
          `🎉 JSON УСПЕШНО РАСПАРСЕН БЕЗ ФИКСОВ! Получено ${parsed.length} операций`
        );
        parsed.forEach((op, i) => {
          console.log(`   [${i + 1}] ${op.action.toUpperCase()} → ${op.path}`);
        });
        return parsed;
      }
    } catch (e) {
      console.log(`⚠️ JSON.parse упал как есть: ${e.message}`);
      console.log(`🔧 Включаем фикс сырых переносов...`);
    }

    // Фикс сырых \n внутри строк
    jsonStr = jsonStr.replace(/"(?:[^"\\]|\\.)*"/g, (m) =>
      m.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
    );

    console.log(`🛠️ После фикса (первые 600 символов):`);
    console.log(jsonStr.substring(0, 600));
    if (jsonStr.length > 600)
      console.log(`... (ещё ${jsonStr.length - 600} символов)`);

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.error(`💥 ФАТАЛЬНО: JSON.parse не прошёл даже после фикса`);
      console.error(
        `Проблемный JSON (первые 1000):`,
        jsonStr.substring(0, 1000)
      );
      throw new Error(`YandexGPT вернул невалидный JSON: ${e.message}`);
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("YandexGPT вернул пустой или не массив");
    }

    console.log(`🎊 УСПЕХ! Получено ${parsed.length} файловых операций:`);
    parsed.forEach((op, i) => {
      const size = op.content ? Buffer.byteLength(op.content, "utf8") : 0;
      console.log(`   ${i + 1}. ${op.action} → ${op.path} (${size} байт)`);
    });

    return parsed;
  }
}
