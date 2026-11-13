# esa-maven

阿里云 ESA Workers（边缘函数）实现的 **多上游 Maven 仓库代理**。

- **路径即上游**：`/maven.pkg.github.com/alibaba/spring-cloud-alibaba/...` 直接代理到 `https://maven.pkg.github.com/alibaba/spring-cloud-alibaba/...`
- **多仓库**：同一个 Worker 可以代理 GitHub Packages、Maven Central、阿里云 Maven 等多个仓库。
- **按域名配置账号**：`maven.pkg.github.com` 对应 `MAVEN_PKG_GITHUB_COM_USERNAME` / `MAVEN_PKG_GITHUB_COM_PASSWORD`。
- **只代理，不存储**：不读写 KV、不调用 Cache API、不保存任何制品或元数据。
- **客户端零改造**：Maven 客户端只需要仓库 URL，不需要在 `settings.xml` 中配置密码。

## 架构

```text
Maven 客户端
    │  GET /maven.pkg.github.com/alibaba/spring-cloud-alibaba
    │      /com/alibaba/cloud/spring-cloud-alibaba-dependencies
    │      /2026.0.0.0-SNAPSHOT/maven-metadata.xml
    ▼
ESA 边缘节点（本 Worker）
    │  1. 第一段路径 maven.pkg.github.com 作为上游主机
    │  2. 读取 MAVEN_PKG_GITHUB_COM_USERNAME / _PASSWORD
    │  3. 拼装上游 URL 并注入 Basic 认证
    ▼
https://maven.pkg.github.com/alibaba/spring-cloud-alibaba
    /com/alibaba/cloud/spring-cloud-alibaba-dependencies
    /2026.0.0.0-SNAPSHOT/maven-metadata.xml
```

Worker 对每个请求只做一次上游 `fetch`；如果上游返回 3xx，运行时会自动跟随（每次重定向也算一次子请求）。

## 访问方式

格式：

```text
https://<worker-domain>/<upstream-host>/<upstream-path>/<maven-path>
```

等价于：

```text
https://<upstream-host>/<upstream-path>/<maven-path>
```

示例：

| 请求地址 | 实际代理到 |
| --- | --- |
| `https://maven.example.com/maven.pkg.github.com/alibaba/spring-cloud-alibaba/com/alibaba/cloud/spring-cloud-alibaba-dependencies/2026.0.0.0-SNAPSHOT/maven-metadata.xml` | `https://maven.pkg.github.com/alibaba/spring-cloud-alibaba/com/alibaba/cloud/spring-cloud-alibaba-dependencies/2026.0.0.0-SNAPSHOT/maven-metadata.xml` |
| `https://maven.example.com/repo1.maven.org/maven2/...` | `https://repo1.maven.org/maven2/...` |
| `https://maven.example.com/maven.aliyun.com/repository/public/...` | `https://maven.aliyun.com/repository/public/...` |

第一段必须是合法域名，且要在 `MAVEN_ALLOWED_HOSTS` 中；否则返回 `400` / `403`。不以域名开头的路径（例如 `/com/alibaba/...`）会返回 `400`，旧版单仓库模式已删除。

## 配置项

所有配置都通过 ESA 函数变量注入，不写入代码、不落存储。

### 多仓库配置

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `MAVEN_ALLOWED_HOSTS` | 否 | `maven.pkg.github.com` | 允许代理的上游域名，逗号分隔；设为 `*` 允许任意合法域名 |
| `<HOST>_USERNAME` | 与密码成对 | 空 | 上游仓库用户名，`<HOST>` 由域名转换而来 |
| `<HOST>_PASSWORD` | 与用户名成对 | 空 | 上游仓库密码 / Token，建议用加密 Secret |
| `<HOST>_PATH_CONTAINS` | 否 | 空 | 路径必须包含的字符串，逗号分隔；多个值必须全部包含 |
| `<HOST>_PATH_REGEX` | 否 | 空 | 路径必须匹配的 JavaScript 正则 |
| `<HOST>_PATH_EXCLUDE_REGEX` | 否 | 空 | 路径命中该正则时拒绝 |

域名转换规则：

1. 转小写
2. 非字母数字字符（点、连字符等）转为 `_`
3. 转大写
4. 追加 `_USERNAME` / `_PASSWORD`

