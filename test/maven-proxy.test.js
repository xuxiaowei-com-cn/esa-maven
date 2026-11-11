import assert from 'node:assert/strict';
import test from 'node:test';

import packageJson from '../package.json' with { type: 'json' };
import { base64EncodeUtf8 } from '../src/base64.js';
import { handleRequest } from '../src/maven-proxy.js';

const ARTIFACT_PATH =
  '/com/alibaba/cloud/spring-cloud-alibaba-dependencies/2026.0.0.0-SNAPSHOT/maven-metadata.xml';
const MULTI_PREFIX = '/maven.pkg.github.com/alibaba/spring-cloud-alibaba';
const MULTI_ARTIFACT_PATH = `${MULTI_PREFIX}${ARTIFACT_PATH}`;
const MULTI_UPSTREAM =
  'https://maven.pkg.github.com/alibaba/spring-cloud-alibaba';
const HOST_CREDENTIALS = {
  MAVEN_PKG_GITHUB_COM_USERNAME: 'github-user',
  MAVEN_PKG_GITHUB_COM_PASSWORD: 'test-token',
};

function mockFetch(responseFactory) {
  const calls = [];
  const original = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return responseFactory(input, init);
  };

  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function upstreamOk(body = 'artifact') {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/xml',
      etag: '"abc"',
    },
  });
}

test('路径模式按上游主机转发并注入 host 级凭据', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    const response = await handleRequest(
      new Request(`https://maven.example.com${MULTI_ARTIFACT_PATH}?download=1`),
      HOST_CREDENTIALS,
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'artifact');
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(
      fetchMock.calls[0].input,
      `${MULTI_UPSTREAM}${ARTIFACT_PATH}?download=1`,
    );
    assert.equal(fetchMock.calls[0].init.method, 'GET');
    assert.equal(
      fetchMock.calls[0].init.headers.get('authorization'),
      `Basic ${base64EncodeUtf8('github-user:test-token')}`,
    );
    assert.equal(
      fetchMock.calls[0].init.headers.get('user-agent'),
      'esa-maven-proxy/1.0',
    );
  } finally {
    fetchMock.restore();
  }
});

test('未配置凭据时匿名转发', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    const response = await handleRequest(
      new Request(`https://maven.example.com${MULTI_ARTIFACT_PATH}`),
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(fetchMock.calls[0].init.headers.has('authorization'), false);
  } finally {
    fetchMock.restore();
  }
});

test('不转发客户端自带的 Authorization', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    const request = new Request(`https://maven.example.com${MULTI_ARTIFACT_PATH}`, {
      headers: {
        authorization: 'Basic Y2xpZW50OnNlY3JldA==',
      },
    });
    await handleRequest(request, HOST_CREDENTIALS);

    assert.notEqual(
      fetchMock.calls[0].init.headers.get('authorization'),
      'Basic Y2xpZW50OnNlY3JldA==',
    );
  } finally {
    fetchMock.restore();
  }
});

test('host 级凭据必须成对设置', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    const passwordOnly = await handleRequest(
      new Request(`https://maven.example.com${MULTI_ARTIFACT_PATH}`),
      { MAVEN_PKG_GITHUB_COM_PASSWORD: 'test-token' },
    );
    assert.equal(passwordOnly.status, 500);
    assert.match(await passwordOnly.text(), /MAVEN_PKG_GITHUB_COM_USERNAME/);

    const usernameOnly = await handleRequest(
      new Request(`https://maven.example.com${MULTI_ARTIFACT_PATH}`),
      { MAVEN_PKG_GITHUB_COM_USERNAME: 'github-user' },
    );
    assert.equal(usernameOnly.status, 500);
    assert.match(await usernameOnly.text(), /MAVEN_PKG_GITHUB_COM_PASSWORD/);

    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

test('路径第一段不是合法上游域名时返回 400', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    for (const path of [
      '/com/alibaba/cloud/foo/1.0/foo-1.0.pom',
      '/127.0.0.1/foo',
      '/maven.pkg.github.com:443/foo',
      '/bad_host.example.com/foo',
      '//evil.example.com/foo',
    ]) {
      const response = await handleRequest(
        new Request(`https://maven.example.com${path}`),
        {},
      );
      assert.equal(response.status, 400, path);
      assert.match(await response.text(), /路径格式/);
    }

    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

test('未列入 MAVEN_ALLOWED_HOSTS 的主机返回 403', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    const response = await handleRequest(
      new Request(
        'https://maven.example.com/repo1.maven.org/maven2/com/example/foo/1.0/foo-1.0.pom',
      ),
      {},
    );

    assert.equal(response.status, 403);
    assert.match(await response.text(), /MAVEN_ALLOWED_HOSTS/);
    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

test('MAVEN_ALLOWED_HOSTS 可以追加多个主机', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    const response = await handleRequest(
      new Request(
        'https://maven.example.com/repo1.maven.org/maven2/com/example/foo/1.0/foo-1.0.pom',
      ),
      {
        MAVEN_ALLOWED_HOSTS:
          'maven.pkg.github.com, repo1.maven.org, maven.aliyun.com',
      },
    );

    assert.equal(response.status, 200);
    assert.equal(
      fetchMock.calls[0].input,
      'https://repo1.maven.org/maven2/com/example/foo/1.0/foo-1.0.pom',
    );
  } finally {
    fetchMock.restore();
  }
});

test('MAVEN_ALLOWED_HOSTS=* 允许任意合法域名', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    await handleRequest(
      new Request(
        'https://maven.example.com/repo1.maven.org/maven2/com/example/foo/1.0/foo-1.0.pom',
      ),
      { MAVEN_ALLOWED_HOSTS: '*' },
    );

    assert.equal(
      fetchMock.calls[0].input,
      'https://repo1.maven.org/maven2/com/example/foo/1.0/foo-1.0.pom',
    );
  } finally {
    fetchMock.restore();
  }
});

