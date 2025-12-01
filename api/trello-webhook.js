// api/handler.js
import { Octokit } from "@octokit/rest";
import raw from "raw-body";
import { getAdapter } from "./ai-adapters/index.js";

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFile } from "fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const promptCache = new Map();

async function loadPrompt(fileName) {
  if (promptCache.has(fileName)) return promptCache.get(fileName);

  const filePath = join(__dirname, "ai-prompts", fileName);
  try {
    const content = await readFile(filePath, "utf-8");
    const trimmed = content.trim();
    promptCache.set(fileName, trimmed);
    return trimmed;
  } catch (err) {
    console.error(`Не найден промпт: ${filePath}`);
    throw new Error(`Отсутствует файл промпта: ai-prompts/${fileName}`);
  }
}

// ─────────────────────── Сборка промпта ───────────────────────
async function buildPrompt(cardDesc, existingRepoContext, projectType) {
  const base = await loadPrompt("base-system-prompt.txt");

  let specific;
  try {
    specific = await loadPrompt(`${projectType}.txt`);
  } catch {
    console.log(`Шаблон ${projectType}.txt не найден → fallback на web-vite`);
    specific = await loadPrompt("web-vite.txt");
  }

  return `${base}

${specific}

${existingRepoContext}

ЗАДАЧА:
${cardDesc}

Отвечай ТОЛЬКО чистым JSON-массивом операций. Никакого лишнего текста.`;
}

// ─────────────────────── Определение типа проекта ───────────────────────
function getProjectType(payload, boardName) {
  if (process.env.PROJECT_TYPE) {
    return process.env.PROJECT_TYPE.trim().toLowerCase();
  }

  const labels = (payload.action?.data?.card?.labels || [])
    .map((l) => l.name?.toLowerCase().trim())
    .filter(Boolean);

  const labelMatch = labels.find(
    (l) => l.startsWith("project:") || l.startsWith("type:")
  );
  if (labelMatch) return labelMatch.split(":").pop().trim();

  const lower = boardName.toLowerCase();
  if (
    lower.includes("game") ||
    lower.includes("heaps") ||
    lower.includes("haxe")
  ) {
    return "haxe-heaps";
  }

  return "web-vite";
}

// ─────────────────────── Основные константы ───────────────────────
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const ORG = "ljudidela";
const GITHUB_BASE = `https://github.com/${ORG}`;

const activeProcessing = new Map();
const processedContent = new Map();
const DEBOUNCE_TTL = 30_000;