| 上游域名 | 用户名变量 | 密码变量 |
| --- | --- | --- |
| `maven.pkg.github.com` | `MAVEN_PKG_GITHUB_COM_USERNAME` | `MAVEN_PKG_GITHUB_COM_PASSWORD` |
| `repo1.maven.org` | `REPO1_MAVEN_ORG_USERNAME` | `REPO1_MAVEN_ORG_PASSWORD` |
| `maven.aliyun.com` | `MAVEN_ALIYUN_COM_USERNAME` | `MAVEN_ALIYUN_COM_PASSWORD` |
| `my-repo.example.com` | `MY_REPO_EXAMPLE_COM_USERNAME` | `MY_REPO_EXAMPLE_COM_PASSWORD` |

规则：

- 用户名和密码必须**同时设置**；只设置一个时，该主机的请求返回 `500` 并提示缺少哪个变量。
- 两个都不设置时，该主机以匿名方式转发，适合公开仓库。
- 凭据按主机隔离：`MAVEN_PKG_GITHUB_COM_*` 只会发送给 `maven.pkg.github.com`，不会发给其他主机。
- Worker **不会转发客户端自带的 `Authorization`**。
- 修改函数变量或 Secret 后需要重新部署版本。

### 路径过滤

每个上游域名可以单独配置路径过滤，变量名同样由域名转换：

| 变量 | 说明 |
| --- | --- |
| `<HOST>_PATH_CONTAINS` | 路径必须包含的字符串，逗号分隔；多个值必须全部包含 |
| `<HOST>_PATH_REGEX` | 路径必须匹配的 JavaScript 正则 |
| `<HOST>_PATH_EXCLUDE_REGEX` | 路径命中该正则时拒绝 |

过滤对象是 `/<upstream-path>`：不包含上游主机，包含前导 `/`，不包含查询参数。例如：

```text
请求   /github.com/owner/repo/releases/download/v1/app.jar
过滤值 /owner/repo/releases/download/v1/app.jar
```

匹配规则：

- `PATH_CONTAINS` 中的所有字符串都必须出现。
- 设置了 `PATH_REGEX` 时必须匹配。
- 设置了 `PATH_EXCLUDE_REGEX` 时不能匹配。
- 正则区分大小写；直接填写正则本身，不要写 `/.../` 分隔符。
- 路径会先做 URL 解码再匹配。
- 不匹配返回 `403`，不会发起上游请求。

示例：允许 `github.com`，但只允许下载 GitHub Releases 产物：

```bash
MAVEN_ALLOWED_HOSTS=maven.pkg.github.com,github.com
GITHUB_COM_PATH_CONTAINS=/releases/download/
```

等价的锚定正则：

```bash
GITHUB_COM_PATH_REGEX='^/[^/]+/[^/]+/releases/download/'
```

示例：GitHub Packages 只允许发布版本，不允许 SNAPSHOT：

```bash
MAVEN_ALLOWED_HOSTS=maven.pkg.github.com
MAVEN_PKG_GITHUB_COM_PATH_EXCLUDE_REGEX='-SNAPSHOT'
```

`/-/health` 会返回每个 host 的 `pathFilters`，便于确认配置。

## 部署到 ESA Workers

### 1. 准备

- Node.js 20+
- 阿里云账号已开通 ESA「函数和 Pages」
- 已添加 ESA 站点，并准备好要绑定给 Worker 的子域名（例如 `maven.example.com`）
- 各上游仓库的账号（例如 GitHub PAT，需要 `read:packages` 权限）

安装依赖：

```bash
npm install
```

### 2. 登录 ESA

```bash
npx esa-cli login
```

也可以使用环境变量：

```bash
export ESA_ACCESS_KEY_ID=<AccessKeyId>
export ESA_ACCESS_KEY_SECRET=<AccessKeySecret>
npx esa-cli login
```

### 3. 首次部署（创建函数）

```bash
npx esa-cli deploy --environment production
```

首次部署可以先不配置密码，函数会以匿名方式运行；下一步再注入变量并重新部署。

### 4. 配置允许的主机和上游账号

