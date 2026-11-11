import {
  ConfigError,
  DEFAULT_USER_AGENT,
  isSupportedHostname,
  normalizeHostname,
  parseUpstreamRoute,
  resolveAllowedHosts,
  resolveHostConfig,
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
    return jsonResponse(request, 200, {
      name: PROJECT_NAME,
      version: PROJECT_VERSION,
      description: PROJECT_DESCRIPTION,
      author: AUTHOR,
      repository: REPOSITORY,
      usage: PATH_FORMAT,
      example:
        '/maven.pkg.github.com/alibaba/spring-cloud-alibaba/com/alibaba/cloud/'
        + 'spring-cloud-alibaba-dependencies/2026.0.0.0-SNAPSHOT/maven-metadata.xml',
      allowedHosts: runtime.allowedHosts,
      hosts: runtime.hosts,
      endpoints: [
        'GET /<upstream-host>/<upstream-path>/<maven-path>',
        'HEAD /<upstream-host>/<upstream-path>/<maven-path>',
        'GET /-/health',
      ],
    });
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
        return {
          host,
          usernameEnv: `${config.envPrefix}_USERNAME`,
          passwordEnv: `${config.envPrefix}_PASSWORD`,
          authentication: config.authEnabled ? 'basic' : 'anonymous',
        };
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

  return runtime;
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
