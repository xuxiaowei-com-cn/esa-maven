# esa-maven

阿里云 ESA Workers（边缘函数）实现的 **Maven 快照仓库代理**。

- **只代理，不存储**：不读写 KV、不调用 Cache API、不保存任何制品或元数据。
- **快照地址可配置**：默认 `https://maven.pkg.github.com/alibaba/spring-cloud-alibaba`，可通过 `MAVEN_SNAPSHOT_URL` 指向任意 Maven 仓库。
- **仓库密码可配置**：通过 `MAVEN_REPO_USERNAME` / `MAVEN_REPO_PASSWORD` 在边缘注入 Basic 认证，密码建议使用 ESA 加密 Secret。
- **客户端零改造**：Maven 客户端只需把仓库地址指向 Worker 域名，不需要在 `settings.xml` 中配置密码。

## 架构

```text
Maven 客户端
    │  GET /com/alibaba/cloud/.../xxx-1.0-SNAPSHOT.pom
    ▼
阿里云 ESA 边缘节点
    │  本 Worker：校验配置、拼装上游 URL、注入 Basic 认证
    ▼
MAVEN_SNAPSHOT_URL
（默认 GitHub Packages: alibaba/spring-cloud-alibaba）
```

Worker 对每个请求只做一次上游 `fetch`；如果上游返回 3xx，运行时会自动跟随（每次重定向也算一次子请求）。

## 目录结构

```text
.
├── esa.jsonc                 # ESA CLI 工程配置（入口、本地调试端口）
├── package.json
├── src
│   ├── index.js              # ESA Worker 入口：export default { fetch }
│   ├── maven-proxy.js        # 代理核心：URL 拼装、请求头过滤、认证注入
│   ├── config.js             # 环境变量读取与校验
│   └── base64.js             # UTF-8 Basic 认证编码
├── scripts
│   └── dev-server.mjs        # 本地调试适配器（读取 shell 环境变量）
├── test
│   └── maven-proxy.test.js   # Node 原生测试
└── README.md
```

## 配置项

所有配置都通过 ESA 函数变量注入，不写入代码、不落存储。

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `MAVEN_SNAPSHOT_URL` | 否 | `https://maven.pkg.github.com/alibaba/spring-cloud-alibaba` | 上游 Maven 仓库根地址；末尾 `/` 可省略；不能包含账号密码、查询参数或锚点 |
| `MAVEN_REPO_USERNAME` | 与密码成对 | 空 | 上游仓库用户名。GitHub Packages 填 GitHub 用户名 |
| `MAVEN_REPO_PASSWORD` | 与用户名成对 | 空 | 上游仓库密码 / Token。GitHub Packages 使用带 `read:packages` 权限的 PAT；建议用 `esa-cli secret put` 加密存储 |

规则：

- 用户名和密码**必须同时设置**；只设置其中一个时，Worker 返回 `500` 并提示缺少哪个变量。
- 两个都不设置时，Worker 以匿名方式转发，适合公开仓库。
- `MAVEN_REPO_PASSWORD` 是 **Worker 访问上游仓库**的密码 / Token，不是客户端访问 Worker 的密码；Maven 客户端不需要配置密码。
- Worker **不会转发客户端自带的 `Authorization`**，始终使用边缘侧配置的凭据，避免客户端凭据泄露到上游。
- 修改函数变量或 Secret 后需要重新部署版本，线上才会生效。

## 部署到 ESA Workers

### 1. 准备

- Node.js 20+
- 阿里云账号已开通 ESA「函数和 Pages」
- 已添加 ESA 站点，并准备好要绑定给 Worker 的子域名（例如 `maven.example.com`）
- GitHub PAT（classic token，勾选 `read:packages`）

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

`esa-cli deploy` 会在函数不存在时自动创建：

```bash
npx esa-cli deploy --environment production
```

首次部署可以先不配置密码，函数会以匿名方式运行；下一步再注入变量并重新部署。

### 4. 配置快照地址与密码

```bash
# 上游快照仓库地址（不设置则使用默认 GitHub Packages 地址）
npx esa-cli env set \
  MAVEN_SNAPSHOT_URL=https://maven.pkg.github.com/alibaba/spring-cloud-alibaba \
  --environment production

# GitHub 用户名
npx esa-cli env set \
  MAVEN_REPO_USERNAME=<github-username> \
  --environment production

# 仓库密码 / PAT：使用加密 Secret，按提示输入，不要写进 shell 历史
npx esa-cli secret put MAVEN_REPO_PASSWORD --environment production
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

> 本 Worker 按域名根路径设计，Maven 仓库地址直接使用 `https://maven.example.com`。如果改用带路径前缀的路由（例如 `/maven/*`），需要在 Worker 中额外剥离前缀，否则上游会收到多余路径。

### 7. 验证

```bash
curl https://maven.example.com/-/health
```

返回示例：

```json
{
  "status": "ok",
  "upstream": "https://maven.pkg.github.com/alibaba/spring-cloud-alibaba",
  "authentication": "basic"
}
```

`authentication` 只会显示 `basic` 或 `anonymous`，不会返回密码。

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
| 静态资源目录 | 留空 | 纯函数项目，没有静态资源 |
| 函数文件路径 | `./src/index.js` | `esa.jsonc` 的 `entry` 已指定 |
| Node.js 版本 | `20` | `package.json` 的 `engines.node` 为 `>=20` |
| 环境变量 | 留空 | 按官方文档，这里是**构建期**变量；运行时配置请用函数变量 |

