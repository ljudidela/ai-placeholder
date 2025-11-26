import { Octokit } from "@octokit/rest";
import raw from "raw-body";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const ORG = "ljudidela";
const GITHUB_BASE = `https://github.com/${ORG}`;

export default async function handler(req, res) {
  if (req.method === "HEAD" || req.method === "GET") {
    return res.status(200).send("ok");
  }

  if (req.method !== "POST") {
    return res.status(405).end();
  }

  const body = await raw(req);
  const payload = JSON.parse(body.toString());

  const actionType = payload.action?.type;
  if (!["createCard", "updateCard"].includes(actionType)) {
    return res.status(200).end();
  }

  if (actionType === "updateCard") {
    const changed = Object.keys(payload.action?.data?.old || {});
    if (!changed.includes("desc")) {
      return res.status(200).end();
    }
  }

  const card = payload.action.data.card;
  const cardName = card.name?.trim();
  const cardDesc = (card.desc || "без описания").trim();
  const cardId = card.id;

  if (!cardName || !cardId) return res.status(400).end();

  // проверка — не создавали ли уже репо
  const commentsRes = await fetch(
    `https://api.trello.com/1/cards/${cardId}/actions?filter=commentCard&key=${process.env.TRELLO_KEY}&token=${process.env.TRELLO_TOKEN}`
  );
  const comments = await commentsRes.json();
  const alreadyDone = comments.some((c) =>
    c.data.text?.includes("Репозиторий создан автоматически")
  );

  if (alreadyDone) {
    return res.status(200).end();
  }

  try {
    const prompt = `Ты — senior full-stack разработчик. Создай полностью рабочий проект по описанию ниже.
Возвращай ТОЛЬКО содержимое README.md (никаких \`\`\`, объяснений, только текст).

Описание:
${cardDesc}`;

    console.log(
      "ПЕРПЛЕКСИТИ СТАРТУЕТ, ТОКЕН:",
      process.env.PERPLEXITY_KEY ? "ЕСТЬ" : "НЕТ"
    );
    console.log("ПРОМПТ ОТПРАВЛЯЕМ:", prompt.substring(0, 300) + "...");

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

    if (!aiRes.ok) throw new Error("Perplexity: " + (await aiRes.text()));
    const aiData = await aiRes.json();
    const readmeContent = aiData.choices[0].message.content.trim();

    let repoName = cardName
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-+/g, "-");

    if (!repoName) repoName = "ai-project";

    let finalRepoName = repoName;
    let counter = 1;
    while (true) {
      try {
        await octokit.repos.get({ owner: ORG, repo: finalRepoName });
        finalRepoName = `${repoName}-${counter++}`;
      } catch (e) {
        if (e.status === 404) break;
        throw e;
      }
    }

    await octokit.repos.createInOrg({
      org: ORG,
      name: finalRepoName,
      private: true,
      auto_init: true,
    });

    await octokit.repos.createOrUpdateFileContents({
      owner: ORG,
      repo: finalRepoName,
      path: "README.md",
      path: "README.md",
      message: "AI generated project",
      content: Buffer.from(readmeContent).toString("base64"),
    });

    const repoUrl = `${GITHUB_BASE}/${finalRepoName}`;
    const comment = `Репозиторий создан автоматически\n${repoUrl}`;

    await fetch(
      `https://api.trello.com/1/cards/${cardId}/actions/comments?key=${
        process.env.TRELLO_KEY
      }&token=${process.env.TRELLO_TOKEN}&text=${encodeURIComponent(comment)}`,
      { method: "POST" }
    );

    res.status(200).json({ success: true, repo: repoUrl });
  } catch (err) {
    console.error("Ошибка:", err.message);
    const errComment = `Ошибка: ${err.message.slice(0, 500)}`;
    await fetch(
      `https://api.trello.com/1/cards/${cardId}/actions/comments?key=${
        process.env.TRELLO_KEY
      }&token=${process.env.TRELLO_TOKEN}&text=${encodeURIComponent(
        errComment
      )}`,
      { method: "POST" }
    ).catch(() => {});
    res.status(500).json({ error: err.message });
  }
}

export const config = {
  api: {
    bodyParser: false,
  },
};
