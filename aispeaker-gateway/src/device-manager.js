/**
 * 设备管理器 — HA 实体 ↔ 声必可设备 桥接层
 *
 * 职责：
 * - 维护 HA 实体状态缓存
 * - 根据配置过滤/映射设备
 * - 处理控制指令 → 调 HA 服务
 * - HA 状态变化 → 转换后推送
 */

'use strict';

const log = require('./logger');

// 声必可设备类型常量
const DEV_TYPES = {
  CW_LAMP: 'CW_LAMP',
  LIGHT: 'LIGHT',
  SWITCH: 'SWITCH',
  CURTAIN: 'ADJUST_CURTAIN',
  AIRCONDITION: 'AIR_CONDITION',
  FAN: 'FAN',
  SENSOR: 'DEVICE_TYPE_MULTIFUNCTIONAL_SENSOR'
};

// HA domain → 声必可设备类型
const DOMAIN_MAP = {
  light: DEV_TYPES.LIGHT,
  switch: DEV_TYPES.SWITCH,
  cover: DEV_TYPES.CURTAIN,
  climate: DEV_TYPES.AIRCONDITION,
  fan: DEV_TYPES.FAN,
  sensor: DEV_TYPES.SENSOR,
  binary_sensor: DEV_TYPES.SENSOR
};

const SUPPORTED_DOMAINS = ['light', 'switch', 'cover', 'climate', 'fan', 'sensor', 'binary_sensor', 'scene', 'script'];

// HVAC 模式映射
const HVAC_TO_JDSMART = {
  off: { order: 'STATE_OFF', mode: 'MODE_COOL' },
  heat: { order: 'STATE_ON', mode: 'MODE_HEAT' },
  cool: { order: 'STATE_ON', mode: 'MODE_COOL' },
  dry: { order: 'STATE_ON', mode: 'MODE_DRY' },
  fan_only: { order: 'STATE_ON', mode: 'MODE_FAN' },
  auto: { order: 'STATE_ON', mode: 'MODE_AUTO' },
  heat_cool: { order: 'STATE_ON', mode: 'MODE_AUTO' }
};

const JDSMART_TO_HVAC = {
  MODE_COOL: 'cool',
  MODE_HEAT: 'heat',
  MODE_DRY: 'dry',
  MODE_FAN: 'fan_only',
  MODE_FAN_ONLY: 'fan_only',
  MODE_AUTO: 'auto'
};

const FAN_MODE_MAP = {
  low: 'MODE_WIND_LOW',
  medium: 'MODE_WIND_MID',
  high: 'MODE_WIND_HIGH',
  auto: 'MODE_WIND_AUTO'
};

const FAN_MODE_REVERSE = {
  MODE_WIND_LOW: 'low',
  MODE_WIND_MID: 'medium',
  MODE_WIND_HIGH: 'high',
  MODE_WIND_AUTO: 'auto',
  MODE_WIND_MUTE: 'auto',
  MODE_WIND_SLEEP: 'auto'
};

class DeviceManager {
  /**
   * @param {object} opts
   * @param {import('./ha-client')} opts.haClient
   * @param {object} opts.config - 完整配置对象
   * @param {function} opts.onPushState - 状态推送回调 (entityId, deviceState)
   */
  constructor({ haClient, config, onPushState }) {
    this.ha = haClient;
    this.config = config;
    this.onPushState = onPushState;
    /** @type {Map<string, object>} entityId -> HA state object */
    this.stateCache = new Map();
  }

  /**
   * 初始化：拉取所有状态 + 订阅变更
   */
  async init() {
    await this._fetchAllStates();
    await this.ha.subscribeStateChanges();

    // 状态变更监听（只注册一次，跨重连持续有效）
    this.ha.on('state_changed', (event) => {
      const data = event.data;
      if (!data) return;
      const entityId = data.entity_id;
      const newState = data.new_state;

      if (newState) {
        this.stateCache.set(entityId, newState);
      }

      // 只推送白名单内的设备
      if (!this._isEntityEnabled(entityId)) return;
      const domain = entityId.split('.')[0];
      if (domain === 'scene' || domain === 'script') return;
      if (!DOMAIN_MAP[domain]) return;

      if (newState) {
        const deviceState = this._entityToDeviceState(entityId, newState);
        log.debug('DeviceManager', `状态变更推送: ${entityId}`, deviceState);
        if (this.onPushState) {
          this.onPushState(entityId, deviceState);
        }
      }
    });

    // 重连后自动刷新全量状态缓存（订阅已在 ha-client 内部完成）
    this.ha.on('reconnected', async () => {
      log.debug('DeviceManager', 'HA 已重连，刷新全量状态缓存...');
      await this._fetchAllStates();
    });
  }

