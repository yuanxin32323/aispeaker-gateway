/**
 * 声必可 JdSmart V2 协议编解码
 * 
 * V2 协议格式:
 * | 0xAB | 3字节长度 | 2字节命令 | JSON数据 | 1字节校验 |
 * 
 * 校验算法: 长度+命令+数据 所有字节异或
 */

'use strict';

/**
 * 构建 V2 协议数据包
 * @param {string} cmdHex - 2字节命令码 (如 "0006")
 * @param {object} data - JSON 数据对象
 * @returns {Buffer}
 */
function buildPackage(cmdHex, data) {
  const jsonStr = JSON.stringify(data);
  const jsonBuf = Buffer.from(jsonStr, 'utf-8');
  const length = jsonBuf.length;

  if (length > 0xFFFFFF) {
    throw new Error('Data too long for V2 protocol');
  }

  // 3字节长度 (大端)
  const lenBuf = Buffer.alloc(3);
  lenBuf.writeUIntBE(length, 0, 3);

  // 2字节命令
  const cmdBuf = Buffer.from(cmdHex, 'hex');

  // payload = 长度 + 命令 + JSON
  const payload = Buffer.concat([lenBuf, cmdBuf, jsonBuf]);

  // 校验和: 所有 payload 字节异或
  let checksum = 0;
  for (let i = 0; i < payload.length; i++) {
    checksum ^= payload[i];
  }

  // 最终包: 0xAB + payload + checksum
  return Buffer.concat([
    Buffer.from([0xAB]),
    payload,
    Buffer.from([checksum & 0xFF])
  ]);
}

/**
 * 从缓冲区解析数据包（处理粘包/拆包）
 * @param {Buffer} buffer - 累积的接收缓冲区
 * @returns {{ packets: Array<{cmd: string, data: object}>, remaining: Buffer }}
 */
function parseBuffer(buffer) {
  const packets = [];
  let offset = 0;

  while (offset < buffer.length) {
    // 查找 0xAB 包头
    const headIdx = buffer.indexOf(0xAB, offset);
    if (headIdx === -1) {
      // 没有包头，丢弃全部
      offset = buffer.length;
      break;
    }
    offset = headIdx;

    // 至少需要 7 字节: head(1) + len(3) + cmd(2) + checksum(1)
    if (buffer.length - offset < 7) {
      break; // 等待更多数据
    }

    // 读取长度 (3字节大端)
    const length = buffer.readUIntBE(offset + 1, 3);
    const totalLen = 1 + 3 + 2 + length + 1; // head + len + cmd + data + checksum

    if (buffer.length - offset < totalLen) {
      break; // 包不完整，等待更多数据
    }

    const packet = buffer.slice(offset, offset + totalLen);

    // 校验和验证
    let expectedCheck = 0;
    for (let i = 1; i < packet.length - 1; i++) {
      expectedCheck ^= packet[i];
    }

    if (expectedCheck !== packet[packet.length - 1]) {
      console.warn('[protocol] 数据包校验和错误');
      offset += 1; // 跳过这个 0xAB，继续搜索
      continue;
    }

    // 提取命令码和 JSON
    const cmd = packet.slice(4, 6).toString('hex');
    const jsonBuf = packet.slice(6, 6 + length);

    try {
      const data = JSON.parse(jsonBuf.toString('utf-8'));
      packets.push({ cmd, data });
    } catch (e) {
      console.error('[protocol] JSON 解析失败:', e.message);
    }

    offset += totalLen;
  }

  return {
    packets,
    remaining: buffer.slice(offset)
  };
}

module.exports = { buildPackage, parseBuffer };
