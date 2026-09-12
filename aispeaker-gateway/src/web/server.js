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
const auth = require('../auth');

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
    this.app.post('/api/login', (req,res)=>{ const r=auth.login(req.body?.username,req.body?.password); if(!r)return res.status(401).json({error:'账号或密码错误'}); res.setHeader('Set-Cookie',`sbk_session=${r.t}; HttpOnly; SameSite=Lax; Path=/`); res.json({success:true,mustChange:r.mustChange}); });
    this.app.post('/api/logout', (req,res)=>{ res.setHeader('Set-Cookie','sbk_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/'); res.json({success:true}); });
    this.app.post('/api/change-password',(req,res)=>{ const s=auth.auth(req); if(!s)return res.status(401).json({error:'未登录'}); if(!auth.change(req.body?.oldPassword,req.body?.newPassword,s))return res.status(400).json({error:'旧密码错误或新密码至少 8 位'}); res.json({success:true}); });
    this.app.use((req,res,next)=>{ if(req.path==='/api/login'||req.path==='/api/status')return next(); const s=auth.auth(req); if(!s)return req.path.startsWith('/api/')?res.status(401).json({error:'未登录'}):res.status(401).send(`<!doctype html><meta charset="utf-8"><title>声必可网关登录</title><style>body{font:16px sans-serif;max-width:380px;margin:12vh auto;padding:20px}input,button{display:block;width:100%;box-sizing:border-box;padding:12px;margin:10px 0}button{cursor:pointer;background:#0b6174;color:white;border:0;border-radius:6px}small{color:#667}</style><h2>声必可网关</h2><form onsubmit="go(event)"><label>账号<input id="u" value="admin" autocomplete="username"></label><label>密码<input id="p" type="password" autocomplete="current-password"></label><button>登录</button></form><p id="m"></p><script>async function go(e){e.preventDefault();let r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u.value,password:p.value})});let x=await r.json();if(!r.ok)return m.textContent=x.error;location.href=x.mustChange?'/change-password':'/';}</script>`); if(s.mustChange&&req.path!=='/api/change-password'&&req.path!=='/change-password')return req.path.startsWith('/api/')?res.status(403).json({error:'首次登录必须修改密码'}):res.redirect('/change-password'); next(); });
    this.app.get('/change-password',(req,res)=>{ if(!auth.auth(req))return res.redirect('/'); res.send(`<!doctype html><meta charset="utf-8"><title>设置密码</title><style>body{font:16px sans-serif;max-width:420px;margin:10vh auto;padding:20px}input,button{display:block;width:100%;box-sizing:border-box;padding:12px;margin:10px 0}button{background:#0b6174;color:#fff;border:0;border-radius:6px}#m{color:#b44}</style><h2>首次设置密码</h2><p>为了保护配置页面，请先设置新密码。</p><form onsubmit="go(event)"><input id="o" type="password" placeholder="当前密码" required><input id="n" type="password" placeholder="新密码（至少8位，含字母和数字）" required><input id="c" type="password" placeholder="确认新密码" required><button>保存新密码</button></form><p id="m"></p><script>async function go(e){e.preventDefault();if(n.value!==c.value)return m.textContent='两次新密码不一致';if(n.value.length<8||!/[A-Za-z]/.test(n.value)||!/\\d/.test(n.value))return m.textContent='新密码至少8位，且包含字母和数字';let r=await fetch('/api/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({oldPassword:o.value,newPassword:n.value})});let x=await r.json();if(!r.ok)return m.textContent=x.error;location.href='/';}</script>`); });

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
