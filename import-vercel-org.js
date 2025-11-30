// import-vercel-org.js  ← 100% работает в ESM (type: "module")
import { execSync } from "child_process";
import { Octokit } from "@octokit/rest";

const octokit = new Octokit({ auth: process.env.GH_PAT });
const ORG = "ljudidela";
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;

async function importAllRepos() {
  const { data: repos } = await octokit.repos.listForOrg({ org: ORG });

  for (const repo of repos) {
    // Пропускаем архивные и публичные (если хочешь — убери условие)
    if (repo.archived || !repo.private) continue;

    const projectName = repo.name;

    try {
      // Создаём/линкуем проект в Vercel + сразу деплоим prod
      execSync(
        `vercel link --yes --token ${VERCEL_TOKEN} --project ${projectName} --scope personal`,
        { stdio: "ignore" }
      );
      execSync(`vercel --prod --yes --token ${VERCEL_TOKEN} --force`, {
        stdio: "ignore",
      });
      console.log(`Импортировано и задеплоено: ${projectName}`);
    } catch (e) {
      // Если уже существует — просто игнорируем ошибку
      if (
        e.message.includes("already exists") ||
        e.message.includes("linked")
      ) {
        console.log(`Уже есть: ${projectName}`);
      } else {
        console.error(`Ошибка с ${projectName}:`, e.message);
      }
    }
  }
}

importAllRepos().catch(console.error);
