// api/handler.js
import { Octokit } from "@octokit/rest";
import raw from "raw-body";
import { getAdapter } from "./ai-adapters/index.js";

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFile } from "fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ORG = "ljudidela";
const GITHUB_BASE = `https://github.com/${ORG}`;
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const promptCache = new Map();

// ────────────── HELPERS ──────────────
async function loadPrompt(fileName) {
  if (promptCache.has(fileName)) return promptCache.get(fileName);
  const content = await readFile(
    join(__dirname, "ai-prompts", fileName),
    "utf-8"
  );
  const trimmed = content.trim();
  promptCache.set(fileName, trimmed);
  return trimmed;
}

async function buildPrompt(cardDesc, repoContext, projectType) {
  const base = await loadPrompt("base-system-prompt.txt");
  let specific;
  try {
    specific = await loadPrompt(`${projectType}.txt`);
  } catch {
    console.log(`Шаблон ${projectType}.txt не найден → fallback на web-vite`);
    specific = await loadPrompt("web-vite.txt");
  }
  return `${base}\n\n${specific}\n\n${repoContext}\n\nЗАДАЧА:\n${cardDesc}\n\nОтвечай ТОЛЬКО чистым JSON-массивом операций.`;
}

function getProjectType(payload, boardName) {
  if (process.env.PROJECT_TYPE)
    return process.env.PROJECT_TYPE.trim().toLowerCase();

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
  )
    return "haxe-heaps";
  return "web-vite";
}

async function safeOctokit(fn, retries = 3, delay = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      console.warn(`Octokit retry #${i + 1}:`, err.message);
      await new Promise((r) => setTimeout(r, delay * (i + 1)));
    }
  }
}

// ────────────── HANDLER ──────────────
export default async function handler(req, res) {
  if (req.method === "HEAD" || req.method === "GET")
    return res.status(200).send("Trello webhook alive");
  if (req.method !== "POST") return res.status(405).end();

  let payload;
  try {
    payload = JSON.parse((await raw(req)).toString("utf-8"));
  } catch {
    return res.status(400).end("Invalid JSON");
  }

  res.status(200).json({ ok: true });
  processCard(payload).catch((err) => console.error("PROCESS ERROR:", err));
}

