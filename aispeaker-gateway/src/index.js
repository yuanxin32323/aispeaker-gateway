/**
 * 声必可网关 — 入口文件
 * 
 * 启动顺序:
 * 1. 初始化日志
 * 2. 加载配置（自动检测 Add-on / 独立模式）
 * 3. 连接 HA WebSocket
 * 4. 初始化设备管理器
 * 5. 启动 JdSmart TCP/UDP 服务
 * 6. 启动 Web 配置界面
 *
 * 守护进程：崩溃后自动重启（最多 5 次 / 60 秒）
 */

'use strict';

const log = require('./logger');
const { loadConfig, saveConfig, IS_ADDON } = require('./config');
const HaClient = require('./ha-client');
const DeviceManager = require('./device-manager');
const TcpServer = require('./jdsmart/tcp-server');
const UdpServer = require('./jdsmart/udp-server');
const WebServer = require('./web/server');

/** 守护进程：崩溃重启限制 */
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60000;
let restartTimes = [];

async function main() {
  const ver = require('../config.json').version || '0.0.0';
  console.log(`\n🔊 声必可网关 (AISpeaker Gateway) v${ver}`);
  console.log(`   模式: ${IS_ADDON ? 'HA Add-on' : '独立部署'}\n`);

  // 1. 加载配置
  const config = loadConfig();

  // 初始化日志级别
  if (config.logLevel) {
    log.setLevel(config.logLevel);
  }
  // 独立模式下启用文件日志
  if (!IS_ADDON && !log.logFile) {
    const path = require('path');
    log.logFile = path.join(__dirname, '..', 'gateway.log');
    log._openStream();
  }

  log.info('Main', `配置已加载, 模式=${IS_ADDON ? 'addon' : 'standalone'}`);

  if (!config.ha.token) {
    log.error('Main', '请先配置 HA 的长期访问令牌 (ha.token)');
    log.info('Main', '获取方法: HA → 用户头像 → 安全 → 长期访问令牌 → 创建令牌');

    // 即使没有 token 也启动 Web 界面，让用户通过 Web 配置
    const webServer = new WebServer({ port: 3000, haClient: { connected: false }, deviceManager: null, tcpServer: null });
    await webServer.start();
    log.info('Main', '📡 Web 配置界面已启动: http://localhost:3000');
    return;
  }

  // 2. 连接 HA
  const haClient = new HaClient({
    url: config.ha.url,
    token: config.ha.token
  });

  let tcpServer, udpServer, deviceManager;

  try {
    await haClient.connect();
  } catch (e) {
    log.error('Main', `无法连接 HA: ${e.message}`);
    log.info('Main', '请检查 HA 地址和 Token 是否正确');

    // 还是启动 Web 让用户修正配置
    const webServer = new WebServer({ port: 3000, haClient, deviceManager: null, tcpServer: null });
    await webServer.start();
    return;
  }

  // 3. 初始化设备管理器
  deviceManager = new DeviceManager({
    haClient,
    config,
    onPushState: (entityId, deviceState) => {
      if (tcpServer) {
        tcpServer.pushStateUpdate(entityId, deviceState);
      }
    }
  });

  await deviceManager.init();

  // 4. 启动 JdSmart 服务
  tcpServer = new TcpServer({
    port: config.gateway.tcpPort,
    deviceManager
  });

  udpServer = new UdpServer({
    hostIp: config.gateway.ip,
    tcpPort: config.gateway.tcpPort,
    udpPort: config.gateway.udpPort
  });

  // 逐个启动，任何一个失败都先清理已启动的服务
  try {
    await tcpServer.start();
  } catch (e) {
    log.error('Main', `TCP 启动失败: ${e.message}`);
    haClient.disconnect();
    throw e;
  }

  try {
    await udpServer.start();
  } catch (e) {
    log.error('Main', `UDP 启动失败: ${e.message}`);
    tcpServer.stop();
    haClient.disconnect();
    throw e;
  }

  // 5. 启动 Web 配置界面
  const webServer = new WebServer({
    port: 3000,
    haClient,
    deviceManager,
    tcpServer,
    onConfigSaved: (newConfig) => {
      log.info('Main', '配置已更新，热重载');
      deviceManager.updateConfig(newConfig);
    }
  });

  await webServer.start();

  log.info('Main', '✅ 所有服务已启动:');
  log.info('Main', `  📡 UDP 发现: 0.0.0.0:${config.gateway.udpPort}`);
  log.info('Main', `  🔌 TCP 通信: 0.0.0.0:${config.gateway.tcpPort}`);
  log.info('Main', `  🌐 Web 配置: http://localhost:3000`);
  log.info('Main', `  🏠 HA 连接: ${IS_ADDON ? '(Supervisor 代理)' : config.ha.url}`);
  log.info('Main', `  📦 已启用设备: ${deviceManager.getDevices().length} 个`);
  log.info('Main', `  🏘  房间数: ${deviceManager.getRooms().length} 个`);
  log.info('Main', `  🏢 楼层数: ${deviceManager.getFloors().length} 个`);

  // 优雅退出
  const shutdown = () => {
    log.info('Main', '正在停止...');
    udpServer.stop();
    tcpServer.stop();
    haClient.disconnect();
    log.destroy();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * 守护进程包装：崩溃后自动重启
 */
async function daemonMain() {
  try {
    await main();
  } catch (err) {
    log.error('Main', '启动失败:', err.message || err);

    // 检查重启频率限制
    const now = Date.now();
    restartTimes = restartTimes.filter(t => now - t < RESTART_WINDOW_MS);

    if (restartTimes.length >= MAX_RESTARTS) {
      log.error('Main', `${RESTART_WINDOW_MS / 1000} 秒内崩溃 ${MAX_RESTARTS} 次，停止重启`);
      process.exit(1);
    }

    restartTimes.push(now);
    const delay = Math.min(5000 * restartTimes.length, 30000);
    log.warn('Main', `${delay / 1000} 秒后自动重启 (${restartTimes.length}/${MAX_RESTARTS})...`);

    setTimeout(() => daemonMain(), delay);
  }
}

// 全局未捕获异常处理
process.on('uncaughtException', (err) => {
  log.error('Main', '未捕获异常:', err.message);
  log.error('Main', err.stack || '');
});

process.on('unhandledRejection', (reason) => {
  log.error('Main', '未处理的 Promise 拒绝:', String(reason));
});

daemonMain();