```bash
# 允许哪些上游域名，逗号分隔；不设置则只允许 maven.pkg.github.com
npx esa-cli env set \
  MAVEN_ALLOWED_HOSTS=maven.pkg.github.com,repo1.maven.org \
  --environment production

# GitHub Packages 账号
npx esa-cli env set \
  MAVEN_PKG_GITHUB_COM_USERNAME=<github-username> \
  --environment production
npx esa-cli secret put MAVEN_PKG_GITHUB_COM_PASSWORD --environment production

# 如果还要代理其他需要认证的仓库，继续添加对应变量
npx esa-cli env set \
  REPO1_MAVEN_ORG_USERNAME=<username> \
  --environment production
npx esa-cli secret put REPO1_MAVEN_ORG_PASSWORD --environment production
```

确认变量（Secret 值会被掩码）：

```bash
npx esa-cli env list --environment production
```

### 5. 重新部署使变量生效

```bash
npx esa-cli deploy --environment production
```

> 函数变量和版本绑定。只修改变量、不重新部署，线上运行的旧版本读不到新值。

### 6. 绑定域名

```bash
npx esa-cli domain add maven.example.com
```

域名需要属于当前 ESA 站点；在中国大陆使用还需完成 ICP 备案。绑定后按控制台提示配置 CNAME。

> 本 Worker 按域名根路径设计。如果改用带路径前缀的路由（例如 `/maven/*`），需要在 Worker 中额外剥离前缀，否则上游会收到多余路径。

### 7. 验证

```bash
curl https://maven.example.com/-/health
```

返回示例：

```json
{
  "status": "ok",
  "multiUpstream": true,
  "author": {
    "name": "徐晓伟",
    "email": "xuxiaowei@xuxiaowei.com.cn",
    "url": "https://www.xuxiaowei.com.cn"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/xuxiaowei-com-cn/esa-maven.git"
  },
  "allowedHosts": ["maven.pkg.github.com", "repo1.maven.org"],
  "hosts": [
    {
      "host": "maven.pkg.github.com",
      "usernameEnv": "MAVEN_PKG_GITHUB_COM_USERNAME",
      "passwordEnv": "MAVEN_PKG_GITHUB_COM_PASSWORD",
      "authentication": "basic"
    }
  ]
}
```

`authentication` 只会显示 `basic` / `anonymous` / `misconfigured`，不会返回密码。

配置了路径过滤时，host 条目会多出：

```json
"pathFilters": {
  "contains": ["/releases/download/"],
  "regex": "^/[^/]+/[^/]+/releases/download/",
  "excludeRegex": "\\.zip$"
}
```

根路径 `/` 会返回 `name`、`version`、`description`、`author`、`repository`，均读取 `package.json`；`/-/health` 也会返回 `author`、`repository`。`repository` 直接返回 `package.json` 中的值，不做额外处理。

### favicon

`/favicon.ico` 由 ESA Pages 静态资源直接返回，文件位于 `public/favicon.ico`。[esa.jsonc](esa.jsonc) 已配置：

```jsonc
"assets": {
  "directory": "./public"
}
```

替换图标只需替换 `public/favicon.ico`，然后重新部署即可。

> `esa-cli dev` 会固定拦截 `/favicon.ico` 并返回 `204`，这是 CLI 本地调试行为；线上由 Pages 静态资源返回。

## 通过控制台导入 GitHub 仓库

如果不想在本地安装 CLI，可以在 ESA 控制台「函数和 Pages」→「创建」→「导入 Github 仓库」中填写：

| 字段 | 填写值 | 说明 |
| --- | --- | --- |
| 项目名称 | `esa-maven` | 与 `esa.jsonc` 的 `name` 一致 |
| 生产分支 | `main` | 推送到 main 后自动构建部署 |
| 非生产分支构建 | 关闭 | 按需开启 |
| 安装命令 | `npm install --omit=dev` | `esa.jsonc` 已覆盖；跳过仅用于本地开发的 `esa-cli` |
| 构建命令 | `npm run build` | 校验入口文件语法 |
| 根目录 | `/` | 构建命令在仓库根目录执行 |
| 静态资源目录 | `./public` | 只放 favicon 等静态文件；由 `esa.jsonc` 的 `assets.directory` 管理 |
| 函数文件路径 | `./src/index.js` | `esa.jsonc` 的 `entry` 已指定 |
| Node.js 版本 | `20` | `package.json` 的 `engines.node` 为 `>=20` |
| 环境变量 | 留空 | 按官方文档，这里是**构建期**变量；运行时配置请用函数变量 |

