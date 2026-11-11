export const DEFAULT_SNAPSHOT_URL =
  'https://maven.pkg.github.com/alibaba/spring-cloud-alibaba';

export const DEFAULT_ALLOWED_HOSTS = ['maven.pkg.github.com'];

export const DEFAULT_USER_AGENT = 'esa-maven-proxy/1.0';

const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readEnv(env, key) {
  const value = env?.[key];
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
}

export function normalizeHostname(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function isIPv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) {
    return false;
  }
  return parts.every(
    (part) => /^\d{1,3}$/.test(part) && Number(part) <= 255,
  );
}

/**
 * 只接受公网域名：拒绝 IP、端口、下划线、空标签和纯数字 TLD。
 * ESA Fetch API 本身也只支持域名，不支持 IP 地址。
 */
export function isSupportedHostname(host) {
  const normalized = normalizeHostname(host);
  if (!HOSTNAME_PATTERN.test(normalized)) {
    return false;
  }
  if (isIPv4(normalized)) {
    return false;
  }
  const tld = normalized.slice(normalized.lastIndexOf('.') + 1);
  if (/^\d+$/.test(tld)) {
    return false;
  }
  return true;
}

/**
 * maven.pkg.github.com -> MAVEN_PKG_GITHUB_COM
 * 连字符等非字母数字字符也统一转为下划线，保证可以用于函数变量键。
 */
export function hostEnvPrefix(host) {
  return normalizeHostname(host)
    .replace(/[^a-z0-9]/g, '_')
    .toUpperCase();
}

/**
 * 路径模式：
 *   /maven.pkg.github.com/alibaba/spring-cloud-alibaba/...
 *   -> host = maven.pkg.github.com
 *   -> rest = alibaba/spring-cloud-alibaba/...
 */
export function parseUpstreamRoute(pathname) {
  const raw = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  if (!raw) {
    return null;
  }
  const slashIndex = raw.indexOf('/');
  const segment = slashIndex === -1 ? raw : raw.slice(0, slashIndex);
  const rest = slashIndex === -1 ? '' : raw.slice(slashIndex + 1);
  return {
    segment,
    host: normalizeHostname(segment),
    rest,
  };
}

/**
 * 第一段是否“看起来像上游主机”。
 * Maven groupId 的第一段通常是 com、org、io，不含点，因此不会被误判。
 */
export function looksLikeUpstreamHost(segment) {
  return /[.:@]/.test(segment);
}

/**
 * 允许代理的上游主机列表。
 *
 * - 未设置 MAVEN_ALLOWED_HOSTS：只允许默认的 maven.pkg.github.com
 * - 逗号分隔多个主机
 * - 设置为 * 允许任意合法域名（会变成公开代理，谨慎使用）
 */
export function resolveAllowedHosts(env = {}) {
  const raw = readEnv(env, 'MAVEN_ALLOWED_HOSTS').trim();
  if (!raw) {
    return [...DEFAULT_ALLOWED_HOSTS];
  }

  const entries = raw
    .split(',')
    .map((item) => normalizeHostname(item))
    .filter(Boolean);

  if (entries.length === 0) {
    throw new ConfigError('MAVEN_ALLOWED_HOSTS 不能为空');
  }
  if (entries.includes('*')) {
    return ['*'];
  }

  const unique = [...new Set(entries)];
  for (const host of unique) {
    if (!isSupportedHostname(host)) {
      throw new ConfigError(
        `MAVEN_ALLOWED_HOSTS 包含不合法的主机名：${host}`,
      );
    }
  }
  return unique;
}

/**
 * 根据上游主机构造凭据变量名：
 *   maven.pkg.github.com
 *   -> MAVEN_PKG_GITHUB_COM_USERNAME
 *   -> MAVEN_PKG_GITHUB_COM_PASSWORD
 */
export function resolveHostConfig(host, env = {}) {
  const normalized = normalizeHostname(host);
  if (!isSupportedHostname(normalized)) {
    throw new ConfigError(`不支持的上游主机：${host}`);
  }

  const envPrefix = hostEnvPrefix(normalized);
  const username = readEnv(env, `${envPrefix}_USERNAME`).trim();
  const password = readEnv(env, `${envPrefix}_PASSWORD`);

  if (password && !username) {
    throw new ConfigError(
      `已设置 ${envPrefix}_PASSWORD，但缺少 ${envPrefix}_USERNAME`,
    );
  }
  if (username && !password) {
    throw new ConfigError(
      `已设置 ${envPrefix}_USERNAME，但缺少 ${envPrefix}_PASSWORD`,
    );
  }

  return {
    host: normalized,
    envPrefix,
    username,
    password,
    authEnabled: Boolean(username && password),
  };
}

/**
 * 兼容旧版的单仓库模式。
 *
 * 根路径下不以“主机名”开头的请求仍然使用 MAVEN_SNAPSHOT_URL +
 * MAVEN_REPO_USERNAME / MAVEN_REPO_PASSWORD。
 */
export function resolveConfig(env = {}) {
  const snapshotUrl =
    readEnv(env, 'MAVEN_SNAPSHOT_URL').trim() || DEFAULT_SNAPSHOT_URL;
  const username = readEnv(env, 'MAVEN_REPO_USERNAME').trim();
  const password = readEnv(env, 'MAVEN_REPO_PASSWORD');

  let parsed;
  try {
    parsed = new URL(snapshotUrl);
  } catch {
    throw new ConfigError(`MAVEN_SNAPSHOT_URL 不是合法的 URL：${snapshotUrl}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConfigError('MAVEN_SNAPSHOT_URL 只支持 http/https 协议');
  }

  if (parsed.username || parsed.password) {
    throw new ConfigError(
      '不要在 MAVEN_SNAPSHOT_URL 中写用户名或密码，请使用 MAVEN_REPO_USERNAME / MAVEN_REPO_PASSWORD',
    );
  }

  if (parsed.search || parsed.hash) {
    throw new ConfigError('MAVEN_SNAPSHOT_URL 不能包含查询参数或锚点');
  }

  let upstream = parsed.toString();
  if (upstream.endsWith('/')) {
    upstream = upstream.slice(0, -1);
  }

  if (password && !username) {
    throw new ConfigError('已设置 MAVEN_REPO_PASSWORD，但缺少 MAVEN_REPO_USERNAME');
  }
  if (username && !password) {
    throw new ConfigError('已设置 MAVEN_REPO_USERNAME，但缺少 MAVEN_REPO_PASSWORD');
  }

  return {
    upstream,
    username,
    password,
    authEnabled: Boolean(username && password),
  };
}
