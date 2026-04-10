/**
 * TCP 通信服务端 — 处理声必可协议指令
 */

'use strict';

const net = require('net');
const { buildPackage, parseBuffer } = require('./protocol');

/** 每个包之间的最小发送间隔(ms)，防止音箱端粘包 */
const WRITE_INTERVAL_MS = 100;

class TcpServer {
  /**
   * @param {object} opts
   * @param {number} opts.port - TCP 端口
   * @param {import('../device-manager')} opts.deviceManager
   */
  constructor({ port, deviceManager }) {
    this.port = port;
    this.deviceManager = deviceManager;
    this.server = null;
    /** @type {Map<net.Socket, { queue: Buffer[], flushTimer: any, lastWriteTime: number }>} */
    this.clients = new Map();
  }

  /** 兼容旧的 clients.size 访问 */
  get clientCount() {
    return this.clients.size;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this._onConnection(socket));

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[TCP] ❌ 端口 ${this.port} 已被占用！请检查是否有其他程序（如 HA 集成）在使用此端口`);
          console.error('[TCP] 提示: 可修改 config.json 中的 gateway.tcpPort 换一个端口');
        }
        reject(err);
      });

      this.server.listen(this.port, '0.0.0.0', () => {
        console.log(`[TCP] 服务已启动，监听端口 ${this.port}`);
        resolve();
      });
    });
  }

  _onConnection(socket) {
    const addr = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[TCP] 客户端已连接: ${addr}`);
    this.clients.set(socket, { queue: [], flushTimer: null, lastWriteTime: 0 });

    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { packets, remaining } = parseBuffer(buffer);
      buffer = remaining;

      for (const pkt of packets) {
        this._handleMessage(socket, pkt.cmd, pkt.data);
      }
    });

    socket.on('close', () => {
      console.log(`[TCP] 客户端已断开: ${addr}`);
      const cs = this.clients.get(socket);
      if (cs && cs.flushTimer) clearTimeout(cs.flushTimer);
      this.clients.delete(socket);
    });

    socket.on('error', (err) => {
      console.warn(`[TCP] 连接错误 ${addr}:`, err.message);
      const cs = this.clients.get(socket);
      if (cs && cs.flushTimer) clearTimeout(cs.flushTimer);
      this.clients.delete(socket);
    });
  }

  /**
   * 排队写入数据到客户端（保证最小间隔，防粘包）
   * @param {net.Socket} socket
   * @param {Buffer} data
   */
  _enqueueWrite(socket, data) {
    const cs = this.clients.get(socket);
    if (!cs || socket.destroyed) return;

    cs.queue.push(data);
    this._scheduleFlush(socket);
  }

  /**
   * 调度下一次写入：基于上次写入时间计算延迟
   */
  _scheduleFlush(socket) {
    const cs = this.clients.get(socket);
    if (!cs || cs.flushTimer || cs.queue.length === 0) return;

    const now = Date.now();
    const elapsed = now - cs.lastWriteTime;
    const delay = elapsed >= WRITE_INTERVAL_MS ? 0 : WRITE_INTERVAL_MS - elapsed;

    cs.flushTimer = setTimeout(() => {
      cs.flushTimer = null;
      this._doFlush(socket);
    }, delay);
  }

  /**
   * 执行一次写入，然后调度下一次
   */
  _doFlush(socket) {
    const cs = this.clients.get(socket);
    if (!cs || cs.queue.length === 0 || socket.destroyed) return;

    const data = cs.queue.shift();
    try {
      socket.write(data);
      cs.lastWriteTime = Date.now();
    } catch (e) {
      // socket 已断开，忽略
      return;
    }

    // 队列中还有数据则继续调度
    if (cs.queue.length > 0) {
      this._scheduleFlush(socket);
    }
  }

  async _handleMessage(socket, cmd, data) {
    const msgType = data.Type || data.type;

    if (msgType === 'REQUEST_HEART_BEAT') {
      const resp = buildPackage('0002', { type: 'RESPONSE_HEART_BEAT' });
      socket.write(resp); // 心跳直接写，不排队
      return;
    }

    console.log(`[TCP] 收到: ${msgType} (cmd=${cmd})`);

    if (msgType === 'REQUEST_DEVICE') {
      const devices = this.deviceManager.getDevices();
      console.log(`[TCP] 返回设备列表: ${devices.length} 个`);
      const resp = buildPackage('0006', {
        type: 'RESPONSE_DEVICE',
        deviceData: devices
      });
      socket.write(resp);

    } else if (msgType === 'REQUEST_ROOM') {
      const rooms = this.deviceManager.getRooms();
      console.log(`[TCP] 返回房间列表: ${rooms.length} 个`, rooms);
      const resp = buildPackage('000a', {
        type: 'RESPONSE_ROOM',
        data: rooms
      });
      socket.write(resp);

    } else if (msgType === 'REQUEST_FLOOR') {
      const resp = buildPackage('000c', {
        type: 'RESPONSE_FLOOR',
        data: [{ id: 101, name: '默认楼层' }]
      });
      socket.write(resp);

    } else if (msgType === 'REQUEST_SCENE') {
      const scenes = this.deviceManager.getScenes();
      const resp = buildPackage('0008', {
        type: 'RESPONSE_SCENE',
        data: scenes
      });
      socket.write(resp);

    } else if (msgType === 'REQUEST_CONTROL') {
      console.log('[TCP] 收到控制指令:', JSON.stringify(data));
      const results = await this.deviceManager.handleControl(data);
      console.log('[TCP] 控制结果:', JSON.stringify(results));

      // 为每个受控设备排队发送独立的响应
      for (const result of results) {
        const resp = buildPackage('0004', {
          type: 'RESPONSE_CONTROL',
          code: 0,
          msg: '',
          msgVoice: '',
          deviceId: result.entityId || '',
          deviceState: result.deviceState || {}
        });
        this._enqueueWrite(socket, resp);
      }

      // 如果没有任何设备被控制，仍然返回一个空响应
      if (results.length === 0) {
        const resp = buildPackage('0004', {
          type: 'RESPONSE_CONTROL',
          code: 0,
          msg: '',
          msgVoice: '',
          deviceId: '',
          deviceState: {}
        });
        socket.write(resp);
      }
    }
  }

  /**
   * 向所有已连接的音箱推送状态更新（排队发送，防粘包）
   * @param {string} entityId
   * @param {object} deviceState
   */
  pushStateUpdate(entityId, deviceState) {
    if (this.clients.size === 0) return;

    const resp = buildPackage('0004', {
      type: 'RESPONSE_CONTROL',
      code: 0,
      msg: '',
      msgVoice: '',
      deviceId: entityId,
      deviceState
    });

    for (const [client] of this.clients) {
      if (!client.destroyed) {
        this._enqueueWrite(client, resp);
      }
    }
  }

  stop() {
    for (const [client] of this.clients) {
      try { client.destroy(); } catch (e) { /* ignore */ }
    }
    this.clients.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

module.exports = TcpServer;

