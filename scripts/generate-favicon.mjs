// 将仓库根目录的 favicon.ico 转成可直接打包进 Worker 的 Base64 模块。
// 替换 favicon.ico 后运行：npm run favicon

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'favicon.ico');
const target = path.join(root, 'src', 'favicon.js');

const bytes = await readFile(source);
const base64 = bytes.toString('base64');
const chunks = base64.match(/.{1,120}/g) ?? [];
const lines = chunks
  .map((chunk, index) => {
    const suffix = index === chunks.length - 1 ? ';' : ' +';
    return `  '${chunk}'${suffix}`;
  })
  .join('\n');

const content = `// Generated from favicon.ico by scripts/generate-favicon.mjs.
// Run \`npm run favicon\` after replacing favicon.ico.
export const FAVICON_ICO_BASE64 =
${lines}
`;

await writeFile(target, content);
console.log(`Wrote ${path.relative(root, target)} (${bytes.length} bytes)`);