  /**
   * 从 HA 拉取并缓存所有实体状态
   */
  async _fetchAllStates() {
    try {
      const states = await this.ha.getStates();
      for (const s of states) {
        this.stateCache.set(s.entity_id, s);
      }
      log.info('DeviceManager', `已缓存 ${this.stateCache.size} 个实体状态`);
    } catch (e) {
      log.error('DeviceManager', '拉取状态失败:', e.message);
    }
  }

  /**
   * 热重载配置
   */
  updateConfig(config) {
    this.config = config;
  }

  // ─── 实体过滤 ─────────────────────────────────────────

  _isEntityEnabled(entityId) {
    const entitiesConfig = this.config.entities || {};
    const filterMode = this.config.filterMode || 'include';

    if (filterMode === 'include') {
      // 白名单模式：只有明确标记 enabled 的才通过
      const ec = entitiesConfig[entityId];
      return ec && ec.enabled === true;
    } else {
      // 黑名单模式：未被明确禁用则通过
      const ec = entitiesConfig[entityId];
      return !ec || ec.enabled !== false;
    }
  }

  // ─── 设备列表 ─────────────────────────────────────────

  getDevices() {
    const devices = [];

    for (const [entityId, state] of this.stateCache) {
      const domain = entityId.split('.')[0];
      if (domain === 'scene' || domain === 'script') continue;
      if (!DOMAIN_MAP[domain]) continue;
      if (!this._isEntityEnabled(entityId)) continue;

      const entityConfig = (this.config.entities || {})[entityId] || {};
      const name = entityConfig.alias || state.attributes?.friendly_name || entityId;
      const roomId = entityConfig.roomId || 1;
      const floorId = entityConfig.floorId || this._getDefaultFloorId();

      let devType = DOMAIN_MAP[domain];
      const modeAttrs = [];
      const speedAttrs = [];

      // 灯类型细分
      if (domain === 'light') {
        const colorModes = state.attributes?.supported_color_modes || [];
        if (colorModes.includes('color_temp')) {
          devType = DEV_TYPES.CW_LAMP;
        }
      }

      // 空调属性
      if (domain === 'climate') {
        modeAttrs.push('cold', 'heat', 'airsupply', 'dehumidification', 'auto', 'manual');
        speedAttrs.push('low', 'medium', 'high', 'autoWind');
      }

      const deviceState = this._entityToDeviceState(entityId, state);

      const entry = {
        deviceId: entityId,
        deviceName: name,
        deviceType: devType,
        roomId,
        floorId,
        state: deviceState,
        modeAttributes: modeAttrs
      };

      if (speedAttrs.length > 0) {
        entry.speedAttributes = speedAttrs;
      }

      devices.push(entry);
    }

    return devices;
  }

  getRooms() {
    return Array.isArray(this.config.rooms) && this.config.rooms.length > 0
      ? this.config.rooms
      : [{ id: 1, name: '默认房间' }];
  }

  getFloors() {
    return Array.isArray(this.config.floors) && this.config.floors.length > 0
      ? this.config.floors
      : [{ id: 101, name: '默认楼层' }];
  }

  _getDefaultFloorId() {
    const floors = this.getFloors();
    return floors[0]?.id || 101;
  }

  getScenes() {
    const scenes = [];
    for (const [entityId, state] of this.stateCache) {
      const domain = entityId.split('.')[0];
      if (domain !== 'scene' && domain !== 'script') continue;
      if (!this._isEntityEnabled(entityId)) continue;

      const entityConfig = (this.config.entities || {})[entityId] || {};
      const name = entityConfig.alias || state.attributes?.friendly_name || entityId;
      scenes.push({
        id: entityId,
        name,
        aliasList: []
      });
    }
    return scenes;
  }

