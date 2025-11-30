import { Octokit } from "@octokit/rest";

const octokit = new Octokit({ auth: process.env.GH_PAT });
const ORG = "ljudidela";

async function importAll() {
  const { data: repos } = await octokit.repos.listForOrg({ org: ORG });

  for (const repo of repos) {
    if (repo.archived || repo.fork) continue;

    try {
      // Проверяем, существует ли проект
      const check = await fetch(
        `https://api.vercel.com/v9/projects/${repo.name}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
          },
        }
      );

      if (check.status === 404) {
        // Создаём проект
        const res = await fetch("https://api.vercel.com/v9/projects", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: repo.name,
            gitRepository: {
              type: "github",
              repo: `${ORG}/${repo.name}`,
            },
          }),
        });

        if (res.ok) {
          console.log(`Создан и задеплоен: ${repo.name}`);

          await fetch("https://api.vercel.com/v13/deployments", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              name: repo.name,
              project: repo.name,
              gitSource: {
                repoId: repo.id,
                type: "github",
                ref: "main",
              },
              target: "production",
            }),
          });
          console.log(`Запущен первый деплой: ${repo.name}`);
        } else {
          const text = await res.text();
          console.error(
            `Ошибка создания ${repo.name}: ${res.status} — ${text}`
          );
        }
      } else {
        console.log(`Уже существует: ${repo.name}`);
      }
    } catch (e) {
      console.error(`Критическая ошибка с ${repo.name}:`, e.message);
    }

    // Пауза, чтобы не словить rate-limit Vercel
    await new Promise((r) => setTimeout(r, 1200));
  }
}

importAll().catch(console.error);
