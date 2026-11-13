import {
  ConfigError,
  DEFAULT_USER_AGENT,
  isSupportedHostname,
  matchesPathFilters,
  normalizeHostname,
  parseUpstreamRoute,
  resolveAllowedHosts,
  resolveCaptchaConfig,
  resolveHostConfig,
  resolvePathFilters,
} from './config.js';
import packageJson from '../package.json' with { type: 'json' };
import { base64EncodeUtf8 } from './base64.js';

const HEALTH_PATH = '/-/health';
const PATH_FORMAT = '/<upstream-host>/<upstream-path>/<maven-path>';
const PROJECT_NAME = packageJson.name ?? '';
const PROJECT_VERSION = packageJson.version ?? '';
const PROJECT_DESCRIPTION = packageJson.description ?? '';
const AUTHOR = packageJson.author ?? '';
const REPOSITORY = packageJson.repository ?? '';

// 只转发 Maven 解析/下载需要的请求头，避免把客户端凭据带到上游。
const FORWARD_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'cache-control',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
  'pragma',
  'range',
  'user-agent',
];

// 只回传对 Maven 有用的响应头。
// 注意：Fetch 会自动解压 gzip，因此 content-length / content-encoding 不能透传。
const FORWARD_RESPONSE_HEADERS = [
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-language',
  'content-range',
  'content-type',
  'etag',
  'expires',
  'last-modified',
  'link',
  'vary',
];

/**
 * ESA Worker 入口的实际处理函数。
 *
 * 路径格式：
 *   /maven.pkg.github.com/alibaba/spring-cloud-alibaba/com/...
 *   -> https://maven.pkg.github.com/alibaba/spring-cloud-alibaba/com/...
 *
 * 不读写 KV、不调用 Cache API、不保存任何响应内容。
 */
export async function handleRequest(request, env = {}) {
  const url = new URL(request.url);

  if (url.pathname === HEALTH_PATH) {
    if (!isReadMethod(request.method)) {
      return methodNotAllowed();
    }
    return jsonResponse(request, 200, describeRuntime(env));
  }

  if (url.pathname === '/' || url.pathname === '') {
    if (!isReadMethod(request.method)) {
      return methodNotAllowed();
    }
    const runtime = describeRuntime(env);
    return htmlResponse(
      request,
      renderHomePage(url, runtime, resolveCaptchaConfig(env)),
    );
  }

  if (!isReadMethod(request.method)) {
    return methodNotAllowed();
  }

  const route = parseUpstreamRoute(url.pathname);
  if (!route) {
    return textResponse(400, `路径格式错误，应为 ${PATH_FORMAT}`);
  }

  return handleUpstream(request, url, route, env);
}

function handleUpstream(request, url, route, env) {
  const host = normalizeHostname(route.host);

  if (!isSupportedHostname(host)) {
    return textResponse(
      400,
      `无法识别的上游主机：${route.segment}。路径格式：${PATH_FORMAT}`,
    );
  }

  let allowedHosts;
  try {
    allowedHosts = resolveAllowedHosts(env);
  } catch (error) {
    return configErrorResponse(error);
  }

  if (!allowedHosts.includes('*') && !allowedHosts.includes(host)) {
    return textResponse(
      403,
      `上游主机 ${host} 不在 MAVEN_ALLOWED_HOSTS 中`,
    );
  }

  let filters;
  try {
    filters = resolvePathFilters(host, env);
  } catch (error) {
    return configErrorResponse(error);
  }

  const rawFilterPath = `/${route.rest}`;
  let filterPath;
  try {
    filterPath = decodeURIComponent(rawFilterPath);
  } catch {
    return textResponse(400, '路径包含非法的 URL 编码');
  }

  if (!matchesPathFilters(filterPath, filters)) {
    return textResponse(
      403,
      `路径 ${filterPath} 不匹配 ${host} 的过滤规则`,
    );
  }

  let config;
  try {
    config = resolveHostConfig(host, env);
  } catch (error) {
    return configErrorResponse(error);
  }

  const target = buildPathUpstreamUrl(host, route.rest, url.search);
  return proxyRequest(request, target, config);
}

