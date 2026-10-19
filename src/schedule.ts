import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
export function writeSchedule(dir: string, root: string, config: string, hour: number): string[] {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('--hour must be 0..23 (host local timezone)');
  const scheduleDir = join(dir, 'schedule'); mkdirSync(scheduleDir, { recursive: true });
  const args = [process.execPath, fileURLToPath(new URL('./cli.js', import.meta.url)), 'night', '--config', config];
  const searchPath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  const plist = join(scheduleDir, 'local.contributor.nightly.plist');
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>local.contributor.nightly</string>\n<key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join('')}</array>\n<key>WorkingDirectory</key><string>${xml(root)}</string>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(searchPath)}</string></dict>\n<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>0</integer></dict>\n<key>StandardOutPath</key><string>${xml(join(dir, 'scheduler.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(join(dir, 'scheduler-error.log'))}</string>\n</dict></plist>\n`);
  const cron = join(scheduleDir, 'night.cron');
  const line = `0 ${hour} * * * cd ${quote(root)} && PATH=${quote(searchPath)} ${args.map(quote).join(' ')} >> ${quote(join(dir, 'scheduler.log'))} 2>&1`;
  // Cron treats % specially even inside shell quotes.
  writeFileSync(cron, line.replace(/%/g, '\\%') + '\n');
  return [plist, cron];
}
