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

Важное:
- Возвращай ТОЛЬКО один JSON-массив без обёрток, без пояснений и без markdown.
- Формат строго: [{"path": "путь/к/файлу", "action": "create"|"update"|"delete", "content": "строка с содержимым файла или пустая строка для delete"}, ...]
- Путь не должен начинаться с слеша. Примеры: "README.md", "package.json", "src/main.tsx".
- Для action="delete" поле "content" должно быть пустой строкой.

Описание задачи:
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
        model: "sonar-pro",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 16000,
        temperature: 0.3,
      }),
    });

    if (!aiRes.ok) throw new Error("Perplexity: " + (await aiRes.text()));
    const aiData = await aiRes.json();
    let filesJsonRaw = aiData.choices[0].message.content.trim();

    console.log("ПЕРПЛЕКСИТИ ОТВЕТИЛ (первые 1000 символов):");
    console.log(
      filesJsonRaw.substring(0, 1000) +
        (filesJsonRaw.length > 1000 ? "\n... (обрезано)" : "")
    );

    // иногда модель может вернуть ```json ... ``` — аккуратно вырезаем
    let jsonMatch = filesJsonRaw.match(/```json([\s\S]*?)```/i);
    if (jsonMatch) {
      filesJsonRaw = jsonMatch[1].trim();
    } else {
      // может быть просто ``` без json
      jsonMatch = filesJsonRaw.match(/```([\s\S]*?)```/);
      if (jsonMatch) {
        filesJsonRaw = jsonMatch[1].trim();
      }
    }

    // пытаемся найти начало JSON-массива
    const arrayStart = filesJsonRaw.indexOf("[");
    if (arrayStart > 0) {
      filesJsonRaw = filesJsonRaw.substring(arrayStart);
      console.log("Найдено начало массива, обрезано", arrayStart, "символов");
    }

    let fileOps;
    try {
      fileOps = JSON.parse(filesJsonRaw);
    } catch (parseErr) {
      console.error(
        "Не удалось распарсить JSON от Perplexity:",
        parseErr.message
      );
      console.log(
        `Длина ответа: ${filesJsonRaw.length} символов, последние 200:`,
        filesJsonRaw.substring(Math.max(0, filesJsonRaw.length - 200))
      );

      // пытаемся восстановить обрезанный JSON
      const errorPos = parseErr.message.match(/position (\d+)/)?.[1];
      if (errorPos) {
        const pos = parseInt(errorPos, 10);
        console.log(`Ошибка на позиции ${pos}, пытаемся восстановить...`);

        // стратегия 1: ищем последний валидный объект, идя назад от позиции ошибки
        let truncated = filesJsonRaw.substring(0, pos);

        // ищем последнюю закрывающую скобку объекта, которая не внутри строки
        let depth = 0;
        let inString = false;
        let escapeNext = false;
        let lastValidObjEnd = -1;

        for (let i = truncated.length - 1; i >= 0; i--) {
          const char = truncated[i];

          if (escapeNext) {
            escapeNext = false;
            continue;
          }

          if (char === "\\") {
            escapeNext = true;
            continue;
          }

          if (char === '"' && !escapeNext) {
            inString = !inString;
            continue;
          }

          if (inString) continue;

          if (char === "}") {
            depth++;
            if (depth === 1) {
              lastValidObjEnd = i;
            }
          } else if (char === "{") {
            depth--;
            if (depth === 0 && lastValidObjEnd > 0) {
              // нашли начало и конец последнего валидного объекта
              truncated = truncated.substring(0, lastValidObjEnd + 1);
              truncated += "]";
              try {
                fileOps = JSON.parse(truncated);
                console.log(
                  `Восстановлен обрезанный JSON (стратегия 1), получено ${fileOps.length} операций`
                );
              } catch (e2) {
                console.log("Стратегия 1 не сработала, пробуем стратегию 2");
              }
              break;
            }
          }
        }

        // стратегия 2: если первая не сработала, просто ищем последний }
        if (!fileOps) {
          const lastBrace = truncated.lastIndexOf("}");
          if (lastBrace > 0) {
            truncated = truncated.substring(0, lastBrace + 1);
            truncated += "]";
            try {
              fileOps = JSON.parse(truncated);
              console.log(
                `Восстановлен обрезанный JSON (стратегия 2), получено ${fileOps.length} операций`
              );
            } catch (e2) {
              console.log("Стратегия 2 не сработала");
            }
          }
        }
      }

      // если всё ещё не получилось — fallback
      if (!fileOps) {
        console.log(
          "Fallback: трактуем ответ ИИ как содержимое README.md целиком"
        );
        fileOps = [
          {
            path: "README.md",
            action: "update",
            content: filesJsonRaw,
          },
        ];
      }
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
    for (const op of fileOps) {
      if (!op || typeof op.path !== "string" || !op.action) continue;

      const action = op.action.toLowerCase();
      const normalizedPath = op.path.replace(/^\/+/, "");

      if (!["create", "update", "delete"].includes(action)) {
        console.log("Пропускаем неизвестное действие:", action, normalizedPath);
        continue;
      }

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
          throw e;
        }
      }

      if (action === "delete") {
        if (!existingSha) {
          console.log(
            "Файл для удаления не найден, пропускаем:",
            normalizedPath
          );
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
        continue;
      }

      const content =
        typeof op.content === "string" ? op.content : String(op.content || "");

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
    }

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
