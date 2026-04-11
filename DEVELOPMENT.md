# 🛠 声必可网关 — 开发与发布指南

> 本文档面向开发者和 AI 助手，描述项目结构、发布流程、常见坑点。

---

## 📁 项目结构

```
aispeaker-gateway/                  ← Git 仓库根目录
├── README.md                       ← 用户文档
├── DEVELOPMENT.md                  ← 本文件（开发指南）
├── jdxy.apk                        ← 声必可主机端 APK（用户需手动安装）
├── repository.json                 ← HA Add-on 仓库元数据
│
├── aispeaker-gateway/              ← Add-on 目录（HA Supervisor 读取此目录）
│   ├── config.json                 ← ⭐ Add-on 元数据（版本号、架构、选项等）
│   ├── Dockerfile                  ← Docker 镜像构建文件
│   ├── .dockerignore               ← Docker 构建排除规则
│   ├── run.sh                      ← Add-on 启动脚本
│   ├── package.json                ← Node.js 依赖
│   ├── package-lock.json
│   ├── Dockerfile.standalone       ← 独立部署用 Dockerfile（备用）
│   │
│   └── src/
│       ├── index.js                ← 入口文件（守护进程 + 服务编排）
│       ├── config.js               ← 配置管理（双模式：Add-on / 独立）
│       ├── logger.js               ← 日志模块（分级 + 环形缓冲）
│       ├── ha-client.js            ← HA WebSocket 客户端（认证 + 重连）
│       ├── device-manager.js       ← 设备管理（HA ↔ 声必可 桥接）
│       │
│       ├── jdsmart/
│       │   ├── protocol.js         ← JdSmart V2 协议编解码
│       │   ├── tcp-server.js       ← TCP 通信（音箱 ↔ 网关）
│       │   └── udp-server.js       ← UDP 发现服务（广播 + 响应）
│       │
│       └── web/
│           ├── server.js           ← Express Web API（配置界面后端）
│           └── public/
│               └── index.html      ← 配置管理前端（单文件 SPA）
│
└── .github/
    └── workflows/
        └── build.yml               ← GitHub Actions CI（自动构建 + 推送镜像）
```

---

## 🚀 发布流程（版本升级）

### 步骤

1. **修改代码**
2. **升版本号** — 修改 `aispeaker-gateway/config.json` 中的 `version` 字段
3. **提交并推送** — `git add -A && git commit -m "..." && git push`
4. **等待 CI 构建** — GitHub Actions 自动触发（约 3-5 分钟）
5. **用户侧更新** — HA → 加载项 → 检查更新 → 更新

### CI 触发条件

`build.yml` 配置了 paths 过滤，只有以下文件变更时才触发构建：

```yaml
paths:
  - 'aispeaker-gateway/src/**'
  - 'aispeaker-gateway/package.json'
  - 'aispeaker-gateway/Dockerfile'
  - 'aispeaker-gateway/config.json'
```

> ⚠️ 修改 `.dockerignore`、`run.sh`、`DEVELOPMENT.md` 等文件不会触发构建！
> 如果改了这些文件需要出镜像，必须同时改一个触发文件（比如 bump 版本号）。

### CI 做了什么

1. 读取 `config.json` 中的 `version` 字段作为镜像 tag
2. 用 Docker Buildx 构建两个架构：`linux/amd64` 和 `linux/arm64`
3. 推送到阿里云容器镜像仓库：
   - `crpi-xxx.cn-hangzhou.personal.cr.aliyuncs.com/yuanxin32323/aispeaker-gateway-amd64:{version}`
   - `crpi-xxx.cn-hangzhou.personal.cr.aliyuncs.com/yuanxin32323/aispeaker-gateway-aarch64:{version}`
   - 同时打 `latest` 标签

### GitHub Secrets

CI 需要以下 secrets（已配置）：

| Secret | 说明 |
|--------|------|
| `ALIYUN_REGISTRY_USER` | 阿里云容器镜像用户名 |
| `ALIYUN_REGISTRY_PASSWORD` | 阿里云容器镜像密码 |

---

## ✅ 发布前检查清单

### 1. 语法检查

```bash
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd aispeaker-gateway
node -c src/index.js
node -c src/config.js
node -c src/ha-client.js
node -c src/device-manager.js
node -c src/logger.js
node -c src/jdsmart/tcp-server.js
node -c src/jdsmart/udp-server.js
node -c src/jdsmart/protocol.js
node -c src/web/server.js
```

### 2. 确认 config.json 版本号已升级

```bash
grep '"version"' aispeaker-gateway/config.json
```

### 3. 确认 .dockerignore 没有排除必要文件

当前必须**不被排除**的文件：
- `config.json` — 版本号读取需要
- `src/` — 应用代码
- `package.json` / `package-lock.json` — 依赖
- `run.sh` — 启动脚本

### 4. 检查 CI 构建结果

```bash
curl -s "https://api.github.com/repos/yuanxin32323/aispeaker-gateway/actions/runs?per_page=3" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for r in d.get('workflow_runs',[]):
  print(r['status'], r['conclusion'] or '-', r['head_commit']['message'].split(chr(10))[0][:60])
"
```

---

## 🏗 架构要点

### 双模式运行