test('非法的 MAVEN_ALLOWED_HOSTS 返回 500', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    const response = await handleRequest(
      new Request(`https://maven.example.com${MULTI_ARTIFACT_PATH}`),
      { MAVEN_ALLOWED_HOSTS: 'not a host' },
    );

    assert.equal(response.status, 500);
    assert.match(await response.text(), /MAVEN_ALLOWED_HOSTS/);
    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

test('主机名中的点和连字符会转换为环境变量下划线', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    await handleRequest(
      new Request(
        'https://maven.example.com/my-repo.example.com/repo/com/example/foo/1.0/foo-1.0.pom',
      ),
      {
        MAVEN_ALLOWED_HOSTS: 'my-repo.example.com',
        MY_REPO_EXAMPLE_COM_USERNAME: 'user',
        MY_REPO_EXAMPLE_COM_PASSWORD: 'password',
      },
    );

    assert.equal(
      fetchMock.calls[0].input,
      'https://my-repo.example.com/repo/com/example/foo/1.0/foo-1.0.pom',
    );
    assert.equal(
      fetchMock.calls[0].init.headers.get('authorization'),
      `Basic ${base64EncodeUtf8('user:password')}`,
    );
  } finally {
    fetchMock.restore();
  }
});

test('上游主机大小写不敏感', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    await handleRequest(
      new Request(
        `https://maven.example.com/MAVEN.PKG.GITHUB.COM/alibaba/spring-cloud-alibaba${ARTIFACT_PATH}`,
      ),
      HOST_CREDENTIALS,
    );

    assert.equal(
      fetchMock.calls[0].input,
      `${MULTI_UPSTREAM}${ARTIFACT_PATH}`,
    );
  } finally {
    fetchMock.restore();
  }
});

test('host 级凭据不会发送到其他主机', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    await handleRequest(
      new Request(
        'https://maven.example.com/repo1.maven.org/maven2/com/example/foo/1.0/foo-1.0.pom',
      ),
      {
        MAVEN_ALLOWED_HOSTS: 'maven.pkg.github.com,repo1.maven.org',
        ...HOST_CREDENTIALS,
      },
    );

    assert.equal(fetchMock.calls[0].init.headers.has('authorization'), false);
  } finally {
    fetchMock.restore();
  }
});

test('仅允许 GET/HEAD', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    const response = await handleRequest(
      new Request(`https://maven.example.com${MULTI_ARTIFACT_PATH}`, {
        method: 'POST',
      }),
      {},
    );

    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

test('HEAD 请求透传但不返回响应体', async () => {
  const fetchMock = mockFetch(
    () =>
      new Response(null, {
        status: 200,
        headers: { 'content-type': 'application/java-archive' },
      }),
  );
  try {
    const response = await handleRequest(
      new Request(
        'https://maven.example.com/maven.pkg.github.com/repo/com/example/foo.jar',
        { method: 'HEAD' },
      ),
      {},
    );

    assert.equal(fetchMock.calls[0].init.method, 'HEAD');
    assert.equal(response.status, 200);
    assert.equal(response.body, null);
    assert.equal(
      response.headers.get('content-type'),
      'application/java-archive',
    );
  } finally {
    fetchMock.restore();
  }
});

test('不向客户端透传 content-length、content-encoding 和 Cookie', async () => {
  const fetchMock = mockFetch(
    () =>
      new Response('hello', {
        status: 200,
        headers: {
          'content-type': 'text/xml',
          'content-length': '999',
          'content-encoding': 'gzip',
          etag: '"abc"',
          'set-cookie': 'session=1',
          'www-authenticate': 'Basic realm="GitHub"',
        },
      }),
  );
  try {
    const response = await handleRequest(
      new Request(`https://maven.example.com${MULTI_ARTIFACT_PATH}`),
      {},
    );

    assert.equal(response.headers.get('content-type'), 'text/xml');
    assert.equal(response.headers.get('etag'), '"abc"');
    assert.equal(response.headers.get('content-length'), null);
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('www-authenticate'), null);
  } finally {
    fetchMock.restore();
  }
});

