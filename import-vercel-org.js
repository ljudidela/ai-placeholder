const octokit = new Octokit({ auth: process.env.GH_PAT });
const ORG = "ljudidela";

async function importAll() {
  const { data: repos } = await octokit.repos.listForOrg({ org: ORG });

  for (const repo of repos) {
    if (repo.archived || repo.fork) continue;

    try {
      // Проверяем, есть ли уже проект
      const check = await fetch(
        `https://api.vercel.com/v9/projects/${repo.name}`,
        {
          headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` },
        }
      );

      if (check.status === 404) {
        // Создаём новый проект
        const create = await fetch("https://api.vercel.com/v9/projects", {
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

        if (create.ok) {
          console.log(`Создан и задеплоен: ${repo.name}`);
        } else {
          console.error(`Ошибка создания ${repo.name}:`, await create.text());
        }
      } else {
        console.log(`Уже существует: ${repo.name}`);
      }
    } catch (e) {
      console.error(`Критическая ошибка с ${repo.name}:`, e.message);
    }

    // Чтобы не словить rate-limit
    await new Promise((r) => setTimeout(r, 1000));
  }
}

importAll();
