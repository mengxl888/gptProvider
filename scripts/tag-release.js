#!/usr/bin/env node
// 发版：按 package.json 的版本创建附注标签 vX.Y.Z，标签说明是上一个版本标签以来每个提交的更新点。
// 后台一键更新从 GitHub 的 releases.atom 读这段说明（没有 GitHub Release 时就是标签说明）。
// 提交信息里用「；」分隔的每一段算一个更新点，末尾的「版本 x.y.z」不算；正文里以 - 开头的行也算。
//
//   npm run release:tag              创建标签，然后 git push origin main vX.Y.Z
//   npm run release:tag -- --dry-run 只打印标签说明

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// stderr 也收起来：没有更早的标签时 git describe 会报错，属于正常情况。
const git = (args, input) => execFileSync('git', args, { encoding: 'utf8', input, stdio: 'pipe' }).trim();

export function changePoints(message) {
  const [subject = '', ...body] = message.trim().split('\n');
  const points = subject
    .split(/[；;]\s*/)
    .map((s) => s.trim().replace(/[。.]$/, ''))
    .filter((s) => s && !/^版本\s*v?\d+\.\d+\.\d+/.test(s));
  for (const line of body) {
    const item = /^\s*[-*•]\s+(.+)/.exec(line)?.[1]?.trim();
    if (item) points.push(item);
  }
  return points;
}

export function releaseMessage(messages) {
  const points = messages.flatMap(changePoints);
  return (points.length ? points : ['版本号更新']).map((p) => `- ${p}`).join('\n');
}

// ref 之前最近的版本标签；没有就只取 ref 这一个提交
function commitMessages(ref) {
  let previous = null;
  try {
    previous = git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', `${ref}^`]);
  } catch {}
  const range = previous ? `${previous}..${ref}` : `${ref}^!`;
  const out = git(['log', '--no-merges', '--reverse', '--format=%B%x00', range]);
  return { previous, messages: out.split('\0').map((m) => m.trim()).filter(Boolean) };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const tag = `v${version}`;
  const dryRun = process.argv.includes('--dry-run');
  const { previous, messages } = commitMessages('HEAD');
  // 第一行是标题：GitHub 把标签说明的第一行当作标题，其余行才是 releases.atom 里的说明内容。
  const message = `${tag}\n\n${releaseMessage(messages)}`;
  console.log(`${tag}（${previous ? `${previous} 之后 ${messages.length} 个提交` : '没有更早的版本标签，只取最新提交'}）\n${message}`);
  if (dryRun) return;
  if (git(['tag', '-l', tag])) throw new Error(`标签 ${tag} 已存在，先在 package.json 里升版本号`);
  if (git(['status', '--porcelain'])) throw new Error('还有未提交的改动，先提交再打标签');
  git(['tag', '-a', tag, '-F', '-'], message);
  console.log(`\n已创建标签 ${tag}，推送：git push origin main ${tag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
