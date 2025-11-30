// import-vercel-org.js (Node.js, запусти node import-vercel-org.js)
const { execSync } = require("child_process");
const { Octokit } = require("@octokit/rest");

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const ORG = "ljudidela";
const VERCEL_TOKEN = process.env.VERCEL_TOKEN; // Твой Vercel API token (vercel.com/account/tokens)

async function importAllRepos() {
  const { data: repos } = await octokit.repos.listForOrg({ org: ORG });
  for (const repo of repos) {
    if (repo.name.startsWith("ai-") && !repo.archived) {
      // Фильтр на репо от Володи
      try {
        // Vercel CLI: import repo в Vercel (создаст проект если нет)
        execSync(
          `vercel import ${repo.full_name} --token ${VERCEL_TOKEN} --scope your-team-or-personal --yes`,
          { stdio: "inherit" }
        );
        console.log(`✅ Импортировано и задеплоено: ${repo.html_url}`);
      } catch (e) {
        if (e.message.includes("already exists"))
          console.log(`⏭️ ${repo.name} уже импортировано`);
        else console.error(`❌ Ошибка для ${repo.name}:`, e.message);
      }
    }
  }
}

importAllRepos();
