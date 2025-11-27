export class PerplexityAdapter {
  constructor() {
    this.name = "perplexity";
    this.model = "sonar-pro";
  }

  async generateCode(prompt) {
    console.log(
      `ПЕРПЛЕКСИТИ СТАРТУЕТ, ТОКЕН: ${
        process.env.PERPLEXITY_KEY ? "ЕСТЬ" : "НЕТ"
      }`
    );

    const response = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PERPLEXITY_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 16000,
        temperature: 0.4,
        response_format: {
          type: "json_schema",
          json_schema: {
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
                      "Путь к файлу, без слеша в начале (e.g., 'README.md')",
                  },
                  action: {
                    type: "string",
                    enum: ["create", "update", "delete"],
                  },
                  content: {
                    type: "string",
                    description:
                      "Содержимое файла (экранированное: \\n для переноса строки)",
                  },
                },
                required: ["path", "action"],
                additionalProperties: false,
              },
              minItems: 0,
              maxItems: 50,
            },
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error("Perplexity: " + (await response.text()));
    }

    const data = await response.json();
    const content = data.choices[0].message.content.trim();

    console.log("ПЕРПЛЕКСИТИ ОТВЕТИЛ (первые 1000 символов):");
    console.log(
      content.substring(0, 1000) +
        (content.length > 1000 ? "\n... (обрезано)" : "")
    );

    return JSON.parse(content);
  }
}