> `esa.jsonc` 的优先级高于控制台构建信息。项目里已有 `esa.jsonc` 时，`entry`、`installCommand`、`buildCommand` 等字段以文件为准。

创建完成后，在函数详情 → **基本信息** → **函数变量** 中配置运行时变量：

| 键 | 值 | 加密存储 |
| --- | --- | --- |
| `MAVEN_ALLOWED_HOSTS` | `maven.pkg.github.com` | 否 |
| `MAVEN_PKG_GITHUB_COM_USERNAME` | GitHub 用户名 | 否 |
| `MAVEN_PKG_GITHUB_COM_PASSWORD` | 带 `read:packages` 权限的 PAT | **是** |

配置后需要生成新版本并重新部署，变量才会对线上生效。

## Maven 客户端配置

### GitHub Packages 快照

仓库 URL 指向 Worker 域名 + 上游主机 + 上游路径：

```xml
<repositories>
  <repository>
    <id>esa-maven-github</id>
    <name>ESA Maven GitHub Packages</name>
    <url>https://maven.example.com/maven.pkg.github.com/alibaba/spring-cloud-alibaba</url>
    <releases>
      <enabled>false</enabled>
    </releases>
    <snapshots>
      <enabled>true</enabled>
      <updatePolicy>always</updatePolicy>
    </snapshots>
  </repository>
</repositories>
```

如果快照依赖还包含 Maven 插件，再补充：

```xml
<pluginRepositories>
  <pluginRepository>
    <id>esa-maven-github</id>
    <url>https://maven.example.com/maven.pkg.github.com/alibaba/spring-cloud-alibaba</url>
    <releases>
      <enabled>false</enabled>
    </releases>
    <snapshots>
      <enabled>true</enabled>
    </snapshots>
  </pluginRepository>
</pluginRepositories>
```

BOM 导入示例（`spring-cloud-alibaba.version` 设为 `2026.0.0.0-SNAPSHOT`）：

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.alibaba.cloud</groupId>
      <artifactId>spring-cloud-alibaba-dependencies</artifactId>
      <version>${spring-cloud-alibaba.version}</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>
```

### 验证快照元数据

访问该依赖版本的 `maven-metadata.xml`：

```bash
curl https://maven.example.com/maven.pkg.github.com/alibaba/spring-cloud-alibaba/com/alibaba/cloud/spring-cloud-alibaba-dependencies/2026.0.0.0-SNAPSHOT/maven-metadata.xml
```

返回内容包含 `<snapshotVersions>`，Maven 会根据它定位实际的时间戳文件。

说明：

- **不需要**在 `~/.m2/settings.xml` 中为这个仓库配置 `<server>`；密码由 Worker 在边缘注入。
- 快照元数据有更新时使用 `mvn -U` 强制刷新。
- 验证快照时请访问上面的 `maven-metadata.xml`；GitHub Packages 的实际快照文件带时间戳，Maven 会从元数据中解析实际文件名。
- 本 Worker 只代理下载（`GET` / `HEAD`），不支持 `PUT` 部署制品。

### 同时使用多个上游

```xml
<repositories>
  <repository>
    <id>esa-maven-central</id>
    <url>https://maven.example.com/repo1.maven.org/maven2</url>
    <releases><enabled>true</enabled></releases>
    <snapshots><enabled>false</enabled></snapshots>
  </repository>
  <repository>
    <id>esa-maven-github</id>
    <url>https://maven.example.com/maven.pkg.github.com/alibaba/spring-cloud-alibaba</url>
    <releases><enabled>false</enabled></releases>
    <snapshots><enabled>true</enabled></snapshots>
  </repository>
</repositories>
```

每个上游域名都要出现在 `MAVEN_ALLOWED_HOSTS` 中。

## 本地开发与测试

```bash
npm test
```

本地联调（使用真实 Token，但 Token 只存在于当前 shell 环境）：

```bash
export MAVEN_ALLOWED_HOSTS=maven.pkg.github.com
export MAVEN_PKG_GITHUB_COM_USERNAME=<github-username>
read -s MAVEN_PKG_GITHUB_COM_PASSWORD
export MAVEN_PKG_GITHUB_COM_PASSWORD