// ────────────── PROCESS CARD ──────────────
async function processCard(payload) {
  const action = payload.action;
  if (!action) return;

  if (!["createCard", "updateCard"].includes(action.type)) return;
  if (
    action.type === "updateCard" &&
    !Object.keys(action.data?.old || {}).includes("desc")
  )
    return;

  const card = action.data.card;
  const cardId = card.id;
  const cardName = card.name?.trim();
  const cardDesc = card.desc?.trim();
  if (!cardId || !cardName || !cardDesc) return;

  // ─── Проверка метки AI:processing ───
  const labels = (card.labels || []).map((l) => l.name);
  if (labels.includes("AI: processing")) {
    console.log(`Дубль: карточка ${cardId} уже в обработке (метка)`);
    return;
  }

  // ─── Ставим метку processing ───
  await fetch(
    `https://api.trello.com/1/cards/${cardId}/labels?key=${process.env.TRELLO_KEY}&token=${process.env.TRELLO_TOKEN}&value=AI: processing`,
    { method: "POST" }
  ).catch(() => {});

  console.log(`СТАРТ обработки: "${cardName}" (${cardId})`);

  let boardName = action.data?.board?.name || payload.model?.name || "ai-board";
  if (!boardName) {
    const r = await fetch(
      `https://api.trello.com/1/cards/${cardId}/board?key=${process.env.TRELLO_KEY}&token=${process.env.TRELLO_TOKEN}`
    );
    if (r.ok) boardName = (await r.json()).name;
  }
  boardName = boardName?.trim() || "ai-board";

  const projectType = getProjectType(payload, boardName);
  console.log(`Тип проекта → ${projectType}`);

  const sanitized = boardName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
  const prefix = projectType.includes("haxe")
    ? "haxe-"
    : projectType.includes("godot")
    ? "godot-"
    : projectType.includes("backend")
    ? "api-"
    : "";
  const repoName = prefix + (sanitized || "project");

  // ─── Контекст репозитория ───
  let repoInfo,
    repoContext = "";
  try {
    repoInfo = await safeOctokit(() =>
      octokit.repos.get({ owner: ORG, repo: repoName })
    );
    const branch = repoInfo.data.default_branch || "main";
    const { data: tree } = await safeOctokit(() =>
      octokit.git.getTree({
        owner: ORG,
        repo: repoName,
        tree_sha: branch,
        recursive: true,
      })
    );
    const filesList = tree.tree
      .filter((f) => f.type === "blob")
      .map((f) => f.path)
      .slice(0, 100)
      .join("\n");
    repoContext = `=== СУЩЕСТВУЮЩИЙ ПРОЕКТ ===\nСтруктура:\n${filesList}\n\nВАЖНО: используй "update" для существующих файлов!\n`;
    console.log(`Контекст репозитория получен: ${repoName}`);
  } catch (e) {
    if (e.status !== 404) throw e;
    console.log(`Репозиторий не найден, создаём новый: ${repoName}`);
    repoInfo = await safeOctokit(() =>
      octokit.repos.createInOrg({
        org: ORG,
        name: repoName,
        private: false,
        auto_init: true,
      })
    );
    repoContext = `=== НОВЫЙ ПРОЕКТ (${projectType.toUpperCase()}) ===\nСоздай всё с нуля по лучшим практикам.\n`;
  }

  const targetBranch = repoInfo.data.default_branch || "main";

  // ─── Промпт и AI ───
  const prompt = await buildPrompt(cardDesc, repoContext, projectType);
  console.log("Отправка запроса в AI/Gemini...");
  const aiAdapter = getAdapter(process.env.AI_PROVIDER || "neuro");
  const fileOps = await aiAdapter.generateCode(prompt);
  if (!Array.isArray(fileOps) || fileOps.length === 0)
    throw new Error("AI вернул пустой массив операций");
  console.log(`AI вернул ${fileOps.length} операций`);

  // ─── Применяем операции ───
  const results = { success: [], failed: [] };
  for (const op of fileOps) {
    if (!op?.path || !["create", "update", "delete"].includes(op.action))
      continue;
    const path = op.path.replace(/^\/+/, "");
    let content = op.content ?? "";
    if (typeof content === "string")
      content = content
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");

    try {
      let sha;
      try {
        const { data } = await safeOctokit(() =>
          octokit.repos.getContent({
            owner: ORG,
            repo: repoName,
            path,
            ref: targetBranch,
          })
        );
        sha = data.sha;
      } catch {}

      if (op.action === "delete") {
        if (sha)
          await safeOctokit(() =>
            octokit.repos.deleteFile({
              owner: ORG,
              repo: repoName,
              path,
              message: `AI: delete ${path} — ${cardName}`,
              sha,
              branch: targetBranch,
            })
          );
      } else {
        await safeOctokit(() =>
          octokit.repos.createOrUpdateFileContents({
            owner: ORG,
            repo: repoName,
            path,
            message: `AI: ${op.action} ${path} — ${cardName}`,
            content: Buffer.from(content).toString("base64"),
            sha,
            branch: targetBranch,
          })
        );
      }
      results.success.push({ path, action: op.action });
      console.log(`✅ ${op.action.toUpperCase()} ${path}`);
    } catch (err) {
      results.failed.push({ path, error: err.message });
      console.error(`❌ Ошибка ${op.action} ${path}:`, err.message);
    }
  }

  const repoUrl = `${GITHUB_BASE}/${repoName}`;
  const commentText = `Репозиторий обновлён (${projectType})\n${repoUrl}\n\nУспешно: ${results.success.length} файлов\nОшибок: ${results.failed.length}`;

  await fetch(
    `https://api.trello.com/1/cards/${cardId}/actions/comments?key=${
      process.env.TRELLO_KEY
    }&token=${process.env.TRELLO_TOKEN}&text=${encodeURIComponent(
      commentText
    )}`,
    { method: "POST" }
  ).catch(() => {});

  // ─── Снимаем метку processing, ставим done ───
  await fetch(
    `https://api.trello.com/1/cards/${cardId}/labels?key=${process.env.TRELLO_KEY}&token=${process.env.TRELLO_TOKEN}&value=AI: done`,
    { method: "POST" }
  ).catch(() => {});

  console.log(`✅ Обработка карточки ${cardId} завершена`);
}

export const config = { api: { bodyParser: false } };
