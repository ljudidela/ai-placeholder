export class YandexGPTAdapter {
  constructor() {
    this.name = "yandex-gpt";
    this.modelUri = `gpt://${process.env.YANDEX_FOLDER_ID}/yandexgpt/rc`;
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
            temperature: 0.1, // ↓↓↓ понизил — стабильность важнее креатива
            maxTokens: 16000,
          },
          messages: [
            {
              role: "system",
              text: `Ты — агент-программист. Отвечай ТОЛЬКО чистым JSON-массивом. Пример:

[
  {
    "path": "README.md",
    "action": "update",
    "content": "# Заголовок\\n\\nТекст с переносами"
  }
]

Никаких \`\`\`json, никаких объяснений, никакого текста до или после. Только массив от [ до ]. 
В content используй \\n для переноса строки — это будет преобразовано автоматически. 
Не экранируй лишнего. Не пиши схему. Просто верни массив.`,
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
    const rawText = data.result?.alternatives?.[0]?.message?.text || "";

    if (!rawText.includes("[")) {
      throw new Error("YandexGPT не вернул JSON-массив");
    }

    const jsonStart = rawText.indexOf("[");
    const jsonEnd = rawText.lastIndexOf("]");
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
      throw new Error("Не найден корректный JSON-массив в ответе");
    }

    let jsonStr = rawText.substring(jsonStart, jsonEnd + 1);

    // ← Это и есть магия: превращаем \\n → \n
    jsonStr = jsonStr
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.error("JSON.parse failed после очистки:");
      console.error("Проблемный кусок:", jsonStr.substring(0, 1000));
      throw new Error(`YandexGPT вернул невалидный JSON: ${e.message}`);
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("Пустой или не массив");
    }

    console.log(`Успешно получено ${parsed.length} файловых операций`);
    return parsed;
  }
}
