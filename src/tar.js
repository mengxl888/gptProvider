// 最小的 tar 解包（给一键更新解 GitHub 源码包用）：支持普通文件、目录、pax / GNU 长文件名，
// 跳过符号链接等其他类型；拒绝跳出目标目录的路径。

import fs from 'node:fs';
import path from 'node:path';

export function untar(buffer, destDir, { strip = 0 } = {}) {
  const root = path.resolve(destDir);
  let offset = 0;
  let longPath = null;
  let files = 0;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = field(header, 0, 100);
    const size = parseInt(field(header, 124, 12).trim() || '0', 8);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const prefix = field(header, 345, 155);
    offset += 512;
    const data = buffer.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (type === 'g') continue; // pax 全局头（GitHub 在这里放 commit id）
    if (type === 'x') {
      longPath = parsePax(data).path ?? longPath;
      continue;
    }
    if (type === 'L') {
      longPath = data.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }

    const fullName = longPath || (prefix ? `${prefix}/${name}` : name);
    longPath = null;
    const parts = fullName.split('/').filter((p) => p && p !== '.').slice(strip);
    if (parts.length === 0) continue;
    const target = path.resolve(root, ...parts);
    const rel = path.relative(root, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`压缩包里有不安全的路径：${fullName}`);

    if (type === '5') {
      fs.mkdirSync(target, { recursive: true });
    } else if (type === '0' || type === '7') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      files++;
    }
  }
  return files;
}

function field(header, start, length) {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString('utf8');
}

// pax 扩展头："<长度> <键>=<值>\n" 逐条排列。
function parsePax(data) {
  const result = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const len = Number(data.subarray(pos, space).toString());
    if (!len) break;
    const record = data.subarray(space + 1, pos + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) result[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return result;
}
