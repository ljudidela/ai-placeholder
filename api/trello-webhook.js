import { Octokit } from "@octokit/rest";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const ORG = "ljudidela";
const GITHUB_BASE = `https://github.com/${ORG}`;

export default async function handler(req, res) {
  console.log("Webhook прилетел, тело:", JSON.stringify(req.body, null, 2));
  console.log("Тип действия:", req.body.action?.type);
  console.log("Модель:", req.body.model?.name);

  if (req.body.action?.type !== "createCard") {
    console.log("Не createCard → игнорим");
    return res.status(200).end();
  }

  const cardName = req.body.action?.data?.card?.name;
  const cardDesc = req.body.action?.data?.card?.desc || "без описания";
  const cardId = req.body.action?.data?.card?.id;

  console.log("НОВАЯ КАРТОЧКА!", { cardName, cardDesc, cardId });

  if (req.method === "HEAD" || req.method === "GET") {
    return res.status(200).send("Trello webhook alive → AI → GitHub");
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

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

    const prompt = `Ты — senior full-stack разработчик. Создай полностью рабочий проект по описанию ниже.
Возвращай ТОЛЬКО содержимое README.md (никаких \`\`\`, объяснений, только текст).

Описание:
${cardDesc}`;

    const aiRes = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PERPLEXITY_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4000,
        temperature: 0.6,
      }),
    });

    if (!aiRes.ok) throw new Error("Perplexity упал: " + (await aiRes.text()));
    const aiData = await aiRes.json();
    const readmeContent = aiData.choices[0].message.content.trim();

    const repoName = cardName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");

    await octokit.repos.createInOrg({
      org: ORG,
      name: repoName,
      private: true,
    });

    await octokit.repos.createOrUpdateFileContents({
      owner: ORG,
      repo: repoName,
      path: "README.md",
      message: "AI generated project",
      content: Buffer.from(readmeContent).toString("base64"),
    });

    const repoUrl = `${GITHUB_BASE}/${repoName}`;

    const comment = `Репозиторий создан автоматически\n${repoUrl}`;
    await fetch(
      `https://api.trello.com/1/cards/${cardId}/actions/comments?key=${
        process.env.TRELLO_KEY
      }&token=${process.env.TRELLO_TOKEN}&text=${encodeURIComponent(comment)}`,
      { method: "POST" }
    );

    res.status(200).json({ success: true, repo: repoUrl });
  } catch (err) {
    console.error("Ошибка:", err);
    res.status(500).json({ error: err.message });
  }
}

// ←←← Это тоже важно для Vercel
export const config = {
  api: {
    bodyParser: false,
  },
};