test('上游 401 透传状态并标记上游状态码', async () => {
  const fetchMock = mockFetch(
    () =>
      new Response('Bad credentials', {
        status: 401,
        headers: {
          'www-authenticate': 'Basic realm="GitHub"',
          'content-type': 'text/plain',
        },
      }),
  );
  try {
    const response = await handleRequest(
      new Request(`https://maven.example.com${MULTI_ARTIFACT_PATH}`),
      HOST_CREDENTIALS,
    );

    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), null);
    assert.equal(response.headers.get('x-esa-maven-upstream-status'), '401');
  } finally {
    fetchMock.restore();
  }
});

test('上游不可达时返回 502', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('upstream boom');
  };
  try {
    const response = await handleRequest(
      new Request(`https://maven.example.com${MULTI_ARTIFACT_PATH}`),
      {},
    );

    assert.equal(response.status, 502);
    assert.match(await response.text(), /upstream boom/);
  } finally {
    globalThis.fetch = original;
  }
});

test('健康检查报告多上游配置且不泄露密码', async () => {
  const response = await handleRequest(
    new Request('https://maven.example.com/-/health'),
    {
      MAVEN_ALLOWED_HOSTS: 'maven.pkg.github.com',
      ...HOST_CREDENTIALS,
    },
  );
  const text = await response.text();
  const body = JSON.parse(text);

  assert.equal(response.status, 200);
  assert.deepEqual(body.author, packageJson.author);
  assert.deepEqual(body.repository, packageJson.repository);
  assert.match(text, /"allowedHosts": \[/);
  assert.equal(body.hosts[0].usernameEnv, 'MAVEN_PKG_GITHUB_COM_USERNAME');
  assert.equal(body.hosts[0].passwordEnv, 'MAVEN_PKG_GITHUB_COM_PASSWORD');
  assert.doesNotMatch(text, /"envPrefix"/);
  assert.match(text, /"authentication": "basic"/);
  assert.doesNotMatch(text, /test-token/);
  assert.doesNotMatch(text, /"legacy"/);
});

test('根路径返回多上游用法', async () => {
  const response = await handleRequest(
    new Request('https://maven.example.com/'),
    {},
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.name, packageJson.name);
  assert.equal(body.version, packageJson.version);
  assert.equal(body.description, packageJson.description);
  assert.deepEqual(body.author, packageJson.author);
  assert.deepEqual(body.repository, packageJson.repository);
  assert.equal(body.usage, '/<upstream-host>/<upstream-path>/<maven-path>');
  assert.match(body.example, /maven\.pkg\.github\.com/);
  assert.deepEqual(body.allowedHosts, ['maven.pkg.github.com']);
  assert.equal(body.legacy, undefined);
});

test('GET /favicon.ico 返回图标', async () => {
  const response = await handleRequest(
    new Request('https://maven.example.com/favicon.ico'),
    {},
  );
  const bytes = new Uint8Array(await response.arrayBuffer());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/x-icon');
  assert.ok(bytes.length > 100);
  assert.deepEqual([...bytes.slice(0, 4)], [0, 0, 1, 0]);
});

test('HEAD /favicon.ico 返回响应头但没有响应体', async () => {
  const response = await handleRequest(
    new Request('https://maven.example.com/favicon.ico', { method: 'HEAD' }),
    {},
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/x-icon');
  assert.equal(response.body, null);
});

test('路径中的 .. 不能绕过主机白名单', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    const response = await handleRequest(
      new Request(
        'https://maven.example.com/maven.pkg.github.com/../../evil.example.com/foo',
      ),
      {},
    );

    assert.equal(response.status, 403);
    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

test('Basic 认证支持 UTF-8 凭据', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    await handleRequest(
      new Request(`https://maven.example.com${MULTI_ARTIFACT_PATH}`),
      {
        MAVEN_PKG_GITHUB_COM_USERNAME: '用户',
        MAVEN_PKG_GITHUB_COM_PASSWORD: '密码',
      },
    );

    assert.equal(
      fetchMock.calls[0].init.headers.get('authorization'),
      `Basic ${base64EncodeUtf8('用户:密码')}`,
    );
  } finally {
    fetchMock.restore();
  }
});
