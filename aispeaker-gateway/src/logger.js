/**
 * 日志模块 — 统一日志输出 + 大小限制
 *
 * 特性：
 * - 日志级别：debug / info / warn / error
 * - 内存日志环形缓冲区（最近 2000 条，供 Web 查看）
 * - 输出到 stdout/stderr（Add-on 模式下由 Supervisor 采集）
 * - 可选文件输出（独立模式，自动按大小轮转）
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_LABELS = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' };

/** 环形缓冲区最大条数 */
const RING_BUFFER_SIZE = 2000;

/** 日志文件最大字节数 (5MB) */
const MAX_LOG_FILE_SIZE = 5 * 1024 * 1024;

/** 保留的旧日志文件数 */
const MAX_LOG_FILES = 2;

class Logger {
  constructor({ level = 'info', logFile = null } = {}) {
    this.level = LEVELS[level] ?? LEVELS.info;
    this.logFile = logFile;
    this._ring = [];
    this._stream = null;
    this._currentSize = 0;

    if (this.logFile) {
      this._openStream();
    }
  }

  setLevel(level) {
    this.level = LEVELS[level] ?? LEVELS.info;
  }

  _openStream() {
    try {
      // 获取当前文件大小
      if (fs.existsSync(this.logFile)) {
        this._currentSize = fs.statSync(this.logFile).size;
      } else {
        this._currentSize = 0;
      }
      this._stream = fs.createWriteStream(this.logFile, { flags: 'a' });
      this._stream.on('error', () => {
        this._stream = null;
      });
    } catch (e) {
      this._stream = null;
    }
  }

  _rotate() {
    if (!this.logFile || !this._stream) return;

    this._stream.end();
    this._stream = null;

    // 轮转: log.2 → 删除, log.1 → log.2, log → log.1
    for (let i = MAX_LOG_FILES; i >= 1; i--) {
      const from = i === 1 ? this.logFile : `${this.logFile}.${i - 1}`;
      const to = `${this.logFile}.${i}`;
      try {
        if (i === MAX_LOG_FILES && fs.existsSync(to)) {
          fs.unlinkSync(to);
        }
        if (fs.existsSync(from)) {
          fs.renameSync(from, to);
        }
      } catch (e) { /* ignore */ }
    }

    this._openStream();
  }

  _format(level, tag, msg, args) {
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const label = LEVEL_LABELS[level] || 'INF';
    const extra = args.length > 0
      ? ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
      : '';
    return `${ts} [${label}] [${tag}] ${msg}${extra}`;
  }

  _log(level, tag, msg, args) {
    if (LEVELS[level] < this.level) return;

    const line = this._format(level, tag, msg, args);

    // 环形缓冲区
    this._ring.push(line);
    if (this._ring.length > RING_BUFFER_SIZE) {
      this._ring.shift();
    }

    // 控制台输出
    if (level === 'error') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }

    // 文件输出
    if (this._stream) {
      const bytes = Buffer.byteLength(line + '\n', 'utf-8');
      this._currentSize += bytes;
      this._stream.write(line + '\n');

      if (this._currentSize >= MAX_LOG_FILE_SIZE) {
        this._rotate();
      }
    }
  }

  debug(tag, msg, ...args) { this._log('debug', tag, msg, args); }
  info(tag, msg, ...args)  { this._log('info', tag, msg, args); }
  warn(tag, msg, ...args)  { this._log('warn', tag, msg, args); }
  error(tag, msg, ...args) { this._log('error', tag, msg, args); }

  /** 获取最近的日志（供 Web API 使用） */
  getRecentLogs(count = 100) {
    return this._ring.slice(-count);
  }

  destroy() {
    if (this._stream) {
      this._stream.end();
      this._stream = null;
    }
  }
}

// 单例
const logger = new Logger();

module.exports = logger;
