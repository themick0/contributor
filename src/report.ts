import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Store } from './store.js';
import type { Run } from './types.js';

const escape = (text: string) => text.replace(/[\r\n|]/g, ' ').replace(/</g, '&lt;');
export function writeReport(store: Store, run: Run): string {
  const dir = join(store.dir, 'runs', run.id);
  mkdirSync(dir, { recursive: true });
  const tasks = store.state.tasks.filter(t => run.taskIds.includes(t.id));
  const rows = tasks.map(task => {
    const a = task.attempts.find(a => a.runId === run.id)!;
    const artifact = encodeURI(relative(dir, a.dir));
    const link = a.status === 'ready' ? `[PR draft](${artifact}/PR.md) · [patch](${artifact}/change.patch)` : `[result](${artifact}/result.json)`;
    return `| [${escape(task.id)}](${task.issue.url}) | ${a.status} | ${a.tokens} | ${escape(a.reason)} | ${link} |`;
  });
  const ready = tasks.filter(t => t.attempts.find(a => a.runId === run.id)?.status === 'ready').length;
  const report = `# Night ${run.id}\n\n${ready} ready / ${tasks.length} attempted. Token usage reported by completed agent stages: ${run.tokens}.\n\nStarted: ${run.startedAt}. Finished: ${run.finishedAt ?? 'running'}.\n\n${run.reason || 'Local branches and drafts only.'}\n\n| Issue | Status | Tokens | Result | Artifacts |\n| --- | --- | ---: | --- | --- |\n${rows.join('\n')}\n\n## Morning review\n\nOpen each ready task's PR.md, change.patch, result.json, and logs/. The checkout is in repo/ on the recorded branch. Review the changes, check upstream issue/PR activity again, and run any remaining platform checks before publishing manually. Failed/skipped tasks include the reason and retained evidence.\n\nMerged PRs and acceptance rate are not measured by this local preparation pipeline.\n`;
  const path = join(dir, 'report.md'); writeFileSync(path, report);
  if (run.discoveryRounds !== undefined) writeFileSync(path, `\nIssue discovery rounds: ${run.discoveryRounds}. ${escape(run.discoveryStop ?? 'In progress')}.\n`, { flag: 'a' });
  if (run.scoutDir) writeFileSync(path, `\nRepository discovery: [scout report](${encodeURI(relative(dir, run.scoutDir))}/report.md). This run's token total includes any new scout stages. Cached stages are not charged again.\n`, { flag: 'a' });
  writeFileSync(join(store.dir, 'latest-report.md'), `Latest report: [${run.id}](runs/${run.id}/report.md)\n`);
  return path;
}