  // ─── 状态转换 HA → 声必可 ────────────────────────────

  _entityToDeviceState(entityId, state) {
    const domain = entityId.split('.')[0];
    const result = {};
    const attrs = state.attributes || {};

    if (domain === 'light') {
      result.order = state.state === 'on' ? 'STATE_ON' : 'STATE_OFF';
      if (attrs.brightness != null) {
        result.brightness = String(Math.round(attrs.brightness / 255 * 100));
      }
      if (attrs.color_temp_kelvin != null) {
        result.colorTemp = String(Math.round(Math.max(0, (attrs.color_temp_kelvin - 2000)) / 4500 * 100));
      }
      if (attrs.rgb_color) {
        const [r, g, b] = attrs.rgb_color;
        result.color = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
      }
    } else if (domain === 'switch') {
      result.order = state.state === 'on' ? 'STATE_ON' : 'STATE_OFF';
    } else if (domain === 'cover') {
      result.order = state.state === 'open' ? 'STATE_ON' : 'STATE_OFF';
      if (attrs.current_position != null) {
        result.position = String(attrs.current_position);
      }
    } else if (domain === 'climate') {
      if (attrs.temperature != null) {
        result.temperature = String(attrs.temperature);
      }
      const hvac = HVAC_TO_JDSMART[state.state] || { order: 'STATE_OFF', mode: 'MODE_COOL' };
      result.order = hvac.order;
      result.mode = hvac.mode;
      if (attrs.fan_mode && FAN_MODE_MAP[attrs.fan_mode]) {
        result.fanSpeed = FAN_MODE_MAP[attrs.fan_mode];
      }
      if (attrs.swing_mode) {
        result.fanDirection = attrs.swing_mode === 'off' ? 'MODE_SWING_NO' : 'MODE_SWING_UP_DOWN';
      }
    } else if (domain === 'fan') {
      result.order = state.state === 'on' ? 'STATE_ON' : 'STATE_OFF';
      const pct = attrs.percentage;
      if (pct != null) {
        if (pct === 0) result.fanSpeed = 'MODE_WIND_AUTO';
        else if (pct <= 33) result.fanSpeed = 'MODE_WIND_LOW';
        else if (pct <= 66) result.fanSpeed = 'MODE_WIND_MID';
        else result.fanSpeed = 'MODE_WIND_HIGH';
      }
    } else if (domain === 'sensor') {
      const dc = attrs.device_class;
      if (dc === 'temperature') {
        result.temperature = String(state.state);
      } else if (dc === 'humidity') {
        result.humidity = String(state.state);
      } else {
        const unit = attrs.unit_of_measurement || '';
        result.universalSensorData = JSON.stringify([
          { key: attrs.friendly_name || '状态', value: `${state.state}${unit}` }
        ]);
      }
    } else if (domain === 'binary_sensor') {
      result.sensorStatus = state.state === 'on' ? '1' : '0';
    }

    return result;
  }

  // ─── 控制指令处理 ─────────────────────────────────────

