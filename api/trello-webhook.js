import { Octokit } from "@octokit/rest";
import raw from "raw-body";
import { getAdapter } from "./ai-adapters/index.js";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const ORG = "ljudidela";
const GITHUB_BASE = `https://github.com/${ORG}`;

// ─────────────────────── НОВАЯ ЗАЩИТА ОТ ДУБЛЕЙ ───────────────────────
// Две карты: активная обработка + дедупликация по точному тексту описания
const activeProcessing = new Map(); // cardId → true
const processedContent = new Map(); // `${cardId}_${hash(desc)}` → timestamp
const DEBOUNCE_TTL = 30_000; // 30 секунд — больше чем надо

export default async function handler(req, res) {
  if (req.method === "HEAD" || req.method === "GET") {
    return res.status(200).send("Trello webhook alive");
  }
  if (req.method !== "POST") return res.status(405).end();

  let payload;
  try {
    const body = await raw(req);
    payload = JSON.parse(body.toString("utf-8"));
  } catch (e) {
    return res.status(400).end("Invalid JSON");
  }

  const actionType = payload.action?.type;
  if (!["createCard", "updateCard"].includes(actionType)) {
    return res.status(200).end();
  }

  if (actionType === "updateCard") {
    const changed = Object.keys(payload.action?.data?.old || {});
    if (!changed.includes("desc")) return res.status(200).end();
  }

  const cardId = payload.action.data.card.id;
  const cardName = payload.action.data.card.name?.trim();
  const cardDesc = (payload.action.data.card.desc || "").trim();

  if (!cardId || !cardName || !cardDesc) {
    return res.status(200).end();
  }

  // ─────────────────────── ЗАЩИТА ОТ ДУБЛЕЙ ───────────────────────
  // 1. Уже идёт обработка этой карточки
  if (activeProcessing.has(cardId)) {
    console.log(`ДУБЛЬ: карточка ${cardId} уже обрабатывается`);
    return res.status(200).json({ status: "already_processing" });
  }

  // 2. Этот же самый текст уже был обработан недавно
  const contentKey = `${cardId}_${cardDesc}`;
  if (processedContent.has(contentKey)) {
    const ago = Date.now() - processedContent.get(contentKey);
    if (ago < DEBOUNCE_TTL) {
      console.log(
        `ДЕДУП: тот же текст обработан ${Math.round(ago / 1000)}с назад`
      );
      return res.status(200).json({ status: "deduped_same_content" });
    }
  }

  // Ставим флаг начала обработки
  activeProcessing.set(cardId, true);
  console.log(`СТАРТ обработки карточки ${cardId} («${cardName}»)`);

  let repoInfo;
  let existingRepoContext = "";
  let finalRepoName;

  try {
    // === Получаем имя репо из доски ===
    let boardName =
      payload.action?.data?.board?.name || payload.model?.name || "ai-board";
    if (!boardName) {
      try {
        const boardRes = await fetch(
          `https://api.trello.com/1/cards/${cardId}/board?key=${process.env.TRELLO_KEY}&token=${process.env.TRELLO_TOKEN}`
        );
        if (boardRes.ok) boardName = (await boardRes.json()).name;
      } catch (_) {}
    }
    boardName = boardName.trim() || "ai-board";

    finalRepoName =
      boardName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-+|-+$)/g, "")
        .replace(/-+/g, "-") || "ai-project";

    // === Читаем репо или создаём новое ===
    try {
      repoInfo = await octokit.repos.get({ owner: ORG, repo: finalRepoName });
      const branch = repoInfo.data.default_branch || "main";

      const { data: tree } = await octokit.git.getTree({
        owner: ORG,
        repo: finalRepoName,
        tree_sha: branch,
        recursive: true,
      });

      const filesList = tree.tree
        .filter((f) => f.type === "blob")
        .map((f) => f.path)
        .slice(0, 100);

      const important = [
        "README.md",
        "package.json",
        "tsconfig.json",
        "vite.config.ts",
        "vite.config.js",
        "src/app/page.tsx",
        "src/app/layout.tsx",
      ];

      const existingFiles = {};
      for (const path of important) {
        if (!filesList.includes(path)) continue;
        try {
          const { data } = await octokit.repos.getContent({
            owner: ORG,
            repo: finalRepoName,
            path,
            ref: branch,
          });
          existingFiles[path] = Buffer.from(data.content, "base64").toString(
            "utf-8"
          );
        } catch (_) {}
      }

      existingRepoContext = `\n\n=== СУЩЕСТВУЮЩИЙ ПРОЕКТ ===\n\n`;
      for (const [p, c] of Object.entries(existingFiles)) {
        existingRepoContext += `--- ${p} ---\n${c}\n\n`;
      }
      existingRepoContext += `Структура (до 100 файлов):\n${filesList.join(
        "\n"
      )}\n`;
      existingRepoContext += `\nВАЖНО: используй "update" для существующих файлов, не создавай дубли.\n`;
    } catch (e) {
      if (e.status !== 404) throw e;
      existingRepoContext = `\n\n=== НОВЫЙ ПРОЕКТ ===\nСоздай всё с нуля по лучшим практикам.\n`;
    }

    if (!repoInfo) {
      await octokit.repos.createInOrg({
        org: ORG,
        name: finalRepoName,
        private: false,
        auto_init: true,
      });
      repoInfo = await octokit.repos.get({ owner: ORG, repo: finalRepoName });
    }

    const targetBranch = repoInfo.data.default_branch || "main";

    const prompt = `ТЫ — senior full-stack инженер. Отвечай ТОЛЬКО чистым JSON-массивом.

ЖЁСТКИЕ ПРАВИЛА:
1. index.html — всегда в корне
2. package.json — всегда есть и рабочий
3. README.md — с точной командой запуска
4. Никаких /public, дубликатов, заглушек
5. Проект запускается через "npm install && npm run dev" без ошибок

${existingRepoContext}

ЗАДАЧА:
${cardDesc}

Отвечай ТОЛЬКО JSON-массивом операций.`;

    const aiAdapter = getAdapter(process.env.AI_PROVIDER || "qwen");
    const fileOps = await aiAdapter.generateCode(prompt);

    if (!Array.isArray(fileOps) || fileOps.length === 0) {
      throw new Error("AI вернул пустой ответ");
    }

    const results = { success: [], failed: [] };

    for (const op of fileOps) {
      if (!op?.path || !op.action) continue;
      const action = op.action.toLowerCase();
      const path = op.path.replace(/^\/+/, "");

      if (!["create", "update", "delete"].includes(action)) continue;

      try {
        let sha;
        try {
          const { data } = await octokit.repos.getContent({
            owner: ORG,
            repo: finalRepoName,
            path,
            ref: targetBranch,
          });
          sha = data.sha;
        } catch (e) {
          if (e.status !== 404) console.error("SHA error:", e.message);
        }

        if (action === "delete") {
          if (!sha) continue;
          await octokit.repos.deleteFile({
            owner: ORG,
            repo: finalRepoName,
            path,
            message: `AI: delete ${path} — ${cardName}`,
            sha,
            branch: targetBranch,
          });
        } else {
          let content = op.content ?? "";
          if (typeof content === "string") {
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
            message: `AI: ${action} ${path} — ${cardName}`,
            content: Buffer.from(content).toString("base64"),
            branch: targetBranch,
            sha,
          });
        }
        results.success.push({ path, action });
      } catch (err) {
        results.failed.push({ path, error: err.message });
        console.error(`Ошибка ${action} ${path}:`, err.message);
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

    return res.status(200).json({
      success: true,
      repo: repoUrl,
      files: results.success.length,
    });
  } catch (err) {
    console.error("КРИТИЧЕСКАЯ ОШИБКА:", err);

    await fetch(
      `https://api.trello.com/1/cards/${cardId}/actions/comments?key=${
        process.env.TRELLO_KEY
      }&token=${process.env.TRELLO_TOKEN}&text=${encodeURIComponent(
        "Ошибка AI: " + err.message.slice(0, 400)
      )}`,
      { method: "POST" }
    ).catch(() => {});

    return res.status(500).json({ error: err.message });
  } finally {
    // ─────────────────────── СНЯТИЕ БЛОКИРОВОК ───────────────────────
    activeProcessing.delete(cardId);
    processedContent.set(`${cardId}_${cardDesc}`, Date.now());

    // Чистим старые записи (чтобы мапа не росла вечно)
    if (processedContent.size > 10_000) {
      const cutoff = Date.now() - 3_600_000; // старше часа
      for (const [key, ts] of processedContent.entries()) {
        if (ts < cutoff) processedContent.delete(key);
      }
    }
  }
}

export const config = {
  api: { bodyParser: false },
};
