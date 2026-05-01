/**
 * UDP 发现服务 — 监听 6666，响应音箱的 REQUEST_TCP
 */

'use strict';

const dgram = require('dgram');
const os = require('os');
const log = require('../logger');

/** 音响接收网关 UDP 广播/响应的固定端口 */
const SPEAKER_DISCOVERY_PORT = 7777;

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
        if (err.code === 'EADDRINUSE') {
          log.error('UDP', `UDP 端口 ${this.udpPort} 已被占用，常见原因是 localtuya 也会监听 UDP 6666/6667`);
          log.error('UDP', '声必可网关不可与 localtuya 共用同一个 UDP 监听端口；请停用 localtuya 发现或修改本网关 udp_port');
        }
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
        
        // 启动后立即广播一次，随后定时广播网关连接地址。
        this._broadcastResponse();
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
    this.server.send(resp, 0, resp.length, SPEAKER_DISCOVERY_PORT, speakerIp, (err) => {
      if (err) log.warn('UDP', '单播失败:', err.message);
    });
    // 广播备用
    this._sendBroadcast(resp, '发现响应广播');
  }

  _broadcastResponse() {
    if (!this.server) return;
    const resp = Buffer.from(this._buildResponse(), 'utf-8');
    this._sendBroadcast(resp, '定时广播');
  }

  _sendBroadcast(resp, label) {
    for (const target of this._getBroadcastTargets()) {
      this.server.send(resp, 0, resp.length, SPEAKER_DISCOVERY_PORT, target, (err) => {
        if (err) {
          log.warn('UDP', `${label}失败 ${target}:`, err.message);
        } else {
          log.debug('UDP', `${label}: ${this.hostIp}:${this.tcpPort} -> ${target}:${SPEAKER_DISCOVERY_PORT}`);
        }
      });
    }
  }

  _getBroadcastTargets() {
    const targets = new Set(['255.255.255.255']);
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const iface of ifaces || []) {
        const isIpv4 = iface.family === 'IPv4' || iface.family === 4;
        if (!isIpv4 || iface.internal || !iface.netmask) continue;
        const broadcast = calcBroadcastAddress(iface.address, iface.netmask);
        if (broadcast && broadcast !== iface.address) targets.add(broadcast);
      }
    }
    return [...targets];
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

function calcBroadcastAddress(address, netmask) {
  const ip = ipv4ToInt(address);
  const mask = ipv4ToInt(netmask);
  if (ip == null || mask == null) return null;
  return intToIpv4((ip | (~mask >>> 0)) >>> 0);
}

function ipv4ToInt(value) {
  const parts = String(value).split('.').map(n => Number(n));
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return parts.reduce((acc, part) => ((acc << 8) | part) >>> 0, 0);
}

function intToIpv4(value) {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255
  ].join('.');
}

module.exports = UdpServer;
