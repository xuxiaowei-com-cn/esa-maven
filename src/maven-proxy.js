import { ConfigError, DEFAULT_USER_AGENT, resolveConfig } from './config.js';
import { base64EncodeUtf8 } from './base64.js';

const HEALTH_PATH = '/-/health';

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
 * 不读写 KV、不调用 Cache API、不保存任何响应内容：
 * 每个请求都直接转发到 MAVEN_SNAPSHOT_URL，并可选地注入 Basic 认证。
 */
export async function handleRequest(request, env = {}) {
  let config;
  try {
    config = resolveConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      return textResponse(500, error.message);
    }
    throw error;
  }

  const url = new URL(request.url);

  if (url.pathname === HEALTH_PATH) {
    if (!isReadMethod(request.method)) {
      return methodNotAllowed();
    }
    return jsonResponse(request, 200, {
      status: 'ok',
      upstream: config.upstream,
      authentication: config.authEnabled ? 'basic' : 'anonymous',
    });
  }

  if (url.pathname === '/' || url.pathname === '') {
    if (!isReadMethod(request.method)) {
      return methodNotAllowed();
    }
    return jsonResponse(request, 200, {
      name: 'esa-maven',
      description: '阿里云 ESA Workers Maven 快照仓库代理（只代理，不存储）',
      upstream: config.upstream,
      authentication: config.authEnabled ? 'basic' : 'anonymous',
      endpoints: ['GET /<maven-path>', 'HEAD /<maven-path>', 'GET /-/health'],
    });
  }

  if (!isReadMethod(request.method)) {
    return methodNotAllowed();
  }

  const target = buildUpstreamUrl(config.upstream, url);
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

export function buildUpstreamUrl(upstream, url) {
  const path = url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`;
  return `${upstream}${path}${url.search}`;
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
    // 便于排查是上游 GitHub Packages 认证/权限问题，而不是客户端未带密码。
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