> `esa.jsonc` 的优先级高于控制台构建信息。项目里已有 `esa.jsonc` 时，`entry`、`installCommand`、`buildCommand` 等字段以文件为准。

创建完成后，在函数详情 → **基本信息** → **函数变量** 中配置运行时变量：

| 键 | 值 | 加密存储 |
| --- | --- | --- |
| `MAVEN_SNAPSHOT_URL` | `https://maven.pkg.github.com/alibaba/spring-cloud-alibaba` | 否 |
| `MAVEN_REPO_USERNAME` | GitHub 用户名 | 否 |
| `MAVEN_REPO_PASSWORD` | 带 `read:packages` 权限的 PAT | **是** |

配置后需要生成新版本并重新部署，变量才会对线上生效。绑定域名和 Maven 客户端配置与上一节相同。

## Maven 客户端配置

在项目的 `pom.xml` 中添加快照仓库：

```xml
<repositories>
  <repository>
    <id>esa-maven-snapshots</id>
    <name>ESA Maven Snapshots</name>
    <url>https://maven.example.com</url>
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
    <id>esa-maven-snapshots</id>
    <url>https://maven.example.com</url>
    <releases>
      <enabled>false</enabled>
    </releases>
    <snapshots>
      <enabled>true</enabled>
    </snapshots>
  </pluginRepository>
</pluginRepositories>
```

使用示例（版本号替换为实际快照版本）：

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

说明：

- **不需要**在 `~/.m2/settings.xml` 中为这个仓库配置 `<server>`；密码由 Worker 在边缘注入。
- 快照元数据有更新时使用 `mvn -U` 强制刷新。
- 本 Worker 只代理下载（`GET` / `HEAD`），不支持 `PUT` 部署制品。

## 本地开发与测试

```bash
npm test
```

本地联调（使用真实 GitHub Token，但 Token 只存在于当前 shell 环境）：

```bash
export MAVEN_REPO_USERNAME=<github-username>
read -s MAVEN_REPO_PASSWORD
export MAVEN_REPO_PASSWORD

npm run dev:local
# 另开终端：
curl http://127.0.0.1:8787/-/health
curl -I http://127.0.0.1:8787/com/alibaba/cloud/.../xxx-SNAPSHOT.pom
```

也可以通过 ESA CLI 启动官方本地调试服务：

```bash
npm run dev
```

> `esa-cli dev` 不会注入控制台上的函数变量，因此本地验证“密码注入”时请使用 `npm run dev:local`，或直接在 ESA 控制台的调试环境中测试。

## 安全说明

- 密码通过 ESA 加密 Secret 存储，控制台不回显；代码和仓库中不出现明文。
- 上游 URL 中禁止内嵌账号密码，避免密码进入日志或配置快照。
- 客户端传入的 `Authorization`、`Cookie` 不会被转发。
- 响应只回传 Maven 需要的头（`content-type`、`etag`、`last-modified`、`cache-control` 等），不转发 `set-cookie`、`www-authenticate`。
- 上游返回 `401/403` 时会附加 `x-esa-maven-upstream-status`，方便区分“边缘凭据错误”和“客户端未认证”。

## 限制与注意事项

- ESA 边缘函数仅支持 JavaScript（ES6），单次执行最多 **4 个子请求**；本代理正常只使用 1 个，重定向会额外计数。
- 请求 URL 总长度不超过 4 KB；函数代码包不超过 4 MB；单次响应时间上限 120 秒。
- Worker 不做任何存储；如果 ESA 站点层开启了缓存，快照 `maven-metadata.xml` 的刷新策略需要在站点缓存规则中单独处理。
- 只支持 `GET` / `HEAD`，其他方法返回 `405`。

## 故障排查

| 现象 | 排查方向 |
| --- | --- |
| `500` 且提示缺少 `MAVEN_REPO_USERNAME` / `MAVEN_REPO_PASSWORD` | 两个变量必须成对设置 |
| `500` 且提示 `MAVEN_SNAPSHOT_URL` 非法 | 检查 URL 是否为 http/https、是否误加了查询参数或内嵌账号密码 |
| `401`，响应头 `x-esa-maven-upstream-status: 401` | PAT 错误、过期或缺少 `read:packages`；确认用户名是 GitHub 用户名 |
| `403`，响应头 `x-esa-maven-upstream-status: 403` | Token 无该包/仓库权限，或触发 GitHub 限流 |
| `404` | 上游路径不存在，或 `MAVEN_SNAPSHOT_URL` 多了/少了路径；先用 `curl -u` 直连 GitHub Packages 验证 |
| `502` | Worker 无法访问上游；检查 URL、DNS 和 ESA 出网情况 |
| `405` | 只支持 `GET` / `HEAD`，不支持部署 |
| 快照版本不更新 | `mvn -U`；检查 ESA 站点缓存是否缓存了 `maven-metadata.xml` |

## 参考

- [阿里云 ESA 函数和 Pages](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/what-is-functions-and-pages/)
- [ESA 函数变量](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/function-variable)
- [ESA 函数和 Pages CLI 工具](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/functions-and-pages-cli-tool)
- [ESA Fetch API](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/fetch-1)
- [GitHub Packages Maven registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-apache-maven-registry)
