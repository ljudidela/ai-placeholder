import { Octokit } from "@octokit/rest";
import raw from "raw-body";
import { getAdapter } from "./ai-adapters/index.js";

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

  if (!cardDescRaw) {
    return res.status(200).end();
  }

  const cardDesc = cardDescRaw;

  let boardName =
    payload.action?.data?.board?.name || payload.model?.name || "ai-board";

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

  boardName = boardName.trim() || "ai-board";

  // определяем репозиторий до генерации, чтобы прочитать существующий код
  let repoName = boardName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");

  if (!repoName) repoName = "ai-project";

  const finalRepoName = repoName;

  console.log("BOARD NAME ДЛЯ РЕПО:", boardName);
  console.log("ЦЕЛЕВОЙ РЕПО ДЛЯ ДОСКИ:", finalRepoName);

  let repoInfo;
  let existingRepoContext = "";

  try {
    console.log("Пробуем получить репозиторий:", finalRepoName);
    repoInfo = await octokit.repos.get({ owner: ORG, repo: finalRepoName });
    console.log("Репозиторий для доски уже существует:", finalRepoName);

    // читаем существующий репозиторий для контекста
    const targetBranch =
      repoInfo?.data?.default_branch &&
      typeof repoInfo.data.default_branch === "string"
        ? repoInfo.data.default_branch
        : "main";

    console.log("Читаем существующий репозиторий для контекста...");

    // получаем список файлов через рекурсивное чтение корня
    let filesList = [];
    try {
      const { data: rootContent } = await octokit.repos.getContent({
        owner: ORG,
        repo: finalRepoName,
        path: "",
        ref: targetBranch,
      });
      if (Array.isArray(rootContent)) {
        filesList = rootContent.map((item) => item.path);
      }
    } catch (e) {
      console.log("Не удалось получить список файлов:", e.status);
    }

    // читаем ключевые файлы для контекста
    const keyFiles = [
      "README.md",
      "package.json",
      "tsconfig.json",
      "vite.config.ts",
      "vite.config.js",
    ];
    const existingFiles = {};

    // пробуем прочитать ключевые файлы из корня
    for (const fileName of keyFiles) {
      try {
        const { data: fileContent } = await octokit.repos.getContent({
          owner: ORG,
          repo: finalRepoName,
          path: fileName,
          ref: targetBranch,
        });
        if (!Array.isArray(fileContent) && fileContent.content) {
          const decoded = Buffer.from(fileContent.content, "base64").toString(
            "utf-8"
          );
          existingFiles[fileName] = decoded;
          console.log(
            `Прочитан файл для контекста: ${fileName} (${decoded.length} символов)`
          );
        }
      } catch (e) {
        // файл не найден - это нормально
      }
    }

    // формируем контекст существующего проекта
    if (Object.keys(existingFiles).length > 0 || filesList.length > 0) {
      existingRepoContext = `\n\nСУЩЕСТВУЮЩИЙ ПРОЕКТ:\n\n`;
      for (const [path, content] of Object.entries(existingFiles)) {
        existingRepoContext += `--- Файл: ${path} ---\n${content}\n\n`;
      }
      if (filesList.length > 0) {
        existingRepoContext += `\nСтруктура проекта (найдено файлов/папок: ${filesList.length}):\n`;
        const paths = filesList.slice(0, 30);
        existingRepoContext += paths.join("\n");
        if (filesList.length > 30) {
          existingRepoContext += `\n... и ещё ${
            filesList.length - 30
          } элементов`;
        }
      }
      existingRepoContext += `\n\nВАЖНО: Анализируй существующий код и вноси изменения точечно. Не переписывай всё с нуля, если не требуется полная переработка.`;
    }
  } catch (e) {
    if (e.status === 404) {
      console.log("Репозиторий не найден (404), будет создан новый");
      existingRepoContext = "\n\nПРОЕКТ НОВЫЙ (репозиторий будет создан).";
    } else {
      console.error("Ошибка при получении репозитория:", e.status, e.message);
      throw e;
    }
  }

  // если репозиторий не существует, создаём его
  if (!repoInfo) {
    try {
      console.log("Создаём новый репозиторий:", finalRepoName);
      await octokit.repos.createInOrg({
        org: ORG,
        name: finalRepoName,
        private: true,
        auto_init: true,
      });
      console.log("Создан новый репозиторий для доски:", finalRepoName);
      repoInfo = await octokit.repos.get({
        owner: ORG,
        repo: finalRepoName,
      });
    } catch (createErr) {
      const msg = createErr?.message || String(createErr);
      const status = createErr?.status;
      console.error(
        "Ошибка при создании репозитория:",
        status,
        msg,
        createErr?.response?.data || ""
      );

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
  }

  const targetBranch =
    repoInfo?.data?.default_branch &&
    typeof repoInfo.data.default_branch === "string"
      ? repoInfo.data.default_branch
      : "main";

  try {
    const prompt = `Ты — senior разработчик.

      ${existingRepoContext}

      Задача:
      ${cardDesc}

      Верни изменения строго по JSON-схеме (ни одного лишнего символа, никаких пояснений):
      массив объектов {path, action, content}.
      Сначала обнови README.md, потом package.json, потом основные файлы src/.
      Если файл большой — всё равно возвращай полностью, схема это поддерживает.`;

    // Выбор провайдера через переменную окружения
    const AI_PROVIDER = process.env.AI_PROVIDER || "perplexity"; // 'perplexity' или 'yandex'

    console.log("ПРОМПТ ОТПРАВЛЯЕМ:", prompt.substring(0, 300) + "...");

    // Получаем адаптер
    const aiAdapter = getAdapter(AI_PROVIDER);

    // Генерируем код через адаптер
    let fileOps;
    try {
      fileOps = await aiAdapter.generateCode(prompt);
      console.log(
        `Схема сработала! Получено ${fileOps.length} операций от ${AI_PROVIDER}`
      );
    } catch (parseErr) {
      console.error(
        `JSON.parse провалился для ${AI_PROVIDER}:`,
        parseErr.message
      );
      console.error(
        "Первые 500 символов:",
        parseErr.content?.substring(0, 500) || "N/A"
      );
      throw new Error(
        `AI (${AI_PROVIDER}) вернул невалидный JSON: ${parseErr.message}`
      );
    }

    if (!Array.isArray(fileOps)) {
      throw new Error("AI вернул некорректный формат: ожидался массив файлов");
    }

    console.log(
      "Получено операций с файлами от AI:",
      fileOps.length,
      fileOps.slice(0, 5).map((f) => f.path)
    );

    console.log(
      "Готовимся применять файл-операции в репо:",
      finalRepoName,
      "ветка:",
      targetBranch
    );

    // применяем изменения для каждого файла
    const results = { success: [], failed: [] };

    for (const op of fileOps) {
      if (!op || typeof op.path !== "string" || !op.action) {
        console.log("Пропускаем некорректную операцию:", op);
        continue;
      }

      const action = op.action.toLowerCase();
      const normalizedPath = op.path.replace(/^\/+/, "");

      if (!["create", "update", "delete"].includes(action)) {
        console.log("Пропускаем неизвестное действие:", action, normalizedPath);
        continue;
      }

      // оборачиваем каждую операцию в try-catch, чтобы ошибка на одном файле не останавливала остальные
      try {
        console.log(`Обрабатываем файл: ${normalizedPath}, action: ${action}`);

        // сначала пробуем получить текущий файл, чтобы знать sha
        let existingSha;
        try {
          const { data: existing } = await octokit.repos.getContent({
            owner: ORG,
            repo: finalRepoName,
            path: normalizedPath,
            ref: targetBranch,
          });
          if (!Array.isArray(existing)) {
            existingSha = existing.sha;
          }
        } catch (e) {
          if (e.status !== 404) {
            console.error(
              "Ошибка при получении файла перед изменением:",
              normalizedPath,
              e.status,
              e.message
            );
            // не бросаем ошибку, просто логируем и продолжаем
          }
        }

        if (action === "delete") {
          if (!existingSha) {
            console.log(
              "Файл для удаления не найден, пропускаем:",
              normalizedPath
            );
            results.success.push({
              path: normalizedPath,
              action,
              note: "не найден",
            });
            continue;
          }
          console.log("Удаляем файл:", normalizedPath);
          await octokit.repos.deleteFile({
            owner: ORG,
            repo: finalRepoName,
            path: normalizedPath,
            message: `AI delete ${normalizedPath} — ${cardName}`,
            sha: existingSha,
            branch: targetBranch,
          });
          results.success.push({ path: normalizedPath, action });
          continue;
        }

        let content =
          typeof op.content === "string"
            ? op.content
            : String(op.content || "");

        // проверяем, нет ли в content буквальных экранированных символов (например, \n как два символа)
        // это может произойти, если модель вернула неэкранированные символы в JSON
        // проверяем: есть ли последовательность обратный слеш + символ, но нет реальных переносов
        const hasEscapedChars = /\\[ntr"\\]/.test(content);
        const hasRealNewlines = content.includes("\n");

        if (hasEscapedChars && !hasRealNewlines) {
          // есть буквальные экранированные символы, но нет реальных переносов - декодируем
          console.log(
            `⚠ Обнаружены буквальные экранированные символы в ${normalizedPath}, декодируем...`
          );
          content = content
            .replace(/\\n/g, "\n")
            .replace(/\\t/g, "\t")
            .replace(/\\r/g, "\r")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\");
        }

        if (!content && action !== "delete") {
          console.log("Пропускаем файл с пустым содержимым:", normalizedPath);
          results.success.push({
            path: normalizedPath,
            action,
            note: "пустой контент",
          });
          continue;
        }

        console.log(
          `Записываем файл: ${normalizedPath}, bytes:`,
          Buffer.byteLength(content, "utf8"),
          "sha:",
          existingSha || "нет"
        );

        await octokit.repos.createOrUpdateFileContents({
          owner: ORG,
          repo: finalRepoName,
          path: normalizedPath,
          message: `AI ${action} ${normalizedPath} — ${cardName}`,
          content: Buffer.from(content).toString("base64"),
          branch: targetBranch,
          ...(existingSha ? { sha: existingSha } : {}),
        });

        results.success.push({ path: normalizedPath, action });
        console.log(`✓ Успешно обработан файл: ${normalizedPath}`);
      } catch (fileErr) {
        const errorMsg = fileErr?.message || String(fileErr);
        const errorStatus = fileErr?.status;
        console.error(
          `✗ Ошибка при обработке файла ${normalizedPath}:`,
          errorStatus,
          errorMsg
        );
        results.failed.push({
          path: normalizedPath,
          action,
          error: errorMsg,
          status: errorStatus,
        });
        // не бросаем ошибку дальше, продолжаем обработку остальных файлов
      }
    }

    console.log(
      `Итоги обработки файлов: успешно ${results.success.length}, ошибок ${results.failed.length}`
    );
    if (results.failed.length > 0) {
      console.log(
        "Файлы с ошибками:",
        results.failed.map((f) => f.path).join(", ")
      );
    }

    const repoUrl = `${GITHUB_BASE}/${finalRepoName}`;
    let comment = `Репозиторий обновлён автоматически\n${repoUrl}\n\n`;
    comment += `✓ Создано/обновлено файлов: ${results.success.length}`;
    if (results.failed.length > 0) {
      comment += `\n✗ Ошибок: ${results.failed.length}`;
      comment += `\nПроблемные файлы: ${results.failed
        .map((f) => f.path)
        .join(", ")}`;
    }

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