// ─────────────────────── Хэндлер ───────────────────────
export default async function handler(req, res) {
  if (req.method === "HEAD" || req.method === "GET") {
    return res.status(200).send("Trello webhook alive");
  }
  if (req.method !== "POST") return res.status(405).end();

  let payload;
  try {
    payload = JSON.parse((await raw(req)).toString("utf-8"));
  } catch {
    return res.status(400).end("Invalid JSON");
  }

  const actionType = payload.action?.type;
  if (!["createCard", "updateCard"].includes(actionType))
    return res.status(200).end();

  if (actionType === "updateCard") {
    const changed = Object.keys(payload.action?.data?.old || {});
    if (!changed.includes("desc")) return res.status(200).end();
  }

  const cardId = payload.action.data.card.id;
  const cardName = payload.action.data.card.name?.trim();
  const cardDesc = (payload.action.data.card.desc || "").trim();

  if (!cardId || !cardName || !cardDesc) return res.status(200).end();

  // Дедупликация
  if (activeProcessing.has(cardId)) {
    console.log(`Дубль: карточка ${cardId} уже в обработке`);
    return res.status(200).json({ status: "already_processing" });
  }
  const contentKey = `${cardId}_${cardDesc}`;
  if (
    processedContent.has(contentKey) &&
    Date.now() - processedContent.get(contentKey) < DEBOUNCE_TTL
  ) {
    return res.status(200).json({ status: "deduped" });
  }

  activeProcessing.set(cardId, true);
  console.log(`СТАРТ обработки: "${cardName}" (${cardId})`);

  let finalRepoName, repoInfo;

  try {
    // ─── Получаем имя доски ───
    let boardName =
      payload.action?.data?.board?.name || payload.model?.name || "ai-board";
    if (!boardName) {
      const r = await fetch(
        `https://api.trello.com/1/cards/${cardId}/board?key=${process.env.TRELLO_KEY}&token=${process.env.TRELLO_TOKEN}`
      );
      if (r.ok) boardName = (await r.json()).name;
    }
    boardName = boardName.trim() || "ai-board";

    const projectType = getProjectType(payload, boardName);
    console.log(`Тип проекта → ${projectType}`);

    // ─── Формируем имя репозитория ───
    const sanitized = boardName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-+|-+$)/g, "")
      .replace(/-+/g, "-");

    const prefix = projectType.includes("haxe")
      ? "haxe-"
      : projectType.includes("godot")
      ? "godot-"
      : projectType.includes("backend")
      ? "api-"
      : "";

    finalRepoName = prefix + (sanitized || "project");

    // ─── Контекст существующего репо ───
    let existingRepoContext = "";
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
        .slice(0, 100)
        .join("\n");

      existingRepoContext = `\n\n=== СУЩЕСТВУЮЩИЙ ПРОЕКТ ===\nСтруктура:\n${filesList}\n\nВАЖНО: используй "update" для существующих файлов!\n`;
    } catch (e) {
      if (e.status !== 404) throw e;
      existingRepoContext = `\n\n=== НОВЫЙ ПРОЕКТ (${projectType.toUpperCase()}) ===\nСоздай всё с нуля по лучшим практикам.\n`;
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
    const prompt = await buildPrompt(
      cardDesc,
      existingRepoContext,
      projectType
    );

    const aiAdapter = getAdapter(process.env.AI_PROVIDER || "neuro");
    const fileOps = await aiAdapter.generateCode(prompt);

    if (!Array.isArray(fileOps) || fileOps.length === 0) {
      throw new Error("AI вернул пустой массив операций");
    }

    const results = { success: [], failed: [] };

    for (const op of fileOps) {
      if (!op?.path || !["create", "update", "delete"].includes(op.action))
        continue;

      const path = op.path.replace(/^\/+/, "");
      let content = op.content ?? "";

      if (typeof content === "string") {
        content = content
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      }

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
        } catch (_) {}

        if (op.action === "delete") {
          if (sha) {
            await octokit.repos.deleteFile({
              owner: ORG,
              repo: finalRepoName,
              path,
              message: `AI: delete ${path} — ${cardName}`,
              sha,
              branch: targetBranch,
            });
          }
        } else {
          await octokit.repos.createOrUpdateFileContents({
            owner: ORG,
            repo: finalRepoName,
            path,
            message: `AI: ${op.action} ${path} — ${cardName}`,
            content: Buffer.from(content).toString("base64"),
            branch: targetBranch,
            sha,
          });
        }
        results.success.push({ path, action: op.action });
      } catch (err) {
        results.failed.push({ path, error: err.message });
        console.error(`Ошибка ${op.action} ${path}:`, err.message);
      }
    }

    const repoUrl = `${GITHUB_BASE}/${finalRepoName}`;
    const comment = `Репозиторий обновлён (${projectType})\n${repoUrl}\n\nУспешно: ${results.success.length} файлов\nОшибок: ${results.failed.length}`;

    await fetch(
      `https://api.trello.com/1/cards/${cardId}/actions/comments?key=${
        process.env.TRELLO_KEY
      }&token=${process.env.TRELLO_TOKEN}&text=${encodeURIComponent(comment)}`,
      { method: "POST" }
    ).catch(() => {});

    return res.status(200).json({
      success: true,
      repo: repoUrl,
      type: projectType,
      files: results.success.length,
    });
  } catch (err) {
    console.error("КРИТИЧЕСКАЯ ОШИБКА:", err);
    await fetch(
      `https://api.trello.com/1/cards/${cardId}/actions/comments?key=${
        process.env.TRELLO_KEY
      }&token=${process.env.TRELLO_TOKEN}&text=${encodeURIComponent(
        "AI Ошибка: " + err.message.slice(0, 400)
      )}`,
      { method: "POST" }
    ).catch(() => {});

    return res.status(500).json({ error: err.message });
  } finally {
    activeProcessing.delete(cardId);
    processedContent.set(contentKey, Date.now());

    if (processedContent.size > 10_000) {
      const cutoff = Date.now() - 3_600_000;
      for (const [k, t] of processedContent.entries()) {
        if (t < cutoff) processedContent.delete(k);
      }
    }
  }
}

export const config = {
  api: { bodyParser: false },
};
