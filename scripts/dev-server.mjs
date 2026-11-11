// 本地调试用的最小 HTTP 适配器。
// 它把 Node 的 IncomingMessage 转成 Web Request，再交给与 ESA 线上相同的
// handleRequest 处理，方便用真实 GitHub Token 验证代理逻辑。
//
// 用法：
//   MAVEN_REPO_USERNAME=xxx MAVEN_REPO_PASSWORD=<github-token> npm run dev:local
//
// 注意：ESA CLI 的 `esa-cli dev` 不会注入控制台上的函数变量，因此本地
// 调试凭据时请使用这个脚本，或直接在 ESA 控制台的调试环境中测试。

import { createServer } from 'node:http';
import { Readable } from 'node:stream';

import { handleRequest } from '../src/maven-proxy.js';

const port = Number(process.env.PORT || 8787);

// 这些头由 Node/undici 或运行时管理，不能从入站请求原样带过去。
const SKIP_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'expect',
  'host',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host || `127.0.0.1:${port}`;
    const requestUrl = new URL(req.url || '/', `http://${host}`);
    const headers = new Headers();

    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || SKIP_REQUEST_HEADERS.has(name.toLowerCase())) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          headers.append(name, item);
        }
      } else {
        headers.set(name, value);
      }
    }

    const request = new Request(requestUrl, {
      method: req.method || 'GET',
      headers,
    });
    const response = await handleRequest(request, process.env);

    res.statusCode = response.status;
    if (response.statusText) {
      res.statusMessage = response.statusText;
    }
    response.headers.forEach((value, name) => {
      res.setHeader(name, value);
    });

    if (response.body) {
      Readable.fromWeb(response.body).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(`本地代理异常：${error instanceof Error ? error.message : String(error)}\n`);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`esa-maven 本地代理已启动：http://127.0.0.1:${port}`);
  console.log(
    `上游：${process.env.MAVEN_SNAPSHOT_URL || 'https://maven.pkg.github.com/alibaba/spring-cloud-alibaba'}`,
  );
  console.log(`认证：${process.env.MAVEN_REPO_PASSWORD ? '已配置' : '未配置（匿名）'}`);
});
