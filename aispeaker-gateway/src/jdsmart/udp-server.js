/**
 * UDP 发现服务 — 监听 6666，响应音箱的 REQUEST_TCP
 */

'use strict';

const dgram = require('dgram');
const log = require('../logger');

class UdpServer {
  /**
   * @param {object} opts
   * @param {string} opts.hostIp - 本机 IP
   * @param {number} opts.tcpPort - TCP 服务端口
   * @param {number} [opts.udpPort=6666] - UDP 监听端口
   * @param {number} [opts.broadcastInterval=30000] - 广播间隔(ms)
   */
  constructor({ hostIp, tcpPort, udpPort = 6666, broadcastInterval = 30000 }) {
    this.hostIp = hostIp;
    this.tcpPort = tcpPort;
    this.udpPort = udpPort;
    this.broadcastInterval = broadcastInterval;
    this.server = null;
    this._timer = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.server.on('error', (err) => {
        log.error('UDP', '服务错误:', err.message);
        reject(err);
      });

      this.server.on('message', (msg, rinfo) => {
        try {
          const data = JSON.parse(msg.toString('utf-8'));
          if (data.type === 'REQUEST_TCP' || data.Type === 'REQUEST_TCP') {
            const sn = data.sn || data.Sn || '';
            log.debug('UDP', `收到音箱发现请求 from ${rinfo.address}:${rinfo.port}, SN=${sn}`);
            this._sendResponse(rinfo.address);
          }
        } catch (e) {
          // 非 JSON 数据，忽略
        }
      });

      this.server.bind(this.udpPort, '0.0.0.0', () => {
        this.server.setBroadcast(true);
        log.info('UDP', `发现服务已启动，监听端口 ${this.udpPort}`);
        
        // 启动定时广播
        this._timer = setInterval(() => this._broadcastResponse(), this.broadcastInterval);
        
        resolve();
      });
    });
  }

  _buildResponse() {
    return JSON.stringify({
      Type: 'RESPONSE_TCP',
      Data: {
        Ip: this.hostIp,
        Port: String(this.tcpPort),
        Company: 'ha',
        ProtocolVersion: 'v2'
      }
    });
  }

  _sendResponse(speakerIp) {
    const resp = Buffer.from(this._buildResponse(), 'utf-8');
    // 单播给发包的音箱
    this.server.send(resp, 0, resp.length, 7777, speakerIp, (err) => {
      if (err) log.warn('UDP', '单播失败:', err.message);
    });
    // 广播备用
    try {
      this.server.send(resp, 0, resp.length, 7777, '255.255.255.255');
    } catch (e) { /* ignore */ }
  }

  _broadcastResponse() {
    if (!this.server) return;
    const resp = Buffer.from(this._buildResponse(), 'utf-8');
    try {
      this.server.send(resp, 0, resp.length, 7777, '255.255.255.255');
    } catch (e) {
      log.warn('UDP', '定时广播失败:', e.message);
    }
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

module.exports = UdpServer;
