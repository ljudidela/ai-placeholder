// api/trello-webhook.js   (или pages/api/trello-webhook.js)
import { Octokit } from "@octokit/rest";
import fetch from "node-fetch";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const ORG = "ljudidela";
const GITHUB_BASE = `https://github.com/${ORG}`;

export default async function handler(req, res) {
  // Trello шлёт HEAD для проверки
  if (req.method === "HEAD") return res.status(200).end();
  if (req.method === "GET")
    return res.status(200).send("Trello → AI → GitHub alive");

  if (req.method !== "POST") return res.status(405).end();

  try {
    const action = req.body?.action;
    if (!action || action.type !== "createCard") {
      return res.status(200).json({ message: "Не createCard — игнор" });
    }

    const card = action.data.card;
    const cardName = card.name.trim();
    const cardDesc = (card.desc || "Без описания").trim();
    const cardId = card.id;

    console.log("Новая карточка:", cardName);

    // 1. Perplexity AI
    const prompt = `Ты — senior full-stack разработчик. Создай полностью рабочий проект по описанию ниже.
Возвращай ТОЛЬКО содержимое README.md (никаких \`\`\`, объяснений, только текст).
Проект должен быть готов к запуску.

Описание:
${cardDesc}`;

    const aiRes = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PERPLEXITY_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.1-sonar-large-128k-online",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4000,
        temperature: 0.6,
      }),
    });

    if (!aiRes.ok) throw new Error("Perplexity упал: " + (await aiRes.text()));

    const aiData = await aiRes.json();
    const readmeContent = aiData.choices[0].message.content.trim();

    // 2. Создаём репо
    const repoName = cardName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");

    await octokit.repos.createInOrg({
      org: ORG,
      name: repoName,
      private: true,
    });

    // 3. Пушим README
    await octokit.repos.createOrUpdateFileContents({
      owner: ORG,
      repo: repoName,
      path: "README.md",
      message: "AI generated project",
      content: Buffer.from(readmeContent).toString("base64"),
    });

    const repoUrl = `${GITHUB_BASE}/${repoName}`;

    // 4. Комментарий в Trello
    const comment = `Репозиторий создан автоматически\n${repoUrl}`;
    await fetch(
      `https://api.trello.com/1/cards/${cardId}/actions/comments?key=${
        process.env.TRELLO_KEY
      }&token=${process.env.TRELLO_TOKEN}&text=${encodeURIComponent(comment)}`,
      { method: "POST" }
    );

    // 5. Опционально — автодеплой на Vercel (если хочешь)
    if (process.env.VERCEL_TOKEN) {
      await fetch("https://api.vercel.com/v13/deployments", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: repoName,
          gitSource: {
            type: "github",
            repo: `${ORG}/${repoName}`,
            ref: "main",
          },
        }),
      });
    }

    res.status(200).json({ success: true, repo: repoUrl });
  } catch (err) {
    console.error("Ошибка:", err.message);
    res.status(500).json({ error: err.message });
  }
}

// Отключаем bodyParser — Trello шлёт raw JSON
export const config = {
  api: {
    bodyParser: false,
  },
};