npm run dev:local
# 另开终端：
curl http://127.0.0.1:8787/-/health
curl -I http://127.0.0.1:8787/maven.pkg.github.com/alibaba/spring-cloud-alibaba/com/alibaba/cloud/spring-cloud-alibaba-dependencies/2026.0.0.0-SNAPSHOT/maven-metadata.xml
```

也可以通过 ESA CLI 启动官方本地调试服务：

```bash
npm run dev
```

> `esa-cli dev` 不会注入控制台上的函数变量，因此本地验证“密码注入”时请使用 `npm run dev:local`，或直接在 ESA 控制台的调试环境中测试。

## 安全说明

- 默认只允许 `maven.pkg.github.com`。要代理其他仓库，必须把域名加入 `MAVEN_ALLOWED_HOSTS`。
- `MAVEN_ALLOWED_HOSTS=*` 会允许任意合法域名，等同于公开代理；不建议在生产环境这样配置。
- 凭据按上游域名隔离，`maven.pkg.github.com` 的 Token 不会发送给其他主机。
- 密码通过 ESA 加密 Secret 存储，控制台不回显；代码和仓库中不出现明文。
- 上游 URL 中禁止内嵌账号密码，避免密码进入日志或配置快照。
- 客户端传入的 `Authorization`、`Cookie` 不会被转发。
- 响应只回传 Maven 需要的头（`content-type`、`etag`、`last-modified`、`cache-control` 等），不转发 `set-cookie`、`www-authenticate`。
- 上游返回 `401/403` 时会附加 `x-esa-maven-upstream-status`，方便区分“边缘凭据错误”和“客户端未认证”。
- 上游 3xx 会被自动跟随；允许列表和路径过滤只校验首次请求，不校验重定向目标。

## 限制与注意事项

- ESA 边缘函数仅支持 JavaScript（ES6），单次执行最多 **4 个子请求**；本代理正常只使用 1 个，重定向会额外计数。
- 请求 URL 总长度不超过 4 KB；函数代码包不超过 4 MB；单次响应时间上限 120 秒。
- 只支持公网域名，不支持 IP 地址、端口、IPv6；多仓库模式固定使用 HTTPS。
- 只支持 `GET` / `HEAD`，其他方法返回 `405`。
- 上游主机必须是路径第一段，例如 `/maven.pkg.github.com/...`；带路径前缀的路由需要在 Worker 中额外处理。
- Worker 不做任何存储；如果 ESA 站点层开启了缓存，快照 `maven-metadata.xml` 的刷新策略需要在站点缓存规则中单独处理。

## 故障排查

| 现象 | 排查方向 |
| --- | --- |
| `403` | 上游主机不在 `MAVEN_ALLOWED_HOSTS` 中，或路径被 `_PATH_*` 过滤规则拦截 |
| `400` | 第一段不是合法域名，或包含 IP、端口、下划线、IPv6；也可能是路径 URL 编码非法 |
| `401`，响应头 `x-esa-maven-upstream-status: 401` | 该主机的 `_USERNAME` / `_PASSWORD` 错误、过期或缺少 `read:packages` |
| `404` | 上游路径不存在；先用 `.../2026.0.0.0-SNAPSHOT/maven-metadata.xml` 验证路径，快照文件以元数据为准 |
| `500` 且提示缺少 `_USERNAME` / `_PASSWORD` | 该主机的用户名和密码必须成对设置 |
| `500` 且提示 `MAVEN_ALLOWED_HOSTS` | 允许列表中有非法域名 |
| `500` 且提示 `_PATH_REGEX` | 路径过滤正则不合法 |
| `502` | Worker 无法访问上游；检查域名、DNS 和 ESA 出网情况 |
| `405` | 只支持 `GET` / `HEAD`，不支持部署 |
| 健康检查中 `authentication` 为 `anonymous` | 该主机还没有配置 `_USERNAME` / `_PASSWORD` |
| 快照版本不更新 | `mvn -U`；检查 ESA 站点缓存是否缓存了 `maven-metadata.xml` |

## 参考

- [阿里云 ESA 函数和 Pages](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/what-is-functions-and-pages/)
- [ESA 函数变量](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/function-variable)
- [ESA 函数和 Pages CLI 工具](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/functions-and-pages-cli-tool)
- [ESA Fetch API](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/fetch-1)
- [GitHub Packages Maven registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-apache-maven-registry)
