// 最小 multipart/form-data 解析，给 /v1/images/edits 用（OpenAI SDK 以表单上传图片）。

export function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) return null;
  const boundary = Buffer.from(`--${(match[1] || match[2]).trim()}`);
  const fields = {};
  const files = [];

  let pos = buffer.indexOf(boundary);
  while (pos !== -1) {
    pos += boundary.length;
    if (buffer.subarray(pos, pos + 2).toString() === '--') break;
    pos += 2;
    const headerEnd = buffer.indexOf('\r\n\r\n', pos);
    if (headerEnd === -1) break;
    const headers = buffer.subarray(pos, headerEnd).toString('utf8');
    const next = buffer.indexOf(boundary, headerEnd + 4);
    if (next === -1) break;
    const data = buffer.subarray(headerEnd + 4, next - 2);

    const name = /name="([^"]*)"/i.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
    const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim();
    if (filename !== undefined) files.push({ name, filename, contentType: type, data });
    else if (name) fields[name] = data.toString('utf8');
    pos = next;
  }
  return { fields, files };
}
