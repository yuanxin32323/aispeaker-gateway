/**
 * Web API 服务器 — 配置管理界面
 * 
 * 支持：
 * - 独立模式：直接访问 http://host:3000
 * - Add-on Ingress：通过 HA 侧边栏嵌入访问
 */

'use strict';

const express = require('express');
const path = require('path');
const { loadConfig, saveConfig, IS_ADDON } = require('../config');
const log = require('../logger');

class WebServer {
  /**
   * @param {object} opts
   * @param {number} opts.port
   * @param {import('../ha-client')} opts.haClient
   * @param {import('../device-manager')} opts.deviceManager
   * @param {import('../jdsmart/tcp-server')} opts.tcpServer
   * @param {function} opts.onConfigSaved - 配置保存后的回调
   */
  constructor({ port = 3000, haClient, deviceManager, tcpServer, onConfigSaved }) {
    this.port = port;
    this.ha = haClient;
    this.deviceManager = deviceManager;
    this.tcpServer = tcpServer;
    this.onConfigSaved = onConfigSaved;
    this.app = express();
    this._setupRoutes();
  }

  _setupRoutes() {
    this.app.use(express.json({ limit: '10mb' }));

    this.app.use((err, req, res, next) => {
      if (err?.type === 'entity.too.large') {
        log.warn('Web', '请求体过大，已拒绝保存配置');
        return res.status(413).json({ error: '配置数据过大，请减少一次保存的设备数量或联系开发者调整限制' });
      }
      next(err);
    });

    // Ingress 路径前缀中间件 — 去掉 ingress 前缀，让后续路由正常匹配
    this.app.use((req, res, next) => {
      // HA Ingress 会设置 X-Ingress-Path 头
      const ingressPath = req.headers['x-ingress-path'] || '';
      req.ingressPath = ingressPath;
      // 去掉 ingress 前缀后再匹配路由
      if (ingressPath && req.url.startsWith(ingressPath)) {
        req.url = req.url.substring(ingressPath.length) || '/';
      }
      next();
    });

    // 静态文件
    this.app.use(express.static(path.join(__dirname, 'public')));

    // 获取配置
    this.app.get('/api/config', (req, res) => {
      const config = loadConfig();
      // 不暴露 Token 到前端
      const safe = { ...config, ha: { ...config.ha, token: config.ha.token ? '***' : '' } };
      safe.isAddon = IS_ADDON;
      res.json(safe);
    });

    // 保存配置
    this.app.put('/api/config', (req, res) => {
      try {
        const body = req.body;
        const current = loadConfig();
        // Add-on 模式下不允许修改 HA 连接信息
        if (IS_ADDON) {
          body.ha = current.ha;
        } else if (body.ha?.token === '***') {
          // 前端读取到的是脱敏 token，保存非 HA 设置时保留原 token。
          body.ha.token = current.ha.token;
        }
        saveConfig(body);
        if (this.onConfigSaved) {
          this.onConfigSaved(body);
        }
        log.info('Web', '配置已保存');
        res.json({ success: true });
      } catch (e) {
        log.error('Web', '保存配置失败:', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // 从 HA 拉取所有实体
    this.app.get('/api/ha/entities', async (req, res) => {
      try {
        if (!this.ha.connected) {
          return res.status(503).json({ error: 'HA 未连接' });
        }
        const states = await this.ha.getStates();
        // 只返回支持的域
        const supported = ['light', 'switch', 'cover', 'climate', 'fan', 'sensor', 'binary_sensor', 'scene', 'script'];
        const filtered = states
          .filter(s => supported.includes(s.entity_id.split('.')[0]))
          .map(s => ({
            entity_id: s.entity_id,
            friendly_name: s.attributes?.friendly_name || s.entity_id,
            domain: s.entity_id.split('.')[0],
            state: s.state
          }));
        res.json(filtered);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // 网关状态
    this.app.get('/api/status', (req, res) => {
      res.json({
        haConnected: this.ha.connected,
        speakerClients: this.tcpServer ? this.tcpServer.clients.size : 0,
        cachedEntities: this.deviceManager ? this.deviceManager.stateCache.size : 0,
        enabledDevices: this.deviceManager ? this.deviceManager.getDevices().length : 0,
        rooms: this.deviceManager ? this.deviceManager.getRooms().length : 0,
        floors: this.deviceManager ? this.deviceManager.getFloors().length : 0,
        isAddon: IS_ADDON
      });
    });

    // 日志查看
    this.app.get('/api/logs', (req, res) => {
      const count = parseInt(req.query.count) || 100;
      res.json(log.getRecentLogs(count));
    });
  }

  start() {
    return new Promise((resolve) => {
      this.app.listen(this.port, () => {
        log.info('Web', `配置界面已启动: http://localhost:${this.port}`);
        resolve();
      });
    });
  }
}

module.exports = WebServer;
