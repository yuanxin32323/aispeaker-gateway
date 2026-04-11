/**
 * 配置管理 — 双模式：Add-on / 独立部署
 *
 * Add-on 模式 (SUPERVISOR_TOKEN 存在):
 *   - HA 地址: ws://supervisor/core/websocket
 *   - HA Token: 自动从环境变量获取
 *   - 数据目录: /data/
 *   - 端口配置: 从 /data/options.json 读取
 *
 * 独立模式:
 *   - 从项目根目录 config.json 读取所有配置
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** 判断是否运行在 Add-on 环境 */
const IS_ADDON = !!process.env.SUPERVISOR_TOKEN;

/** 配置文件路径 */
const CONFIG_PATH = IS_ADDON
  ? '/data/config.json'
  : path.join(__dirname, '..', 'config.json');

const DEFAULT_CONFIG = {
  ha: {
    url: 'ws://192.168.1.100:8123/api/websocket',
    token: ''
  },
  gateway: {
    ip: '',
    tcpPort: 8888,
    udpPort: 6666
  },
  rooms: [
    { id: 1, name: '默认房间' }
  ],
  entities: {},
  filterMode: 'include' // include = 白名单, exclude = 黑名单
};

/**
 * 加载 Add-on 选项 (/data/options.json)
 * @returns {object|null}
 */
function loadAddonOptions() {
  try {
    if (fs.existsSync('/data/options.json')) {
      const raw = fs.readFileSync('/data/options.json', 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    // ignore
  }
  return null;
}

/**
 * 加载配置（不存在则创建默认配置）
 * @returns {object}
 */
function loadConfig() {
  let config;

  if (!fs.existsSync(CONFIG_PATH)) {
    // 自动检测本机 IP
    const detectedIp = detectLocalIp();
    config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    config.gateway.ip = detectedIp;
    saveConfig(config);
    console.log(`[Config] 已创建默认配置文件: ${CONFIG_PATH}`);
  } else {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      config = JSON.parse(raw);
      // 合并默认值（防止字段缺失）
      config = deepMerge(DEFAULT_CONFIG, config);
    } catch (e) {
      console.error('[Config] 配置文件解析失败:', e.message);
      config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
  }

  // Add-on 模式：强制覆盖 HA 连接参数
  if (IS_ADDON) {
    config.ha.url = 'ws://supervisor/core/websocket';
    config.ha.token = process.env.SUPERVISOR_TOKEN;

    // 从 Add-on options 读取端口配置
    const opts = loadAddonOptions();
    if (opts) {
      if (opts.tcp_port) config.gateway.tcpPort = opts.tcp_port;
      if (opts.udp_port) config.gateway.udpPort = opts.udp_port;
      if (opts.log_level) config.logLevel = opts.log_level;
    }

    // 环境变量备选（run.sh 设置）
    if (process.env.TCP_PORT) config.gateway.tcpPort = parseInt(process.env.TCP_PORT);
    if (process.env.UDP_PORT) config.gateway.udpPort = parseInt(process.env.UDP_PORT);
    if (process.env.LOG_LEVEL) config.logLevel = process.env.LOG_LEVEL;

    // 自动检测 IP（容器内）
    if (!config.gateway.ip) {
      config.gateway.ip = detectLocalIp();
    }
  }

  return config;
}

/**
 * 保存配置
 * @param {object} config
 */
function saveConfig(config) {
  // 保存时不写入自动生成的 HA 连接信息（Add-on 模式下）
  const toSave = { ...config };
  if (IS_ADDON) {
    // token 不持久化，每次从环境变量获取
    toSave.ha = { url: config.ha.url, token: '(managed by addon)' };
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2), 'utf-8');
}

/**
 * 检测本机局域网 IP
 */
function detectLocalIp() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '192.168.0.1';
}

/**
 * 深度合并对象（source 中有的字段覆盖 target）
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

module.exports = { loadConfig, saveConfig, detectLocalIp, CONFIG_PATH, IS_ADDON };
