# 🔊 声必可网关 (AISpeaker Gateway)

将 Home Assistant 设备桥接至声必可(AISpeaker)智能音箱，实现语音控制灯光、开关、窗帘、空调等智能设备。

## ✨ 功能特性

- 🏠 **HA 设备桥接** — 自动同步 Home Assistant 中的灯光、开关、窗帘、空调、风扇、传感器、场景等设备
- 🎙️ **语音控制** — 通过声必可音箱语音控制 HA 设备开关、亮度、温度等
- 📡 **自动发现** — 音箱通过 UDP 广播自动发现网关，无需手动配置 IP
- 🔄 **实时同步** — HA 设备状态变化时自动推送至音箱
- 🌐 **Web 配置** — 可视化配置界面，轻松管理设备和房间
- 🛡️ **稳定可靠** — 断线自动重连、崩溃自动恢复、日志轮转防爆

## ⚠️ 前置条件（必读！）

> **在安装网关之前，必须先对声必可主机进行以下操作，否则无法正常使用！**

### 1. 安装 jdxy.apk

将本仓库中的 [`jdxy.apk`](./jdxy.apk) 安装到声必可主机上。

安装方式：
- 通过 U 盘拷贝 APK 到音箱，使用文件管理器安装
- 或通过 ADB 安装：`adb install jdxy.apk`

### 2. 关闭原有智能网关服务

安装完成后，**必须关闭声必可主机自带的智能网关服务**，否则会与本网关冲突（端口占用）。

> 💡 具体操作方式请参考声必可主机的设置菜单，找到"智能网关"或"JdSmart"相关服务并禁用。

---

## 📦 安装方式

### 方式一：Home Assistant Add-on（推荐）

> 适用于 Home Assistant OS 或 Supervised 安装方式

**1. 添加仓库**

[![添加仓库](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fyuanxin32323%2Faispeaker-gateway)

或手动添加：

- 打开 HA → **设置** → **加载项** → **加载项商店**
- 右上角 **⋮** → **储存库**
- 输入仓库地址：
  ```
  https://github.com/yuanxin32323/aispeaker-gateway
  ```
- 点击 **添加** → **关闭**

**2. 安装加载项**

- 刷新页面，在商店底部找到 **「声必可网关 (AISpeaker Gateway)」**
- 点击 → **安装**（镜像托管在阿里云，国内秒装）

**3. 配置**

在加载项的 **配置** 选项卡中设置：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `tcp_port` | TCP 通信端口（音箱连接用） | `8888` |
| `udp_port` | UDP 发现端口（音箱发现用） | `6666` |
| `log_level` | 日志级别 | `info` |

> ⚠️ 如果端口被占用，请修改为其他值（如 `18888`、`16666`）

**4. 启动**

- 点击 **启动**
- 侧边栏出现 **「声必可网关」** 入口，点击进入配置界面
- 在配置界面中选择要桥接的设备和房间

---

### 方式二：Docker 独立部署

> 适用于任何安装方式的 Home Assistant（包括 Docker 版、Core 版）

**1. 创建配置文件**

```bash
mkdir -p aispeaker-gateway && cd aispeaker-gateway

cat > config.json << 'EOF'
{
  "ha": {
    "url": "ws://你的HA地址:8123/api/websocket",
    "token": "你的HA长期访问令牌"
  },
  "gateway": {
    "ip": "",
    "tcpPort": 8888,
    "udpPort": 6666
  },
  "rooms": [
    { "id": 1, "name": "默认房间" }
  ],
  "floors": [
    { "id": 101, "name": "默认楼层" }
  ],
  "entities": {},
  "filterMode": "include"
}
EOF
```

> 💡 获取 Token：HA → 用户头像 → 安全 → 长期访问令牌 → 创建令牌

**2. Docker Compose 启动**

```yaml
# docker-compose.yml
version: "3.8"

services:
  aispeaker-gateway:
    image: crpi-f5kd64keui5oedie.cn-hangzhou.personal.cr.aliyuncs.com/yuanxin32323/aispeaker-gateway-amd64:latest
    container_name: aispeaker-gateway
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./config.json:/app/config.json
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

> 🖥️ ARM 设备（如树莓派）请将镜像改为：
> `crpi-f5kd64keui5oedie.cn-hangzhou.personal.cr.aliyuncs.com/yuanxin32323/aispeaker-gateway-aarch64:latest`

```bash
docker compose up -d
```

**3. 访问配置界面**

打开浏览器访问 `http://你的主机IP:3000`，在 Web 界面中：

1. 检查 HA 连接状态
2. 选择要桥接到音箱的设备
3. 配置房间映射

---

## 🎯 使用指南

### 设备配置

1. 进入 Web 配置界面（Add-on 从侧边栏进入，Docker 访问 `http://IP:3000`）
2. 在 **设备管理** 页面，启用需要桥接的 HA 设备
3. 在 **房间管理** 和 **楼层管理** 页面，创建空间并分配设备
4. 保存配置后，音箱会自动发现并同步设备

### 支持的设备类型

| 设备类型 | HA 域 | 支持操作 |
|---------|-------|---------|
| 💡 灯光 | `light` | 开关、亮度、色温 |
| 🔌 开关 | `switch` | 开关 |
| 🪟 窗帘 | `cover` | 开关、位置 |
| ❄️ 空调 | `climate` | 开关、温度、模式 |
| 🌀 风扇 | `fan` | 开关、风速 |
| 📊 传感器 | `sensor` | 读取状态 |
| 🎬 场景 | `scene` | 激活 |

## 🔧 常见问题

<details>
<summary><strong>音箱搜索不到网关</strong></summary>

- 确保音箱和运行网关的设备在**同一局域网**
- Docker 必须使用 `network_mode: host`（不能用端口映射）
- 检查 UDP 端口（默认 6666）是否被防火墙阻止
</details>

<details>
<summary><strong>端口被占用 (EADDRINUSE)</strong></summary>

- 修改配置中的 `tcp_port` 和 `udp_port` 为其他值
- 检查是否有旧版声必可集成在运行（custom_components/shengbike），如有请先删除
</details>

<details>
<summary><strong>HA 无法连接</strong></summary>

- 检查 WebSocket 地址格式：`ws://IP:8123/api/websocket`
- 确认长期访问令牌是否有效
- Add-on 模式下 HA 连接是自动管理的，无需手动配置
</details>

## 📄 开源协议

MIT License

## 🙏 致谢

- [Home Assistant](https://www.home-assistant.io/) — 开源智能家居平台
- [JdSmart Protocol](https://www.jd.com/) — 声必可通信协议
