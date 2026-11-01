import type { Handoff } from "@/shared/contracts/handoffs";
import type { Project } from "@/shared/contracts/projects";
import type { Lang } from "@/shared/i18n/locale";
import { replyTitle } from "@/shared/formatting/reply-title";

const sampleContent: Record<Lang, string[]> = {
  en: [
    "# Task\nContinue the login flow.\n\n## Progress\nPage layout and form validation are done.\n\n## Next\n1. Check the current branch and working tree.\n2. Finish the login endpoint and handle its error states.\n3. Run the related tests and report the results.\n\n## Constraints\nKeep existing changes. Read the project rules before running anything.",
    "Reproduce the failing tests first, find the cause and make the smallest fix.\nReport which checks you ran and their results.",
    "Read the current workspace and project rules, then list concrete next steps the next device can carry out.",
    "Should the deployment checklist cover the staging site as well, or only production?",
  ],
  zh: [
    "# 任务\n继续完成登录流程。\n\n## 当前进度\n已完成页面布局与表单验证。\n\n## 下一步\n1. 检查当前分支与工作区状态。\n2. 完成登录接口并处理错误状态。\n3. 运行相关测试并报告结果。\n\n## 约束\n保留现有改动，执行前核对项目规则。",
    "请先复现失败的测试，定位原因并做最小修复。\n完成后报告运行的检查与结果。",
    "请阅读当前工作区与项目规则，整理下一台设备可以继续执行的具体步骤。",
    "部署检查清单是否也要覆盖预发布站点，还是只覆盖生产环境？",
  ],
};
const sampleTitles: Record<Lang, string[]> = {
  en: ["Continue the login flow", "Find why the tests fail", "Plan the next steps"],
  zh: ["继续实现登录流程", "检查测试失败原因", "整理下一步开发计划"],
};
// The completed sample carries a receipt, written the way the device rule asks agents to write one.
const sampleResult: Record<Lang, string> = {
  en: "## Summary\nListed five next steps for the docs site.\n\n## Changes\n- `docs/next-steps.md` on branch `docs/next-steps`\n\n## Open questions\n- Should the deployment checklist cover staging?",
  zh: "## Summary\n为文档站整理了五个下一步。\n\n## Changes\n- 分支 `docs/next-steps` 上的 `docs/next-steps.md`\n\n## Open questions\n- 部署检查清单是否要覆盖预发布站点？",
};
// [source, target, status, reply-to index]; the last sample answers the completed one, so the sample view shows a thread.
const sampleRoutes: [string, string, string, number | null][] = [["0", "1", "ready", null], ["0", "1", "claimed", null], ["2", "0", "done", null], ["0", "2", "ready", 2]];
// Project names are identifiers like device names, so they stay the same in both languages.
const sampleProjects: Project[] = [
  { id: "example-web-app", name: "web-app", line: "teal", archived: false, lastUsedAt: 1792869780000, createdAt: 1792869780000, updatedAt: 1792869780000, version: 1 },
  { id: "example-docs-site", name: "docs-site", line: "violet", archived: false, lastUsedAt: 1792783380000, createdAt: 1792783380000, updatedAt: 1792783380000, version: 1 },
];
const sampleProjectOf = [0, 0, 1, 1];
// The first sample shows the code state an agent attaches when it sends from a repository; the hash is made up.
const sampleGit: Pick<Handoff, "branch" | "baseCommit">[] = [{ branch: "feat/login-flow", baseCommit: "4f2c9e1a7b3d5f60812e9c4a6b8d0f2e4a6c8e01" }];

/** The sample view's projects; like the sample rows they are never persisted. */
export function exampleProjects(): readonly Project[] { return sampleProjects; }

/** Illustrative, never-persisted handoffs for the sample view. Timestamps are fixed on purpose. */
export function examples(lang: Lang, devices: string[]): Handoff[] {
  return sampleRoutes.map(([from, to, status, parent], i) => {
    const project = sampleProjects[sampleProjectOf[i]];
    const title = parent === null ? sampleTitles[lang][i] : replyTitle(sampleTitles[lang][parent]);
    const replyToId = parent === null ? null : `example-${parent}`;
    return { id: `example-${i}`, title, project: project.name, projectId: project.id, sourceDevice: devices[Number(from)],
      targetDevice: devices[Number(to)], content: sampleContent[lang][i], status, claimedBy: status === "ready" ? null : devices[Number(to)],
      // The reply is the newest sample, so it sits first in the list like a fresh arrival.
      createdAt: parent === null ? 1792869780000 - i * 86400000 : 1792869780000 + 3600000, updatedAt: 1792869780000, expiresAt: null, version: 1, attachments: [],
      result: status === "done" ? sampleResult[lang] : null, replyToId, threadId: replyToId, branch: null, baseCommit: null, ...sampleGit[i] };
  });
}
