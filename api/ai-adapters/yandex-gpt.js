export class YandexGPTAdapter {
  constructor() {
    this.name = "yandex-gpt";
    this.modelUri = `gpt://${process.env.YANDEX_FOLDER_ID}/qwen3-235b-a22b-fp8/latest`;
  }

  async generateCode(prompt) {
    console.log(`YANDEX GPT → ${this.modelUri}`);

    const response = await fetch(
      "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`,
        },
        body: JSON.stringify({
          modelUri: this.modelUri,
          completionOptions: {
            temperature: 0.1,
            maxTokens: 16000,
          },
          messages: [
            {
              role: "system",
              text: `Ты агент-программист. Отвечай ТОЛЬКО чистым JSON-массивом в точно таком формате:

[
  {
    "path": "README.md",
    "action": "update",
    "content": "# CryptoDash\\n\\nСовременный крипто-дашборд уровня Binance"
  },
  {
    "path": "src/app/page.tsx",
    "action": "create",
    "content": "export default function Home() {\\n  return <div>Hello world</div>\\n}"
  }
]

Без \\\`\\\`\\\`json, без текста до и после, без пояснений. Только массив от [ до ]. 
В content используй \\\\n для переноса строки и \\\\t для табуляции. Не вставляй реальные переводы строк.`,
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
      const err = await response.text();
      console.error("YANDEX ERROR:", response.status, err);
      throw new Error(`YandexGPT: ${response.status} ${err}`);
    }

    const data = await response.json();
    const rawText = data.result?.alternatives?.[0]?.message?.text?.trim() || "";

    if (!rawText) {
      throw new Error("Пустой ответ от YandexGPT");
    }

    console.log("Сырой ответ YandexGPT (первые 800 символов):");
    console.log(rawText.substring(0, 800));

    // 1. Вырезаем только JSON-массив
    const jsonStart = rawText.indexOf("[");
    const jsonEnd = rawText.lastIndexOf("]");
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
      throw new Error("Не найден JSON-массив в ответе YandexGPT");
    }

    let jsonStr = rawText.substring(jsonStart, jsonEnd + 1);

    // 2. Пробуем распарсить как есть (модель дала \\n)
    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log(`Успешно распарсено ${parsed.length} операций без фиксов`);
        return parsed;
      }
    } catch (e) {
      console.log("JSON невалидный как есть — включаем фикс сырых переносов");
    }

    // 3. Фиксим сырые переводы строк только внутри строковых значений
    jsonStr = jsonStr.replace(/"(?:[^"\\]|\\.)*"/g, (match) => {
      return match
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");
    });

    console.log("После экранирования сырых переносов (первые 600 символов):");
    console.log(jsonStr.substring(0, 600));

    // 4. Финальный парсинг
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.error("ФАТАЛЬНО: JSON.parse не прошёл даже после фикса");
      console.error("Проблемный JSON:", jsonStr.substring(0, 1500));
      throw new Error(`YandexGPT вернул невалидный JSON: ${e.message}`);
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("YandexGPT вернул пустой или не массив");
    }

    console.log(`УСПЕШНО: получено ${parsed.length} файловых операций`);
    return parsed;
  }
}