async function proxyRequest(request, target, config) {
  const headers = buildUpstreamHeaders(request, config);

  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      redirect: 'follow',
      // 让运行时解压 gzip 后再返回给客户端，Maven 客户端无需关心编码。
      decompress: 'decompress',
    });
  } catch (error) {
    return textResponse(502, `请求上游 Maven 仓库失败：${errorMessage(error)}`);
  }

  return toClientResponse(upstream, request.method);
}

function configErrorResponse(error) {
  if (error instanceof ConfigError) {
    return textResponse(500, error.message);
  }
  throw error;
}

export function buildPathUpstreamUrl(host, rest, search = '') {
  return `https://${host}/${rest}${search}`;
}

export function buildUpstreamHeaders(request, config) {
  const headers = new Headers();

  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }

  if (!headers.has('user-agent')) {
    headers.set('user-agent', DEFAULT_USER_AGENT);
  }

  // 始终使用边缘侧配置的凭据，客户端自带的 Authorization 不会被转发。
  if (config.authEnabled) {
    headers.set(
      'authorization',
      `Basic ${base64EncodeUtf8(`${config.username}:${config.password}`)}`,
    );
  }

  return headers;
}

export function toClientResponse(upstream, method) {
  const headers = new Headers();

  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }

  if (upstream.status === 401 || upstream.status === 403) {
    // 便于排查是上游认证/权限问题，而不是客户端未带密码。
    headers.set('x-esa-maven-upstream-status', String(upstream.status));
  }

  const noBody =
    method === 'HEAD' || upstream.status === 204 || upstream.status === 304;

  return new Response(noBody ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function describeRuntime(env) {
  const runtime = {
    status: 'ok',
    multiUpstream: true,
    author: AUTHOR,
    repository: REPOSITORY,
    allowedHosts: [],
    hosts: [],
  };

  try {
    runtime.allowedHosts = resolveAllowedHosts(env);
  } catch (error) {
    runtime.status = 'degraded';
    runtime.error = errorMessage(error);
  }

  runtime.hosts = runtime.allowedHosts
    .filter((host) => host !== '*')
    .map((host) => {
      try {
        const config = resolveHostConfig(host, env);
        const filters = resolvePathFilters(host, env);
        const entry = {
          host,
          usernameEnv: `${config.envPrefix}_USERNAME`,
          passwordEnv: `${config.envPrefix}_PASSWORD`,
          authentication: config.authEnabled ? 'basic' : 'anonymous',
        };

        const pathFilters = {};
        if (filters.contains.length > 0) {
          pathFilters.contains = filters.contains;
        }
        if (filters.regexSource) {
          pathFilters.regex = filters.regexSource;
        }
        if (filters.excludeRegexSource) {
          pathFilters.excludeRegex = filters.excludeRegexSource;
        }
        if (Object.keys(pathFilters).length > 0) {
          entry.pathFilters = pathFilters;
        }

        return entry;
      } catch (error) {
        return {
          host,
          authentication: 'misconfigured',
          error: errorMessage(error),
        };
      }
    });

  if (runtime.allowedHosts.includes('*')) {
    runtime.note = 'MAVEN_ALLOWED_HOSTS=* 允许任意合法域名，请谨慎使用';
  }

  const captcha = resolveCaptchaConfig(env);
  runtime.captcha = {
    enabled: captcha.enabled,
    sceneIdConfigured: Boolean(captcha.sceneId),
    prefixConfigured: Boolean(captcha.prefix),
    region: captcha.region,
  };

  return runtime;
}

function htmlResponse(request, html) {
  return new Response(request.method === 'HEAD' ? null : html, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  });
}

