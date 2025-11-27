import { Octokit } from "@octokit/rest";
import raw from "raw-body";
import { getAdapter } from "./ai-adapters/index.js";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const ORG = "ljudidela";
const GITHUB_BASE = `https://github.com/${ORG}`;

// Глобальная Map для дедупликации (переживает вызовы функций)
const processedCards = new Map();

export default async function handler(req, res) {
  // Убрать отсюда: const processedCards = new Map();

  // Очистка старых записей
  for (const [key, timestamp] of processedCards.entries()) {
    if (Date.now() - timestamp > 5 * 60 * 1000) {
      // 5 минут
      processedCards.delete(key);
    }
  }

  if (req.method === "HEAD" || req.method === "GET") {
    return res.status(200).send("ok");
  }
  if (req.method !== "POST") return res.status(405).end();

  const body = await raw(req);
  const payload = JSON.parse(body.toString());

  const actionType = payload.action?.type;
  if (!["createCard", "updateCard"].includes(actionType)) {
    return res.status(200).end();
  }
  if (actionType === "updateCard") {
    const changed = Object.keys(payload.action?.data?.old || {});
    if (!changed.includes("desc")) return res.status(200).end();
  }

  const card = payload.action.data.card;
  const cardName = card.name?.trim();
  const cardDescRaw = (card.desc || "").trim();
  const cardId = card.id;

  const cardKey = `${cardId}_${payload.action?.date || Date.now()}`;
  console.log(`Обработка карточки ${cardId}, ключ: ${cardKey}`);
  console.log(
    `Текущие обработанные карточки:`,
    Array.from(processedCards.keys())
  );

  if (processedCards.has(cardKey)) {
    console.log(`❌ Карточка ${cardId} уже обрабатывается, пропускаем`);
    return res.status(200).end();
  }
  console.log(`✅ Начинаем обработку карточки ${cardId}`);
  processedCards.set(cardKey, Date.now());

  if (!cardName || !cardId || !cardDescRaw) return res.status(200).end();

  const cardDesc = cardDescRaw;

  let boardName =
    payload.action?.data?.board?.name || payload.model?.name || "ai-board";
  try {
    if (!boardName) {
      const boardRes = await fetch(
        `https://api.trello.com/1/cards/${cardId}/board?key=${process.env.TRELLO_KEY}&token=${process.env.TRELLO_TOKEN}`
      );
      if (boardRes.ok) boardName = (await boardRes.json()).name;
    }
  } catch (e) {
    console.error("Ошибка получения доски:", e.message);
  }
  boardName = boardName.trim() || "ai-board";

  const repoName =
    boardName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-+/g, "-") || "ai-project";
  const finalRepoName = repoName;

  let repoInfo;
  let existingRepoContext = "";

  try {
    repoInfo = await octokit.repos.get({ owner: ORG, repo: finalRepoName });
    const targetBranch = repoInfo.data.default_branch || "main";

    // === ЧИТАЕМ ВСЁ ПОДРЯД, НЕ ТОЛЬКО КОРЕНЬ ===
    const { data: tree } = await octokit.git.getTree({
      owner: ORG,
      repo: finalRepoName,
      tree_sha: targetBranch,
      recursive: true,
    });

    const filesList = tree.tree
      .filter((item) => item.type === "blob")
      .map((item) => item.path)
      .slice(0, 100); // ограничиваем, чтобы не перегрузить промпт

    // Читаем содержимое важных файлов (включая из src/)
    const importantPaths = [
      "README.md",
      "package.json",
      "tsconfig.json",
      "vite.config.ts",
      "vite.config.js",
      "src/app/page.tsx",
      "src/app/layout.tsx",
      "src/components/ui/button.tsx",
    ];

    const existingFiles = {};
    for (const path of importantPaths) {
      if (!filesList.includes(path)) continue;
      try {
        const { data } = await octokit.repos.getContent({
          owner: ORG,
          repo: finalRepoName,
          path,
          ref: targetBranch,
        });
        if (data.content) {
          const decoded = Buffer.from(data.content, "base64").toString("utf-8");
          existingFiles[path] = decoded;
        }
      } catch (_) {
        /* не найден — ок */
      }
    }

    existingRepoContext = `\n\n=== СУЩЕСТВУЮЩИЙ ПРОЕКТ ===\n\n`;
    for (const [path, content] of Object.entries(existingFiles)) {
      existingRepoContext += `--- ${path} ---\n${content}\n\n`;
    }

    existingRepoContext += `Полная структура проекта (до 100 файлов):\n${filesList.join(
      "\n"
    )}\n\n`;
    existingRepoContext += `ВАЖНО:
- Это НЕ новый проект, всегда используй action: "update" для существующих файлов.
- Не создавай дубликаты в корне.
- Не переписывай весь проект заново, если не просят.\n`;
  } catch (e) {
    if (e.status === 404) {
      existingRepoContext =
        "\n\n=== НОВЫЙ ПРОЕКТ (репозиторий будет создан) ===\n";
    } else {
      console.error("Ошибка чтения репо:", e.status, e.message);
      throw e;
    }
  }

  // Создаём репо если нет
  if (!repoInfo) {
    await octokit.repos.createInOrg({
      org: ORG,
      name: finalRepoName,
      private: true,
      auto_init: true,
    });
    repoInfo = await octokit.repos.get({ owner: ORG, repo: finalRepoName });
  }

  const targetBranch = repoInfo.data.default_branch || "main";

  try {
    const prompt = `Ты — senior full-stack разработчик с доступом ко всему проекту.

${existingRepoContext}

ЗАДАЧА ОТ ПОЛЬЗОВАТЕЛЯ:
${cardDesc}

ОТВЕЧАЙ ТОЛЬКО чистым JSON-массивом вида:
[
  {"path": "src/components/Chart.tsx", "action": "create", "content": "..."},
  {"path": "src/app/page.tsx", "action": "update", "content": "..."}
]
Без markdown, без пояснений, только массив от [ до ].`;

    const AI_PROVIDER = process.env.AI_PROVIDER || "yandex";
    const aiAdapter = getAdapter(AI_PROVIDER);

    const fileOps = await aiAdapter.generateCode(prompt);

    if (!Array.isArray(fileOps) || fileOps.length === 0) {
      throw new Error("AI вернул пустой или некорректный ответ");
    }

    const results = { success: [], failed: [] };

    for (const op of fileOps) {
      if (!op?.path || !op?.action) continue;

      const action = op.action.toLowerCase();
      const path = op.path.replace(/^\/+/, "");

      if (!["create", "update", "delete"].includes(action)) continue;

      try {
        let existingSha;
        try {
          const { data } = await octokit.repos.getContent({
            owner: ORG,
            repo: finalRepoName,
            path,
            ref: targetBranch,
          });
          existingSha = data.sha;
        } catch (e) {
          if (e.status !== 404)
            console.error("Ошибка получения SHA:", e.message);
        }

        if (action === "delete") {
          if (!existingSha) continue;
          await octokit.repos.deleteFile({
            owner: ORG,
            repo: finalRepoName,
            path,
            message: `AI delete ${path} — ${cardName}`,
            sha: existingSha,
            branch: targetBranch,
          });
          results.success.push({ path, action });
          continue;
        }

        let content = typeof op.content === "string" ? op.content : "";
        if (/\\[ntr"\\]/.test(content) && !content.includes("\n")) {
          content = content
            .replace(/\\n/g, "\n")
            .replace(/\\t/g, "\t")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\");
        }

        await octokit.repos.createOrUpdateFileContents({
          owner: ORG,
          repo: finalRepoName,
          path,
          message: `AI ${action} ${path} — ${cardName}`,
          content: Buffer.from(content).toString("base64"),
          branch: targetBranch,
          sha: existingSha,
        });

        results.success.push({ path, action });
      } catch (err) {
        results.failed.push({ path, error: err.message });
      }
    }

    const repoUrl = `${GITHUB_BASE}/${finalRepoName}`;
    const comment = `Репозиторий обновлён\n${repoUrl}\n\nУспешно: ${results.success.length}\nОшибок: ${results.failed.length}`;

    await fetch(
      `https://api.trello.com/1/cards/${cardId}/actions/comments?key=${
        process.env.TRELLO_KEY
      }&token=${process.env.TRELLO_TOKEN}&text=${encodeURIComponent(comment)}`,
      { method: "POST" }
    ).catch(() => {});

    res.status(200).json({
      success: true,
      repo: repoUrl,
      filesProcessed: results.success.length,
      filesFailed: results.failed.length,
    });
  } catch (err) {
    console.error("Критическая ошибка:", err);
    await fetch(
      `https://api.trello.com/1/cards/${cardId}/actions/comments?key=${
        process.env.TRELLO_KEY
      }&token=${process.env.TRELLO_TOKEN}&text=${encodeURIComponent(
        "Ошибка: " + err.message.slice(0, 500)
      )}`,
      { method: "POST" }
    ).catch(() => {});
    res.status(500).json({ error: err.message });
  }
}

export const config = { api: { bodyParser: false } };
