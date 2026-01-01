// api/handler.js
import { Octokit } from "@octokit/rest";
import raw from "raw-body";
import { getAdapter } from "./ai-adapters/index.js";

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFile } from "fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─────────────────────── PROMPTS ───────────────────────
const promptCache = new Map();

async function loadPrompt(fileName) {
  if (promptCache.has(fileName)) return promptCache.get(fileName);

  const filePath = join(__dirname, "ai-prompts", fileName);
  const content = await readFile(filePath, "utf-8");
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
    specific = await loadPrompt("web-vite.txt");
  }

  return `${base}

${specific}

${repoContext}

ЗАДАЧА:
${cardDesc}

Отвечай ТОЛЬКО чистым JSON-массивом операций.`;
}

// ─────────────────────── PROJECT TYPE ───────────────────────
function getProjectType(payload, boardName) {
  if (process.env.PROJECT_TYPE) {
    return process.env.PROJECT_TYPE.trim().toLowerCase();
  }

  const labels =
    payload.action?.data?.card?.labels
      ?.map((l) => l.name?.toLowerCase().trim())
      .filter(Boolean) || [];

  const match = labels.find(
    (l) => l.startsWith("project:") || l.startsWith("type:")
  );
  if (match) return match.split(":").pop();

  const lower = boardName.toLowerCase();
  if (lower.includes("game") || lower.includes("haxe")) return "haxe-heaps";

  return "web-vite";
}

// ─────────────────────── CONSTANTS ───────────────────────
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const ORG = "ljudidela";
const GITHUB_BASE = `https://github.com/${ORG}`;

// ЕДИНСТВЕННЫЙ дедуп который реально работает
const processedActions = new Set();

// ─────────────────────── HANDLER ───────────────────────
export default async function handler(req, res) {
  if (req.method === "HEAD" || req.method === "GET") {
    return res.status(200).send("Trello webhook alive");
  }

  if (req.method !== "POST") {
    return res.status(200).end();
  }

  let payload;
  try {
    payload = JSON.parse((await raw(req)).toString("utf-8"));
  } catch {
    return res.status(400).end("Invalid JSON");
  }

  // ОТВЕЧАЕМ СРАЗУ → Trello НЕ РЕТРАИТ
  res.status(200).json({ ok: true });

  // ДАЛЬШЕ — В ФОНЕ
  processCard(payload).catch((err) => console.error("PROCESS ERROR:", err));
}

// ─────────────────────── CORE LOGIC ───────────────────────
async function processCard(payload) {
  const action = payload.action;
  if (!action) return;

  // дедуп 100%
  if (processedActions.has(action.id)) return;
  processedActions.add(action.id);

  if (!["createCard", "updateCard"].includes(action.type)) return;

  if (action.type === "updateCard") {
    const changed = Object.keys(action.data?.old || {});
    if (!changed.includes("desc")) return;
  }

  const card = action.data.card;
  const cardId = card.id;
  const cardName = card.name?.trim();
  const cardDesc = card.desc?.trim();

  if (!cardId || !cardName || !cardDesc) return;

  // ─── board name ───
  let boardName = action.data?.board?.name || payload.model?.name || "ai-board";

  if (!boardName) {
    const r = await fetch(
      `https://api.trello.com/1/cards/${cardId}/board?key=${process.env.TRELLO_KEY}&token=${process.env.TRELLO_TOKEN}`
    );
    if (r.ok) boardName = (await r.json()).name;
  }

  boardName = boardName.trim() || "ai-board";
  const projectType = getProjectType(payload, boardName);

  // ─── repo name ───
  const sanitized = boardName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");

  const prefix = projectType.includes("haxe")
    ? "haxe-"
    : projectType.includes("backend")
    ? "api-"
    : "";

  const repoName = prefix + (sanitized || "project");

  // ─── repo context ───
  let repoInfo;
  let repoContext = "";

  try {
    repoInfo = await octokit.repos.get({ owner: ORG, repo: repoName });
    const branch = repoInfo.data.default_branch || "main";

    const { data: tree } = await octokit.git.getTree({
      owner: ORG,
      repo: repoName,
      tree_sha: branch,
      recursive: true,
    });

    const files = tree.tree
      .filter((f) => f.type === "blob")
      .map((f) => f.path)
      .slice(0, 100)
      .join("\n");

    repoContext = `СУЩЕСТВУЮЩИЙ ПРОЕКТ\n${files}\n\nИспользуй update для существующих файлов.`;
  } catch (e) {
    if (e.status !== 404) throw e;
    repoContext = `НОВЫЙ ПРОЕКТ (${projectType})`;
  }

  if (!repoInfo) {
    await octokit.repos.createInOrg({
      org: ORG,
      name: repoName,
      private: false,
      auto_init: true,
    });
    repoInfo = await octokit.repos.get({ owner: ORG, repo: repoName });
  }

  const branch = repoInfo.data.default_branch || "main";

  // ─── AI ───
  const prompt = await buildPrompt(cardDesc, repoContext, projectType);
  const ai = getAdapter(process.env.AI_PROVIDER || "neuro");
  const ops = await ai.generateCode(prompt);

  if (!Array.isArray(ops) || ops.length === 0) {
    throw new Error("AI вернул пустой результат");
  }

  // ─── APPLY FILE OPS ───
  for (const op of ops) {
    if (!op?.path || !["create", "update", "delete"].includes(op.action)) {
      continue;
    }

    const path = op.path.replace(/^\/+/, "");
    let sha;

    try {
      const { data } = await octokit.repos.getContent({
        owner: ORG,
        repo: repoName,
        path,
        ref: branch,
      });
      sha = data.sha;
    } catch {}

    if (op.action === "delete") {
      if (!sha) continue;
      await octokit.repos.deleteFile({
        owner: ORG,
        repo: repoName,
        path,
        message: `AI delete ${path} — ${cardName}`,
        sha,
        branch,
      });
      continue;
    }

    const content = Buffer.from(op.content || "").toString("base64");

    await octokit.repos.createOrUpdateFileContents({
      owner: ORG,
      repo: repoName,
      path,
      message: `AI ${op.action} ${path} — ${cardName}`,
      content,
      sha,
      branch,
    });
  }

  // ─── COMMENT ───
  const repoUrl = `${GITHUB_BASE}/${repoName}`;

  await fetch(
    `https://api.trello.com/1/cards/${cardId}/actions/comments?key=${
      process.env.TRELLO_KEY
    }&token=${process.env.TRELLO_TOKEN}&text=${encodeURIComponent(
      `Готово (${projectType})\n${repoUrl}`
    )}`,
    { method: "POST" }
  ).catch(() => {});
}

export const config = {
  api: { bodyParser: false },
};