| | Add-on 模式 | 独立模式 |
|---|---|---|
| **判断方式** | `process.env.SUPERVISOR_TOKEN` 存在 | 不存在 |
| **HA 地址** | `ws://supervisor/core/websocket`（自动） | 用户手动配置 |
| **HA Token** | 环境变量自动注入 | 用户手动配置 |
| **配置存储** | `/config/aispeaker-gateway/config.json` | 项目目录 `config.json` |
| **端口配置** | `/data/options.json`（Supervisor 生成） | 配置文件 |
| **Web 访问** | 通过 HA Ingress 侧边栏 | 直接 `http://IP:3000` |

### Ingress 路径处理

Add-on 通过 HA Ingress 嵌入时，URL 格式为：
```
/api/hassio_ingress/<token>/api/config
```

- **后端**：Express 中间件检测 `X-Ingress-Path` 头，去掉前缀后匹配路由
- **前端**：`index.html` 中的 `apiUrl()` 函数检测 `window.location.pathname`，自动拼接 Ingress 前缀

### 日志分级

| 级别 | 内容 |
|------|------|
| `debug` | 设备操作（状态推送、TCP 收发、UDP 发现、控制指令、协议解析） |
| `info` | 服务启动、HA 认证、缓存统计、重连成功 |
| `warn` | WebSocket 断开、重连失败、连接错误 |
| `error` | 认证失败、端口占用、服务调用失败 |

> 所有模块使用 `require('./logger')` 单例，**禁止使用 console.log**（启动 banner 除外）。

### WebSocket 重连

- 断线后自动重连，递增退避：5s → 10s → 20s → 30s（最大）
- 重连成功后重置退避计数器
- 永远不放弃，直到手动停止

### 配置持久化

- Add-on 配置存储在 `/config/aispeaker-gateway/config.json`（HA 主目录）
- 卸载重装 Add-on 不会丢失配置
- 首次启动自动从旧路径 `/data/config.json` 迁移

---

## ⚠️ 常见坑点

### 1. `.dockerignore` 排除了文件导致构建失败
之前 `config.json` 被排除，导致 `COPY config.json ./` 找不到文件。修改 Dockerfile 时务必检查。

### 2. CI 没触发
改的文件不在 `build.yml` 的 `paths` 列表里。手动去 GitHub Actions 点 **Run workflow** 或 bump 版本。

### 3. 版本号没升导致 HA 不显示更新
HA Supervisor 对比 `config.json` 中的 `version` 字段决定是否有更新。相同版本号 = 无更新。

### 4. 镜像没构建完就在 HA 更新
HA 看到新版本号但阿里云上还没有对应 tag 的镜像，拉取会失败。必须等 CI 构建完成。

### 5. 端口 6666 被旧 shengbike 集成占用
HA 的 `.storage/core.config_entries` 中可能残留 shengbike 配置条目。需在 HA 设置 → 设备与服务中手动删除。

### 6. 中文字符 padEnd 宽度问题
中文字符的显示宽度是 2，但 JS `padEnd` 按字符数计算。如果做对齐输出，避免对中文用 padEnd。

### 7. Gitee 镜像仓库
国内用户可能用 Gitee 地址添加仓库。需确保 Gitee 和 GitHub 代码同步。当前 Gitee 地址：
```
https://gitee.com/lisaoouba/aispeaker-gateway
```

---

## 🔌 声必可协议概要

### UDP 发现（端口 6666 → 7777）
- 音箱开机广播 `REQUEST_TCP` 到 6666
- 网关回复 `RESPONSE_TCP`（含 IP + TCP 端口）到 7777
- 网关每 30 秒主动广播一次

### TCP 通信（端口 8888）
- V2 协议格式：`0xAB | 3字节长度 | 2字节命令 | JSON | 1字节校验`
- 校验算法：长度+命令+数据 所有字节异或
- 防粘包：每个包之间最小间隔 100ms

### 主要消息类型
| 类型 | 方向 | 说明 |
|------|------|------|
| `REQUEST_HEART_BEAT` | 音箱→网关 | 心跳 |
| `REQUEST_DEVICE` | 音箱→网关 | 请求设备列表 |
| `REQUEST_ROOM` | 音箱→网关 | 请求房间列表 |
| `REQUEST_CONTROL` | 音箱→网关 | 控制设备 |
| `RESPONSE_CONTROL` | 网关→音箱 | 控制结果 / 状态推送 |

---

## 🖥 远程调试

### SSH 到 HA 主机

```bash
ssh root@192.168.0.88  # 密码: y1009090
```

### 常用命令

```bash
# Add-on 操作
ha addons info 247d0ab5_aispeaker_gateway
ha addons logs 247d0ab5_aispeaker_gateway
ha addons start 247d0ab5_aispeaker_gateway
ha addons stop 247d0ab5_aispeaker_gateway
ha addons restart 247d0ab5_aispeaker_gateway

# Supervisor 操作
ha supervisor repair
ha supervisor restart
docker restart hassio_supervisor

# HA Core 操作
ha core restart
docker restart homeassistant

# 检查端口占用
docker exec homeassistant netstat -tlnp | grep 8888
docker exec homeassistant netstat -ulnp | grep 6666
```

> ⚠️ Add-on slug 前缀会因仓库 ID 变化。用 `ha addons` 查看当前实际 slug。
