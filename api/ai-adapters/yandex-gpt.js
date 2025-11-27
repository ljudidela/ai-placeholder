export class YandexGPTAdapter {
  constructor() {
    this.name = "yandex-gpt";
    this.modelUri = `gpt://${process.env.YANDEX_FOLDER_ID}/aliceai-llm/latest`;
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
          completionOptions: { temperature: 0.1, maxTokens: 16000 },
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
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`YandexGPT: ${response.status} ${err}`);
    }

    const data = await response.json();
    const rawText = data.result?.alternatives?.[0]?.message?.text?.trim() || "";

    const jsonStart = rawText.indexOf("[");
    const jsonEnd = rawText.lastIndexOf("]");
    if (jsonStart === -1 || jsonEnd <= jsonStart)
      throw new Error("Нет JSON-массива");

    let jsonStr = rawText.substring(jsonStart, jsonEnd + 1);

    try {
      return JSON.parse(jsonStr);
    } catch (_) {}

    jsonStr = jsonStr.replace(/"(?:[^"\\]|\\.)*"/g, (m) =>
      m.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
    );

    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) throw new Error("Не массив");
    return parsed;
  }
}
