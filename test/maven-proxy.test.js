import assert from 'node:assert/strict';
import test from 'node:test';

import { base64EncodeUtf8 } from '../src/base64.js';
import { handleRequest } from '../src/maven-proxy.js';

const DEFAULT_UPSTREAM =
  'https://maven.pkg.github.com/alibaba/spring-cloud-alibaba';
const ARTIFACT_PATH =
  '/com/alibaba/cloud/spring-cloud-alibaba-dependencies/2023.0.3.2-SNAPSHOT/spring-cloud-alibaba-dependencies-2023.0.3.2-SNAPSHOT.pom';

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

test('默认转发到 GitHub Packages 并注入 Basic 认证', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    const request = new Request(
      `https://maven.example.com${ARTIFACT_PATH}?download=1`,
    );
    const response = await handleRequest(request, {
      MAVEN_REPO_USERNAME: 'github-user',
      MAVEN_REPO_PASSWORD: 'test-token',
    });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'artifact');
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(
      fetchMock.calls[0].input,
      `${DEFAULT_UPSTREAM}${ARTIFACT_PATH}?download=1`,
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

test('MAVEN_SNAPSHOT_URL 可覆盖上游地址并去掉末尾斜杠', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    await handleRequest(new Request(`https://maven.example.com${ARTIFACT_PATH}`), {
      MAVEN_SNAPSHOT_URL: 'https://repo.example.com/maven-snapshots/',
    });

    assert.equal(
      fetchMock.calls[0].input,
      `https://repo.example.com/maven-snapshots${ARTIFACT_PATH}`,
    );
  } finally {
    fetchMock.restore();
  }
});

test('未配置密码时不发送 Authorization', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    await handleRequest(new Request(`https://maven.example.com${ARTIFACT_PATH}`), {});

    assert.equal(fetchMock.calls[0].init.headers.has('authorization'), false);
  } finally {
    fetchMock.restore();
  }
});

test('不转发客户端自带的 Authorization', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    const request = new Request(`https://maven.example.com${ARTIFACT_PATH}`, {
      headers: {
        authorization: 'Basic Y2xpZW50OnNlY3JldA==',
      },
    });
    await handleRequest(request, {
      MAVEN_REPO_USERNAME: 'github-user',
      MAVEN_REPO_PASSWORD: 'test-token',
    });

    assert.notEqual(
      fetchMock.calls[0].init.headers.get('authorization'),
      'Basic Y2xpZW50OnNlY3JldA==',
    );
  } finally {
    fetchMock.restore();
  }
});

test('只配置密码时返回 500，且不发起上游请求', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    const response = await handleRequest(
      new Request(`https://maven.example.com${ARTIFACT_PATH}`),
      { MAVEN_REPO_PASSWORD: 'ghp_token' },
    );

    assert.equal(response.status, 500);
    assert.match(await response.text(), /MAVEN_REPO_USERNAME/);
    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

test('只配置用户名时返回 500', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    const response = await handleRequest(
      new Request(`https://maven.example.com${ARTIFACT_PATH}`),
      { MAVEN_REPO_USERNAME: 'github-user' },
    );

    assert.equal(response.status, 500);
    assert.match(await response.text(), /MAVEN_REPO_PASSWORD/);
    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

test('非法 MAVEN_SNAPSHOT_URL 返回 500', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    const response = await handleRequest(
      new Request('https://maven.example.com/foo'),
      { MAVEN_SNAPSHOT_URL: 'not a url' },
    );

    assert.equal(response.status, 500);
    assert.match(await response.text(), /MAVEN_SNAPSHOT_URL/);
  } finally {
    fetchMock.restore();
  }
});

test('仅允许 GET/HEAD', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    const response = await handleRequest(
      new Request('https://maven.example.com/foo', { method: 'POST' }),
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
      new Request('https://maven.example.com/foo.jar', { method: 'HEAD' }),
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
      new Request('https://maven.example.com/foo'),
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
      new Request('https://maven.example.com/foo'),
      {
        MAVEN_REPO_USERNAME: 'github-user',
        MAVEN_REPO_PASSWORD: 'wrong-token',
      },
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
      new Request('https://maven.example.com/foo'),
      {},
    );

    assert.equal(response.status, 502);
    assert.match(await response.text(), /upstream boom/);
  } finally {
    globalThis.fetch = original;
  }
});

test('健康检查返回配置状态但不泄露密码', async () => {
  const response = await handleRequest(
    new Request('https://maven.example.com/-/health'),
    {
      MAVEN_REPO_USERNAME: 'github-user',
      MAVEN_REPO_PASSWORD: 'super-secret-token',
    },
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /"authentication": "basic"/);
  assert.doesNotMatch(body, /super-secret-token/);
});

test('根路径返回使用说明', async () => {
  const response = await handleRequest(
    new Request('https://maven.example.com/'),
    {},
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /"name": "esa-maven"/);
  assert.match(body, /GET \/<maven-path>/);
});

test('路径不会改变上游主机', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    await handleRequest(
      new Request('https://maven.example.com//evil.example.com/%2e%2e/foo'),
      {},
    );

    assert.equal(new URL(fetchMock.calls[0].input).host, 'maven.pkg.github.com');
  } finally {
    fetchMock.restore();
  }
});

test('Basic 认证支持 UTF-8 凭据', async () => {
  const fetchMock = mockFetch(() => upstreamOk());
  try {
    await handleRequest(new Request('https://maven.example.com/foo'), {
      MAVEN_REPO_USERNAME: '用户',
      MAVEN_REPO_PASSWORD: '密码',
    });

    assert.equal(
      fetchMock.calls[0].init.headers.get('authorization'),
      `Basic ${base64EncodeUtf8('用户:密码')}`,
    );
  } finally {
    fetchMock.restore();
  }
});
