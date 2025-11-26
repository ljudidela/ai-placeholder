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
  const cardDescRaw = (card.desc || "").trim();
  const cardId = card.id;

  if (!cardName || !cardId) return res.status(400).end();

  // если описания нет — ничего не делаем
  if (!cardDescRaw) {
    return res.status(200).end();
  }

  const cardDesc = cardDescRaw;

  // определяем доску, к которой относится карточка (одна доска — один репозиторий)
  let boardName =
    payload.action?.data?.board?.name ||
    payload.model?.board?.name ||
    payload.model?.name;

  try {
    if (!boardName) {
      const boardRes = await fetch(
        `https://api.trello.com/1/cards/${cardId}/board?key=${process.env.TRELLO_KEY}&token=${process.env.TRELLO_TOKEN}`
      );
      if (boardRes.ok) {
        const boardData = await boardRes.json();
        boardName = boardData.name;
      } else {
        console.error(
          "Не удалось получить доску Trello, статус:",
          boardRes.status
        );
      }
    }
  } catch (e) {
    console.error("Ошибка при получении доски Trello:", e.message || e);
  }

  boardName = boardName?.trim() || "ai-board";

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

    console.log("ПЕРПЛЕКСИТИ ОТВЕТИЛ:");
    console.log(
      readmeContent.substring(0, 1000) +
        (readmeContent.length > 1000 ? "\n... (обрезано)" : "")
    );

    // репозиторий привязан к ДОСКЕ, а не к конкретной карточке
    console.log("BOARD NAME ДЛЯ РЕПО:", boardName);
    let repoName = boardName
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-+/g, "-");

    if (!repoName) repoName = "ai-project";

    const finalRepoName = repoName;

    console.log("ЦЕЛЕВОЙ РЕПО ДЛЯ ДОСКИ:", finalRepoName);

    // одна доска — один репозиторий:
    // если репо уже есть, используем его; если нет — создаём
    try {
      console.log("Пробуем получить репозиторий:", finalRepoName);
      await octokit.repos.get({ owner: ORG, repo: finalRepoName });
      console.log("Репозиторий для доски уже существует:", finalRepoName);
    } catch (e) {
      if (e.status === 404) {
        console.log(
          "Репозиторий не найден (404), пробуем создать:",
          finalRepoName
        );
        try {
          await octokit.repos.createInOrg({
            org: ORG,
            name: finalRepoName,
            private: true,
            auto_init: true,
          });
          console.log("Создан новый репозиторий для доски:", finalRepoName);
        } catch (createErr) {
          const msg = createErr?.message || String(createErr);
          const status = createErr?.status;
          console.error(
            "Ошибка при создании репозитория:",
            status,
            msg,
            createErr?.response?.data || ""
          );

          // если репозиторий уже существует по имени, но мы не можем его получить/создать —
          // это почти наверняка проблема прав токена или «чужого» репозитория
          if (
            status === 422 &&
            typeof msg === "string" &&
            msg.includes("name already exists")
          ) {
            throw new Error(
              `GitHub: репозиторий "${finalRepoName}" уже существует в организации ${ORG}, ` +
                `но текущий GITHUB_TOKEN не имеет к нему доступа. ` +
                `Либо дайте токену доступ к этому репозиторию, либо переименуйте доску/репо.`
            );
          }

          throw createErr;
        }
      } else {
        console.error(
          "Ошибка при получении репозитория:",
          e.status,
          e.message,
          e?.response?.data || ""
        );
        throw e;
      }
    }

    // безопасно обновляем README: если он уже есть — передаём sha, если нет — создаём
    console.log("Готовимся обновлять README.md в репо:", finalRepoName);
    let existingReadmeSha;
    try {
      const { data: existing } = await octokit.repos.getContent({
        owner: ORG,
        repo: finalRepoName,
        path: "README.md",
      });
      if (!Array.isArray(existing)) {
        existingReadmeSha = existing.sha;
        console.log(
          "README.md уже существует, будет обновлён, sha:",
          existingReadmeSha
        );
      }
    } catch (e) {
      if (e.status === 404) {
        console.log("README.md ещё нет, будет создан");
      } else {
        console.error("Ошибка при получении README.md:", e.status, e.message);
        throw e;
      }
    }

    console.log(
      "Отправляем README.md в GitHub, длина контента:",
      readmeContent.length,
      "символов, sha:",
      existingReadmeSha || "нет (создание файла)"
    );

    await octokit.repos.createOrUpdateFileContents({
      owner: ORG,
      repo: finalRepoName,
      path: "README.md",
      message: "AI generated project",
      content: Buffer.from(readmeContent).toString("base64"),
      ...(existingReadmeSha ? { sha: existingReadmeSha } : {}),
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