  async handleControl(data) {
    const controls = data.data || data.Data || [];
    const results = [];

    for (const ctrl of controls) {
      const entityId = ctrl.id || ctrl.Id;
      if (!entityId) continue;
      if (!this._isEntityEnabled(entityId)) {
        log.warn('DeviceManager', `拒绝控制未授权实体: ${entityId}`);
        continue;
      }

      const domain = entityId.split('.')[0];
      const action = ctrl.action || ctrl.Action || '';
      const stateVal = ctrl.state || ctrl.State || '';
      const attr = ctrl.attribute || ctrl.Attribute || '';
      const attrVal = ctrl.attributeValue || ctrl.AttributeValue || '';
      const mode = ctrl.mode || ctrl.Mode || '';

      // 场景/脚本直接触发
      if (domain === 'scene' || domain === 'script') {
        await this.ha.callService(domain, 'turn_on', { entity_id: entityId });
        results.push({ entityId, deviceState: {} });
        continue;
      }

      let svcDomain = domain;
      let svcName = 'turn_on';
      let svcData = { entity_id: entityId };
      let callSvc = false;

      // 开关控制
      if (stateVal === 'STATE_OFF') {
        svcName = domain === 'cover' ? 'close_cover' : 'turn_off';
        callSvc = true;
      } else if (stateVal === 'STATE_ON') {
        svcName = domain === 'cover' ? 'open_cover' : 'turn_on';
        callSvc = true;
      } else if (stateVal === 'STATE_STOP' && domain === 'cover') {
        svcName = 'stop_cover';
        callSvc = true;
      }

      // ACTION_TO 控制
      if (action === 'ACTION_TO') {
        callSvc = true;
        if (attr === 'ATTRIBUTE_BRIGHTNESS' && attrVal) {
          svcDomain = 'light';
          svcName = 'turn_on';
          svcData.brightness_pct = parseInt(attrVal);
        } else if (attr === 'ATTRIBUTE_COLORTEMP' && attrVal) {
          svcDomain = 'light';
          svcName = 'turn_on';
          if (String(attrVal).startsWith('#')) {
            const hex = String(attrVal).replace('#', '');
            svcData.rgb_color = [
              parseInt(hex.substring(0, 2), 16),
              parseInt(hex.substring(2, 4), 16),
              parseInt(hex.substring(4, 6), 16)
            ];
          } else {
            svcData.color_temp_kelvin = 2000 + Math.round(parseInt(attrVal) / 100 * 4500);
          }
        } else if (attr === 'ATTRIBUTE_TEMPERATURE' && attrVal) {
          svcDomain = 'climate';
          svcName = 'set_temperature';
          svcData.temperature = parseFloat(attrVal);
        } else if (!attr && attrVal && domain === 'cover') {
          svcDomain = 'cover';
          svcName = 'set_cover_position';
          svcData.position = parseInt(attrVal);
        }
      }

      // 空调模式（action 为空）
      if (attr === 'ATTRIBUTE_MODE' && mode) {
        callSvc = true;
        svcDomain = 'climate';
        svcName = 'set_hvac_mode';
        svcData.hvac_mode = JDSMART_TO_HVAC[mode] || 'auto';
      }

      // 风速（action 为空，值在 mode 字段）
      if (attr === 'ATTRIBUTE_WIND_SPEED' && mode) {
        callSvc = true;
        svcDomain = 'climate';
        svcName = 'set_fan_mode';
        svcData.fan_mode = FAN_MODE_REVERSE[mode] || 'low';
      }

      // 风向
      if (attr === 'ATTRIBUTE_WIND_DIRECTION' && mode) {
        callSvc = true;
        svcDomain = 'climate';
        svcName = 'set_swing_mode';
        const swingMap = {
          MODE_SWING_UP_DOWN: 'on',
          MODE_SWING_LEFT_RIGHT: 'on',
          MODE_SWING_NO: 'off',
          MODE_SWING_ANGLE: 'on'
        };
        svcData.swing_mode = swingMap[mode] || 'off';
      }

      if (callSvc) {
        try {
          await this.ha.callService(svcDomain, svcName, svcData);
        } catch (e) {
          log.error('DeviceManager', `调用服务失败: ${svcDomain}.${svcName}`, e.message);
        }
      }

      // 等待 HA 状态更新
      await new Promise(r => setTimeout(r, 500));

      const cached = this.stateCache.get(entityId);
      let deviceState = {};
      if (cached) {
        deviceState = this._entityToDeviceState(entityId, cached);

        // 乐观状态覆盖
        if (stateVal) deviceState.order = stateVal;
        if (attr === 'ATTRIBUTE_TEMPERATURE' && attrVal) deviceState.temperature = String(attrVal);
        if (attr === 'ATTRIBUTE_BRIGHTNESS' && attrVal) deviceState.brightness = String(attrVal);
        if (attr === 'ATTRIBUTE_MODE' && mode) deviceState.mode = mode;
        if (attr === 'ATTRIBUTE_WIND_SPEED' && mode) deviceState.fanSpeed = mode;
      }

      results.push({ entityId, deviceState });
    }

    return results;
  }
}

module.exports = DeviceManager;
