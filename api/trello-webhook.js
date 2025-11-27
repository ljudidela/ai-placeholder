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

КРИТИЧЕСКИ ВАЖНО:
- Возвращай ТОЛЬКО валидный JSON-массив, БЕЗ markdown-обёрток, БЕЗ пояснений.
- Формат: [{"path": "путь/к/файлу", "action": "create" или "update" или "delete", "content": "содержимое файла"}, ...]
- В поле "content" ВСЕ специальные символы должны быть правильно экранированы для JSON:
  * переносы строк: двойной обратный слеш + n
  * кавычки: двойной обратный слеш + кавычка
  * обратные слеши: четыре обратных слеша подряд
  * табы: двойной обратный слеш + t
- НЕ используй markdown-блоки кода внутри content.
- Путь без начального слеша. Примеры: "README.md", "package.json", "src/main.tsx".
- Для action="delete" поле "content" должно быть пустой строкой "".

Пример правильного JSON:
[{"path": "README.md", "action": "create", "content": "# Title\\\\n\\\\nDescription"}]

Ограничь каждый "content" до 6000 символов. Если файл больше — разбей на части с суффиксом .part1, .part2 и т.д., а потом склей.

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
        model: "sonar-reasoning",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 32000,
        temperature: 0.2,
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

      // стратегия 0: пытаемся извлечь объекты вручную, парся по частям
      // ищем начало каждого объекта {"path": и пытаемся извлечь его целиком
      try {
        const extracted = [];
        let searchPos = 0;

        while (true) {
          // ищем начало объекта разными способами
          let objStart = filesJsonRaw.indexOf('{"path"', searchPos);
          if (objStart === -1)
            objStart = filesJsonRaw.indexOf('{ "path"', searchPos);
          if (objStart === -1)
            objStart = filesJsonRaw.indexOf('{\n  "path"', searchPos);
          if (objStart === -1) {
            // пробуем найти просто "path" и идти назад до {
            const pathPos = filesJsonRaw.indexOf('"path"', searchPos);
            if (pathPos !== -1) {
              for (let i = pathPos; i >= 0 && i >= pathPos - 50; i--) {
                if (filesJsonRaw[i] === "{") {
                  objStart = i;
                  break;
                }
              }
            }
          }
          if (objStart === -1) break;

          // ищем конец объекта - закрывающую }
          let depth = 0;
          let inString = false;
          let escapeNext = false;
          let objEnd = -1;

          for (let i = objStart; i < filesJsonRaw.length; i++) {
            const char = filesJsonRaw[i];

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

            if (char === "{") depth++;
            if (char === "}") {
              depth--;
              if (depth === 0) {
                objEnd = i;
                break;
              }
            }
          }

          if (objEnd > objStart) {
            const objStr = filesJsonRaw.substring(objStart, objEnd + 1);
            try {
              const parsed = JSON.parse(objStr);
              if (parsed.path && parsed.action) {
                // JSON.parse уже правильно декодировал все экранированные символы
                // content уже в правильном виде, не трогаем его
                extracted.push(parsed);
                console.log(
                  `✓ Извлечён объект: ${parsed.path} (${parsed.action})`
                );
              }
            } catch (e) {
              // этот объект невалиден, пробуем regex
              try {
                // используем более умный regex, который правильно обрабатывает экранированные символы
                const pathMatch = objStr.match(
                  /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/
                );
                const actionMatch = objStr.match(
                  /"action"\s*:\s*"((?:[^"\\]|\\.)*)"/
                );
                // для content нужно захватить всё до закрывающей кавычки, учитывая экранирование
                const contentMatch = objStr.match(
                  /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/
                );

                if (pathMatch && actionMatch) {
                  const path = pathMatch[1].replace(/\\(.)/g, "$1"); // декодируем экранированные символы
                  const action = actionMatch[1].replace(/\\(.)/g, "$1");
                  let content = contentMatch ? contentMatch[1] : "";

                  // декодируем экранированные символы в content
                  // заменяем \\n на \n, \\t на \t и т.д.
                  content = content.replace(/\\(.)/g, (match, char) => {
                    switch (char) {
                      case "n":
                        return "\n";
                      case "t":
                        return "\t";
                      case "r":
                        return "\r";
                      case '"':
                        return '"';
                      case "\\":
                        return "\\";
                      default:
                        return match; // оставляем как есть, если не знаем
                    }
                  });

                  extracted.push({ path, action, content });
                  console.log(`✓ Извлечён объект (regex): ${path} (${action})`);
                }
              } catch (regexErr) {
                // пропускаем этот объект
              }
            }
            searchPos = objEnd + 1;
          } else {
            break;
          }
        }

        if (extracted.length > 0) {
          fileOps = extracted;
          console.log(
            `Извлечено ${extracted.length} объектов через ручной парсинг (стратегия 0)`
          );
        }
      } catch (manualErr) {
        console.log(
          "Стратегия 0 (ручной парсинг) не сработала:",
          manualErr.message
        );
      }

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

      // если всё ещё не получилось — НЕ делаем fallback на README
      // лучше вернуть ошибку, чем записать весь ответ в README
      if (!fileOps) {
        console.error(
          "КРИТИЧЕСКАЯ ОШИБКА: Не удалось извлечь ни одного файла из ответа ИИ"
        );
        console.error(
          "Первые 500 символов ответа:",
          filesJsonRaw.substring(0, 500)
        );
        throw new Error(
          "AI вернул невалидный JSON, и не удалось извлечь файлы. " +
            "Проверь промпт и формат ответа. Длина ответа: " +
            filesJsonRaw.length +
            " символов"
        );
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
