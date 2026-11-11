export const DEFAULT_SNAPSHOT_URL =
  'https://maven.pkg.github.com/alibaba/spring-cloud-alibaba';

export const DEFAULT_USER_AGENT = 'esa-maven-proxy/1.0';

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

/**
 * 读取并校验 Worker 配置。
 *
 * 只支持两个来源：ESA 函数变量（明文）和加密 Secret。
 * 不在任何地方持久化，也不接受请求参数覆盖。
 */
export function resolveConfig(env = {}) {
  const snapshotUrl = readEnv(env, 'MAVEN_SNAPSHOT_URL').trim() || DEFAULT_SNAPSHOT_URL;
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