function renderHomePage(url, runtime, captcha) {
  const origin = url.origin;
  const author = authorInfo(AUTHOR);
  const repoHref = repositoryHref(REPOSITORY);
  const allowedHosts = runtime.allowedHosts.length
    ? runtime.allowedHosts
        .map((host) => `<code>${escapeHtml(host)}</code>`)
        .join(' ')
    : '<span class="muted">未配置</span>';
  const exampleBase =
    `${origin}/maven.pkg.github.com/alibaba/spring-cloud-alibaba`;
  const exampleMetadata =
    `${exampleBase}/com/alibaba/cloud/spring-cloud-alibaba-dependencies`
    + '/2026.0.0.0-SNAPSHOT/maven-metadata.xml';
  const captchaHead = captcha.enabled ? renderCaptchaHead(captcha) : '';
  const captchaBody = captcha.enabled ? renderCaptchaBody(captcha) : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(PROJECT_NAME)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f6f7fb;
      --card: #ffffff;
      --text: #1f2937;
      --muted: #6b7280;
      --line: #e5e7eb;
      --brand: #2563eb;
      --brand-soft: #eff6ff;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0b1220;
        --card: #111a2e;
        --text: #e5e7eb;
        --muted: #9ca3af;
        --line: #243047;
        --brand: #60a5fa;
        --brand-soft: #12213d;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
        "PingFang SC", "Microsoft YaHei", sans-serif;
      line-height: 1.6;
    }
    .wrap { width: min(920px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 64px; }
    .hero {
      padding: 32px;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: linear-gradient(135deg, var(--brand-soft), var(--card));
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      font-size: clamp(28px, 4vw, 42px);
      font-weight: 800;
      letter-spacing: -0.03em;
    }
    .version {
      font-size: 13px;
      font-weight: 600;
      color: var(--brand);
      background: var(--card);
      border: 1px solid var(--line);
      padding: 4px 10px;
      border-radius: 999px;
    }
    .desc { margin: 12px 0 0; color: var(--muted); font-size: 16px; }
    .grid { display: grid; gap: 16px; margin-top: 20px; }
    .card {
      padding: 22px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--card);
    }
    h2 { margin: 0 0 12px; font-size: 18px; }
    p { margin: 8px 0; }
    .muted { color: var(--muted); }
    code, .code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
    }
    .code {
      display: block;
      overflow-x: auto;
      padding: 12px 14px;
      border-radius: 10px;
      background: var(--brand-soft);
      border: 1px solid var(--line);
      color: var(--text);
      white-space: nowrap;
    }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .chips code {
      padding: 4px 8px;
      border-radius: 8px;
      background: var(--brand-soft);
      border: 1px solid var(--line);
    }
    a { color: var(--brand); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .button {
      appearance: none;
      border: 0;
      border-radius: 10px;
      background: var(--brand);
      color: #fff;
      padding: 10px 18px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .button:hover { filter: brightness(1.08); }
    .status { min-height: 1.6em; color: var(--muted); }
    footer { margin-top: 24px; color: var(--muted); font-size: 13px; }
    footer p { margin: 4px 0; }
    @media (max-width: 600px) {
      .wrap { padding-top: 24px; }
      .hero, .card { padding: 18px; }
    }
  </style>
  ${captchaHead}
</head>
<body>
  <main class="wrap">
    <header class="hero">
      <div class="brand">
        ${escapeHtml(PROJECT_NAME)}
        <span class="version">v${escapeHtml(PROJECT_VERSION)}</span>
      </div>
      <p class="desc">${escapeHtml(PROJECT_DESCRIPTION)}</p>
    </header>

    <div class="grid">
      <section class="card">
        <h2>Maven 仓库地址</h2>
        <p class="muted">把仓库 URL 设为：</p>
        <code class="code">${escapeHtml(origin)}/&lt;upstream-host&gt;/&lt;upstream-path&gt;</code>
        <p class="muted">GitHub Packages 示例：</p>
        <code class="code">${escapeHtml(exampleBase)}</code>
        <p class="muted">验证快照元数据：</p>
        <code class="code">${escapeHtml(exampleMetadata)}</code>
      </section>

      <section class="card">
        <h2>允许的上游</h2>
        <div class="chips">${allowedHosts}</div>
        <p class="muted">
          认证状态、路径过滤等运行配置见
          <a href="/-/health"><code>/-/health</code></a>。
        </p>
      </section>

      ${captchaBody}
    </div>

    <footer>
      <p>作者：${author.html}</p>
      <p>源码：${repoHref ? `<a href="${escapeHtml(repoHref)}">${escapeHtml(repoHref)}</a>` : '未配置'}</p>
      <p>Powered by Alibaba Cloud ESA Workers</p>
    </footer>
  </main>
</body>
</html>`;
}

function renderCaptchaHead(captcha) {
  return `<script>
      window.AliyunCaptchaConfig = {
        region: ${jsLiteral(captcha.region)},
        prefix: ${jsLiteral(captcha.prefix)}
      };
    </script>
    <script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"></script>`;
}

function renderCaptchaBody(captcha) {
  return `<section class="card">
        <h2>人机验证</h2>
        <p class="muted">本站已接入 ESA AI 验证码。</p>
        <div id="captcha-element"></div>
        <button id="captcha-button" class="button" type="button">开始验证</button>
        <p id="captcha-status" class="status" role="status"></p>
      </section>
      <script>
        (function () {
          var status = document.getElementById('captcha-status');
          if (typeof window.initAliyunCaptcha !== 'function') {
            status.textContent = '验证码脚本加载失败';
            return;
          }
          window.initAliyunCaptcha({
            SceneId: ${jsLiteral(captcha.sceneId)},
            mode: 'popup',
            element: '#captcha-element',
            button: '#captcha-button',
            success: function () {
              status.textContent = '验证通过';
            },
            fail: function (result) {
              status.textContent = '验证失败，请重试';
              console.error(result);
            },
            getInstance: function (instance) {
              window.__esaCaptcha = instance;
            },
            server: ['captcha-esa-open.aliyuncs.com', 'captcha-esa-open-b.aliyuncs.com'],
            slideStyle: { width: 360, height: 40 }
          });
        })();
      </script>`;
}

function authorInfo(author) {
  if (typeof author === 'string') {
    return { html: escapeHtml(author) };
  }
  const name = author?.name ? escapeHtml(author.name) : '未配置';
  const email = author?.email ? escapeHtml(author.email) : '';
  const url = author?.url ? safeHttpUrl(author.url) : '';
  const nameHtml = url
    ? `<a href="${escapeHtml(url)}">${name}</a>`
    : name;
  return {
    html: email ? `${nameHtml} &lt;${email}&gt;` : nameHtml,
  };
}

function repositoryHref(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (!raw) {
    return '';
  }
  let value = String(raw).trim().replace(/^git\+/, '');
  if (value.startsWith('git@')) {
    const match = value.match(/^git@([^:]+):(.+)$/);
    if (match) {
      value = `https://${match[1]}/${match[2]}`;
    }
  }
  return safeHttpUrl(value.replace(/\.git$/, ''));
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : '';
  } catch {
    return '';
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsLiteral(value) {
  return JSON.stringify(String(value ?? ''))
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function isReadMethod(method) {
  return method === 'GET' || method === 'HEAD';
}

function methodNotAllowed() {
  return new Response('Method Not Allowed\n', {
    status: 405,
    headers: {
      allow: 'GET, HEAD',
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

function jsonResponse(request, status, data) {
  const body =
    request.method === 'HEAD' ? null : `${JSON.stringify(data, null, 2)}\n`;
  return new Response(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function textResponse(status, message) {
  return new Response(`${message}\n`, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
