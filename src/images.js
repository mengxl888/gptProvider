// 生成图片的本地图库：文件存 data/images/<随机id>.<ext>，元数据存 store.images。
// 文件名是 128 位随机数，/images/<file> 不需要鉴权也无法被猜到。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FILE_PATTERN = /^[a-f0-9]{32}\.(png|jpg|webp)$/;
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

export class ImageLibrary {
  constructor({ store, dataDir }) {
    this.store = store;
    this.dir = path.join(dataDir, 'images');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  // image 来自 Codex 的 imageGeneration 条目：{ b64, savedPath, revisedPrompt }
  // meta.codexImagesDir：该账号 CODEX_HOME/generated_images，收进图库后删掉 Codex 那份副本。
  async save(image, meta) {
    let buf = image.b64 ? Buffer.from(image.b64, 'base64') : null;
    if (!buf?.length && image.savedPath) buf = await fs.promises.readFile(image.savedPath).catch(() => null);
    if (!buf?.length) return null;
    if (image.savedPath && meta.codexImagesDir && isInside(image.savedPath, meta.codexImagesDir)) {
      fs.rm(image.savedPath, { force: true }, () => {});
    }

    const ext = sniffExt(buf);
    const id = crypto.randomBytes(16).toString('hex');
    const file = `${id}.${ext}`;
    await fs.promises.writeFile(path.join(this.dir, file), buf);
    const record = {
      id,
      file,
      mime: MIME[ext],
      bytes: buf.length,
      prompt: meta.prompt || null,
      revisedPrompt: image.revisedPrompt || null,
      source: meta.source,
      accountId: meta.accountId,
      createdAt: new Date().toISOString(),
    };
    for (const old of this.store.addImage(record)) this.#unlink(old.file);
    return { record, buf };
  }

  remove(id) {
    const record = this.store.removeImage(id);
    if (record) this.#unlink(record.file);
    return record;
  }

  removeAll() {
    const removed = this.store.clearImages();
    for (const record of removed) this.#unlink(record.file);
    return removed.length;
  }

  resolveFile(file) {
    if (!FILE_PATTERN.test(file)) return null;
    const full = path.join(this.dir, file);
    return fs.existsSync(full) ? { full, mime: MIME[file.split('.').pop()] } : null;
  }

  #unlink(file) {
    if (FILE_PATTERN.test(file)) fs.rm(path.join(this.dir, file), { force: true }, () => {});
  }
}

export function publicImageUrl(req, record) {
  return `http://${req.headers.host}/images/${record.file}`;
}

function isInside(file, dir) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function sniffExt(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return 'png';
}
