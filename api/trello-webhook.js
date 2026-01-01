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
const processedActions = new Set();
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
    specific = await loadPrompt("web-vite.txt");
  }
  return `${base}\n\n${specific}\n\n${repoContext}\n\nЗАДАЧА:\n${cardDesc}\n\nОтвечай ТОЛЬКО чистым JSON-массивом операций.`;
}

function getProjectType(payload, boardName) {
  if (process.env.PROJECT_TYPE)
    return process.env.PROJECT_TYPE.trim().toLowerCase();
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

// ────────────── OCTOKIT SAFE WRAPPER ──────────────
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
  if (req.method !== "POST") return res.status(200).end();

  let payload;
  try {
    payload = JSON.parse((await raw(req)).toString("utf-8"));
  } catch {
    return res.status(400).end("Invalid JSON");
  }

  // Отвечаем сразу
  res.status(200).json({ ok: true });

  // Fire-and-forget
  processCard(payload).catch((err) => console.error("PROCESS ERROR:", err));
}

// ────────────── PROCESS CARD ──────────────
async function processCard(payload) {
  const action = payload.action;
  if (!action || processedActions.has(action.id)) return;
  processedActions.add(action.id);

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

  let boardName = action.data?.board?.name || payload.model?.name || "ai-board";
  if (!boardName) {
    const r = await fetch(
      `https://api.trello.com/1/cards/${cardId}/board?key=${process.env.TRELLO_KEY}&token=${process.env.TRELLO_TOKEN}`
    );
    if (r.ok) boardName = (await r.json()).name;
  }
  boardName = boardName.trim() || "ai-board";
  const projectType = getProjectType(payload, boardName);

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

  // ─── REPO CONTEXT ───
  let repoInfo;
  let repoContext = "";
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
    const files = tree.tree
      .filter((f) => f.type === "blob")
      .map((f) => f.path)
      .slice(0, 100)
      .join("\n");
    repoContext = `СУЩЕСТВУЮЩИЙ ПРОЕКТ\n${files}\n\nИспользуй update для существующих файлов.`;
  } catch (e) {
    if (e.status !== 404) throw e;
    repoInfo = await safeOctokit(() =>
      octokit.repos.createInOrg({
        org: ORG,
        name: repoName,
        private: false,
        auto_init: true,
      })
    );
    repoContext = `НОВЫЙ ПРОЕКТ (${projectType})`;
  }

  const branch = repoInfo.data.default_branch || "main";
  const prompt = await buildPrompt(cardDesc, repoContext, projectType);
  const ai = getAdapter(process.env.AI_PROVIDER || "neuro");
  const ops = await ai.generateCode(prompt);
  if (!Array.isArray(ops) || ops.length === 0)
    throw new Error("AI вернул пустой результат");

  for (const op of ops) {
    if (!op?.path || !["create", "update", "delete"].includes(op.action))
      continue;
    const path = op.path.replace(/^\/+/, "");
    let sha;
    try {
      const { data } = await safeOctokit(() =>
        octokit.repos.getContent({
          owner: ORG,
          repo: repoName,
          path,
          ref: branch,
        })
      );
      sha = data.sha;
    } catch {}

    if (op.action === "delete") {
      if (!sha) continue;
      await safeOctokit(() =>
        octokit.repos.deleteFile({
          owner: ORG,
          repo: repoName,
          path,
          message: `AI delete ${path} — ${cardName}`,
          sha,
          branch,
        })
      );
      continue;
    }

    const content = Buffer.from(op.content || "").toString("base64");
    await safeOctokit(() =>
      octokit.repos.createOrUpdateFileContents({
        owner: ORG,
        repo: repoName,
        path,
        message: `AI ${op.action} ${path} — ${cardName}`,
        content,
        sha,
        branch,
      })
    );
  }

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

export const config = { api: { bodyParser: false } };
