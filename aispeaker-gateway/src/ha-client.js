/**
 * Home Assistant WebSocket 客户端
 * 
 * 通过 WebSocket API 与 HA 通信：
 * - 获取所有实体状态
 * - 订阅状态变更事件
 * - 调用服务
 */

'use strict';

const WebSocket = require('ws');
const EventEmitter = require('events');
const log = require('./logger');

class HaClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.url - HA WebSocket URL (ws://host:8123/api/websocket)
   * @param {string} opts.token - 长期访问令牌
   */
  constructor({ url, token }) {
    super();
    this.url = url;
    this.token = token;
    this.ws = null;
    this._msgId = 0;
    this._pending = new Map(); // id -> { resolve, reject }
    this._connected = false;
    this._reconnectTimer = null;
    this._shouldReconnect = true;
  }

  get connected() {
    return this._connected;
  }

  /**
   * 连接并认证
   */
  connect() {
    return new Promise((resolve, reject) => {
      if (this._connected) return resolve();

      // 清理旧连接
      this._cleanup();

      log.info('HA', `正在连接 ${this.url}...`);
      this.ws = new WebSocket(this.url);
      let authResolved = false;

      this.ws.on('open', () => {
        log.debug('HA', 'WebSocket 已连接');
      });

      this.ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch (e) {
          return;
        }

        // 认证流程
        if (msg.type === 'auth_required') {
          this.ws.send(JSON.stringify({
            type: 'auth',
            access_token: this.token
          }));
          return;
        }

        if (msg.type === 'auth_ok') {
          log.info('HA', `认证成功, HA 版本: ${msg.ha_version}`);
          this._connected = true;
          if (!authResolved) {
            authResolved = true;
            resolve();
          }
          this.emit('connected');
          return;
        }

        if (msg.type === 'auth_invalid') {
          log.error('HA', '认证失败:', msg.message);
          if (!authResolved) {
            authResolved = true;
            reject(new Error('HA 认证失败: ' + msg.message));
          }
          return;
        }

        // 事件订阅回调
        if (msg.type === 'event' && msg.event) {
          this.emit('state_changed', msg.event);
          return;
        }

        // 请求响应
        if (msg.id && this._pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this._pending.get(msg.id);
          this._pending.delete(msg.id);
          if (msg.success === false) {
            rej(new Error(msg.error?.message || 'HA request failed'));
          } else {
            res(msg.result);
          }
        }
      });

      this.ws.on('close', () => {
        log.warn('HA', 'WebSocket 已断开');
        const wasConnected = this._connected;
        this._connected = false;
        // 拒绝所有等待中的请求
        this._rejectAllPending('HA 连接已断开');
        this.emit('disconnected');
        if (wasConnected) {
          this._scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        log.error('HA', 'WebSocket 错误:', err.message);
        if (!authResolved) {
          authResolved = true;
          reject(err);
        }
      });
    });
  }

  /**
   * 清理旧 WebSocket 连接（不触发重连）
   */
  _cleanup() {
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close();
        }
      } catch (e) { /* ignore */ }
      this.ws = null;
    }
  }

  /**
   * 拒绝所有等待中的请求
   */
  _rejectAllPending(reason) {
    for (const [id, { reject: rej }] of this._pending) {
      rej(new Error(reason));
    }
    this._pending.clear();
  }

  _scheduleReconnect() {
    if (!this._shouldReconnect) return;
    if (this._reconnectTimer) return;

    // 递增退避: 5s → 10s → 20s → 30s max
    this._reconnectAttempt = (this._reconnectAttempt || 0) + 1;
    const delay = Math.min(5000 * this._reconnectAttempt, 30000);
    log.info('HA', `${delay / 1000} 秒后重连 (第 ${this._reconnectAttempt} 次)...`);

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await this.connect();
        // 重连成功，重置计数器
        this._reconnectAttempt = 0;
        await this.subscribeStateChanges();
        log.info('HA', '重连成功，已重新订阅状态变更');
        this.emit('reconnected');
      } catch (e) {
        log.warn('HA', '重连失败:', e.message);
        // 失败后继续尝试重连
        this._scheduleReconnect();
      }
    }, delay);
  }

  /**
   * 发送请求并等待响应
   */
  _send(payload) {
    return new Promise((resolve, reject) => {
      if (!this._connected) {
        return reject(new Error('HA 未连接'));
      }
      const id = ++this._msgId;
      payload.id = id;
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));

      // 超时
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error('HA 请求超时'));
        }
      }, 10000);
    });
  }

  /**
   * 获取所有实体状态
   * @returns {Promise<Array>}
   */
  async getStates() {
    return this._send({ type: 'get_states' });
  }

  /**
   * 订阅状态变更事件
   */
  async subscribeStateChanges() {
    return this._send({
      type: 'subscribe_events',
      event_type: 'state_changed'
    });
  }

  /**
   * 调用 HA 服务
   * @param {string} domain
   * @param {string} service
   * @param {object} serviceData
   */
  async callService(domain, service, serviceData = {}) {
    return this._send({
      type: 'call_service',
      domain,
      service,
      service_data: serviceData
    });
  }

  disconnect() {
    this._shouldReconnect = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }
}

module.exports = HaClient;
