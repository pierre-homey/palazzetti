'use strict';
const Homey = require('homey');
const { localizedError, translate, isKnownError } = require('../../lib/i18n');
const request = require('../../lib/cbox-http');
const manifest = require('../../app.json').drivers.find(driver => driver.id === 'cbox');

const MODE = Object.freeze({
  WAITING: 'WAITING_TEMP', BURNING: 'BURNING', STOPPED: 'STOPPED',
  PAUSED: 'PAUSED', SILENT: 'SILENTLY', HG: 'HORS_GEL',
});
const STATE = Object.freeze({
  UNKNOWN: 'UNKNOW', STOPPED: 'STOPPED', STARTING: 'STARTING',
  STARTED: 'STARTED', STOPPING: 'STOPPING', FAULTED: 'FAULTED',
});
const sequence = tasks => tasks.reduce((chain, task) => chain.then(task), Promise.resolve());
const finite = value => typeof value === 'number' && Number.isFinite(value);
function number(value, name, min = -Infinity, max = Infinity, integer = false) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
    throw new Error(`Invalid ${name}`);
  }
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) {
    throw new Error(`Invalid ${name}`);
  }
  return result;
}

class CBoxDevice extends Homey.Device {
  number(...args) {
    try { return number(...args); } catch (error) {
      throw localizedError(this.homey, error.message);
    }
  }

  ensureActive() {
    if (this.disposed) throw localizedError(this.homey, 'CBox device stopped');
  }

  // Check both sides of each async Homey call: deletion can happen while it runs.
  async withActiveDevice(operation) {
    this.ensureActive();
    try {
      const result = await operation();
      this.ensureActive();
      return result;
    } catch (error) {
      // A pending SDK call may reject with Not Found after deletion. Abort the
      // chain without logging an expected lifecycle error or issuing more calls.
      this.ensureActive();
      throw error;
    }
  }

  callHomey(method, ...args) {
    return this.withActiveDevice(() => this[method](...args));
  }

  // Only SDK entry points enqueue. Internal methods return their promises and
  // never enqueue recursively, so a multi-command operation cannot deadlock.
  runOperation(operation) {
    const result = (this.operationTail || Promise.resolve()).then(() => {
      if (this.disposed) throw localizedError(this.homey, 'CBox device stopped');
      return operation();
    });
    this.operationTail = result.catch(() => {});
    return result;
  }

  onInit() {
    this.disposed = false;
    this.stoveState = STATE.UNKNOWN;
    this.regulationMode = this.getCapabilityValue('stove_regulation') || MODE.STOPPED;
    this.lastEnergyUpdate = Date.now();
    this.communicationFailureCount = 0;
    this.lastExternalTemperatureUpdate = Date.now();
    this.externalTemperatureStaleNotified = false;
    this.externalTemperatureStale = false;
    this.applySettings(this.getSettings());
    this.alarmePelletsChange = this.homey.flow.getDeviceTriggerCard('pellets_attention');
    this.alarmePelletsChangeOff = this.homey.flow.getDeviceTriggerCard('pellets_attention_off');
    this.preAlarmePelets = this.homey.flow.getDeviceTriggerCard('pre_pellets_attention');
    this.temperatureAboveTargetFlow = this.homey.flow.getDeviceTriggerCard('temperature_above_target');
    this.powerFanChangeFlow = this.homey.flow.getDeviceTriggerCard('power_fan_change');
    this.lastTemperatureDelta = undefined;
    this.externalTemperatureStaleFlow = this.homey.flow.getDeviceTriggerCard('external_temperature_stale');
    return this.runOperation(() => sequence(manifest.capabilities.map(id => () =>
      this.hasCapability(id) ? undefined : this.callHomey('addCapability', id)))
      .then(() => this.hasCapability('locked') ? this.callHomey('removeCapability', 'locked') : undefined)
      .then(() => sequence([
        () => this.initializeValue('stove_ignation', true),
        () => this.initializeValue('auto_mode', true),
        () => this.initializeValue('meter_power', 0),
        () => this.initializeValue('alarm_connectivity', false),
      ]))
      .then(() => this.hasCapability('stove_connection') ? this.callHomey('removeCapability', 'stove_connection') : undefined)
      .then(() => {
        this.ensureActive();
        const listeners = {
          target_temperature: 'onCapabilityTargetTemperature', target_power: 'onCapabilityTargetPower',
          target_fan_speed: 'onCapabilityTargetFanSpeed', onoff: 'onCapabilityOnOff',
          stove_regulation: 'onCapabilityRegulationMode', stove_ignation: 'onCapabilityLocked',
          auto_mode: 'onCapabilityAuto',
        };
        Object.entries(listeners).forEach(([id, method]) => {
          this.registerCapabilityListener(id, value => this.runOperation(() => this[method](value)));
        });
        this.unloadListener = () => this.stopPolling();
        this.homey.on('unload', this.unloadListener);
      }))
      .then(() => this.onTimeOut().catch(() => undefined))
      .then(() => this.schedulePoll());
  }

  initializeValue(id, value) {
    return this.getCapabilityValue(id) == null ? this.callHomey('setCapabilityValue', id, value) : Promise.resolve();
  }

  applySettings(settings) {
    this.settings = { ...settings };
    this.stoveIp = settings.ip;
    this.smartStartEnbale = settings.smartStart;
    this.smartPauseEnable = settings.smartPause;
    this.tempSmartPause = settings.pauseTemp;
    this.useExtCaptor = settings.externalTerm;
    this.temperatureMin = Number(settings.temperatureMin ?? 0);
    this.temperatureMax = Number(settings.temperatureMax ?? 40);
    this.deltaN1 = settings.deltaN1;
    this.deltaN2 = settings.deltaN2;
    this.deltaSilence = settings.deltaSilence;
    this.deltaSilenceEnabled = settings.deltaSilenceEnable;
  }

  onSettings({ newSettings }) {
    return this.runOperation(() => {
      if (!(newSettings.deltaN1 < newSettings.deltaN2 && newSettings.deltaN2 <= newSettings.deltaSilence)) {
        throw localizedError(this.homey, 'Temp. N1 < Temp. N2 <= Temp. Silence required');
      }
      if (!(newSettings.hgMinTemp < newSettings.hgMaxTemp)) throw localizedError(this.homey, 'Invalid frost protection temperatures');
      const externalTempTimeout = Number(newSettings.externalTempTimeout ?? 30);
      if (!Number.isInteger(externalTempTimeout) || externalTempTimeout < 1 || externalTempTimeout > 1440) {
        throw localizedError(this.homey, 'External temperature timeout must be between 1 and 1440 minutes');
      }
      const temperatureMin = Number(newSettings.temperatureMin ?? 0);
      const temperatureMax = Number(newSettings.temperatureMax ?? 40);
      if (!Number.isFinite(temperatureMin) || !Number.isFinite(temperatureMax)
        || temperatureMin < -50 || temperatureMax > 80 || temperatureMin >= temperatureMax) {
        throw localizedError(this.homey, 'Invalid ambient temperature limits');
      }
      const check = newSettings.ip !== this.stoveIp
        ? this.sendHTTPRequest(this.getcallCboxURL('LABL', false, null, newSettings.ip))
        : Promise.resolve();
      return check.then(() => {
        // Homey saves settings after this hook; use the proposed values internally.
        return this.callHomey('setCapabilityValue', 'measure_temperature', this.getCapabilityValue(
          newSettings.externalTerm ? 'external_temperature' : 'internal_temperature'))
          .then(() => {
            this.applySettings(newSettings);
            return this.checkTemperatureAboveTarget()
              .then(() => this.checkExternalTemperatureFreshness())
              .then(() => this.onTempChange());
          });
      });
    });
  }

  schedulePoll() {
    if (this.disposed) return;
    if (this.timeoutId != null) this.homey.clearTimeout(this.timeoutId);
    const now = Date.now();
    const delay = 60000 - (now % 60000);
    this.timeoutId = this.homey.setTimeout(() => {
      this.timeoutId = null;
      return this.checkExternalTemperatureFreshness()
        .then(() => this.onTimeOut().catch(() => undefined))
        .then(() => this.schedulePoll());
    }, delay);
  }

  checkExternalTemperatureFreshness(now = Date.now()) {
    if (this.disposed) return Promise.resolve();
    const previous = this.getDashboardValues();
    const timeout = Number(this.settings.externalTempTimeout ?? 30) * 60000;
    const stale = Boolean(this.useExtCaptor && now - this.lastExternalTemperatureUpdate >= timeout);
    const staleChanged = stale !== this.externalTemperatureStale;
    this.externalTemperatureStale = stale;
    const dashboardUpdate = staleChanged ? this.publishDashboardUpdate(previous) : Promise.resolve();
    if (!stale) {
      this.externalTemperatureStaleNotified = false;
      return dashboardUpdate;
    }
    if (!this.getCapabilityValue('onoff') || this.externalTemperatureStaleNotified) return dashboardUpdate;
    this.externalTemperatureStaleNotified = true;
    return dashboardUpdate.then(() => this.withActiveDevice(
      () => this.externalTemperatureStaleFlow.trigger(this, {}, {})))
      .catch(error => {
        if (!this.disposed) this.error('Failed to trigger stale external temperature Flow', error);
      });
  }

  stopPolling() {
    this.disposed = true;
    if (this.timeoutId != null) this.homey.clearTimeout(this.timeoutId);
    this.timeoutId = null;
    if (this.activeRequests) {
      const activeRequests = Array.from(this.activeRequests);
      this.activeRequests.clear();
      activeRequests.forEach(cancel => cancel());
    }
    if (this.unloadListener) this.homey.removeListener('unload', this.unloadListener);
    this.unloadListener = null;
  }
  onDeleted() { this.stopPolling(); }
  onUninit() { this.stopPolling(); return this.operationTail || Promise.resolve(); }

  checkComm() { return this.sendHTTPRequest(this.getcallCboxURL('LABL', false)); }

  updateConnectivityAlarm(hasFailure) {
    if (this.disposed) return Promise.resolve();
    const nextCount = hasFailure ? (this.communicationFailureCount || 0) + 1 : 0;
    this.communicationFailureCount = nextCount;
    if (!hasFailure) return this.callHomey('setCapabilityValue', 'alarm_connectivity', false).catch(() => undefined);
    if (nextCount < 2) return this.callHomey('setCapabilityValue', 'alarm_connectivity', false).catch(() => undefined);
    return this.callHomey('setCapabilityValue', 'alarm_connectivity', true).catch(() => undefined);
  }

  onTimeOut() {
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = this.runOperation(() => {
      this._pollingRequest = true;
      let cboxTemperatureValid = true;
      return Promise.resolve().then(() => this.sendHTTPRequest(this.getcallCboxURL('ALLS', false)))
        .then(data => this.validateSnapshot(data))
        .then(data => {
          cboxTemperatureValid = data.temperatureValid;
          return this.updateAllStates(data);
        })
        .then(() => this.updateEnergyPowerConso())
        .then(() => {
          this.communicationFailureCount = 0;
          return this.callHomey('setCapabilityValue', 'alarm_connectivity', false).catch(() => undefined)
            .then(() => this.callHomey('setAvailable'));
        })
        .then(() => this.useExtCaptor || cboxTemperatureValid ? this.onTempChange() : undefined)
        .catch(error => {
          if (this.disposed) throw error;
          return this.updateConnectivityAlarm(true)
            .then(() => { throw error; });
        });
    }).finally(() => {
      this._pollingRequest = false;
      this.pollPromise = null;
    });
    return this.pollPromise;
  }

  validateSnapshot(data) {
    if (!data || typeof data !== 'object') throw localizedError(this.homey, 'Invalid CBox state');
    let T1;
    let temperatureValid = true;
    try {
      T1 = this.validateTemperature(data.T1, 'T1');
    } catch {
      T1 = null;
      temperatureValid = false;
    }
    return {
      STATUS: this.number(data.STATUS, 'STATUS', 0, 65535, true),
      SETP: this.number(data.SETP, 'SETP'), PWR: this.number(data.PWR, 'PWR', 1, 5, true),
      F2L: this.number(data.F2L, 'F2L', 0, 7, true), T1, temperatureValid,
      PQT: this.number(data.PQT, 'PQT', 0),
    };
  }

  validateTemperature(value, name) {
    return this.number(value, name, this.temperatureMin, this.temperatureMax);
  }

  updateAllStates(data) {
    // Publish the whole sample before regulation; two changed temperatures must
    // not launch two conflicting decisions against a half-updated sample.
    const previous = this.getDashboardValues();
    return sequence([
      () => this.callHomey('setCapabilityValue', 'target_temperature', data.SETP),
      () => this.setPower(data.PWR, false),
      () => this.setFanSpeed(data.F2L, false),
      () => data.temperatureValid === false ? undefined
        : this.callHomey('setCapabilityValue', 'internal_temperature', data.T1),
      () => this.useExtCaptor
        ? this.callHomey('setCapabilityValue', 'measure_temperature', this.getCapabilityValue('external_temperature'))
        : data.temperatureValid === false ? undefined
          : this.callHomey('setCapabilityValue', 'measure_temperature', data.T1),
      () => this.setBurnedPellets(data.PQT),
      () => this.updateStates(data.STATUS),
      () => this.publishDashboardUpdate(previous),
      () => this.setStateOnOff(),
      () => this.useExtCaptor || data.temperatureValid !== false
        ? this.checkTemperatureAboveTarget() : undefined,
    ]);
  }

  updateStates(status) {
    const previous = this.getCapabilityValue('stove_state');
    const states = {
      0: STATE.STOPPED,
      2: STATE.STARTING,
      3: STATE.STARTING,
      4: STATE.STARTING,
      5: STATE.STARTING,
      6: STATE.STARTED,
      10: STATE.STOPPING,
      11: STATE.STARTED,
      12: STATE.STOPPING,
      13: STATE.STOPPED,
      14: STATE.STARTING,
      15: STATE.STARTING,
      16: STATE.STARTING,
      17: STATE.STARTED,
      18: STATE.STARTED,
      19: STATE.STOPPING,
      20: STATE.STOPPED,
      21: STATE.FAULTED,
      22: STATE.FAULTED,
    };
    const next = states[status] || (status >= 241 && status <= 253 ? STATE.FAULTED : STATE.UNKNOWN);
    this.stoveState = next;
    const burning = next === STATE.STARTED || next === STATE.STARTING;
    let mode = this.regulationMode;
    if (next === STATE.FAULTED) mode = MODE.STOPPED;
    else if (mode !== MODE.HG && next !== STATE.UNKNOWN) {
      if (burning && ![MODE.BURNING, MODE.SILENT, MODE.PAUSED, MODE.STOPPED].includes(mode)) mode = MODE.BURNING;
      // A physical ignition outside Homey must be reflected, except after our OFF.
      if (burning && mode === MODE.STOPPED && !this.pendingOff) mode = MODE.BURNING;
      if (!burning && ![MODE.STOPPED, MODE.PAUSED, MODE.WAITING].includes(mode)) mode = MODE.STOPPED;
    }
    // Keep our OFF intent through cooling and transient/late samples. Only a
    // confirmed stop (or fault) ends the shutdown, not STOPPING or UNKNOWN.
    if ([STATE.STOPPED, STATE.FAULTED].includes(next)) this.pendingOff = false;
    const alarm = status === 253;
    const oldAlarm = this.getCapabilityValue('alarm_pellets');
    return this.callHomey('setCapabilityValue', 'stove_state', next)
      .then(() => this.setRegulation(mode, false))
      .then(() => this.callHomey('setCapabilityValue', 'alarm_pellets', alarm))
      .then(() => alarm && !oldAlarm ? this.withActiveDevice(() => this.alarmePelletsChange.trigger(this, {}, {})) : undefined)
      .then(() => oldAlarm && !alarm ? this.setPelletsReloadDone(false) : undefined)
      .then(() => previous !== next ? this.withActiveDevice(() => this.driver.triggerFlowOnStateChange(this, next)) : undefined);
  }

  setRegulation(mode, publish = true) {
    const previous = this.getDashboardValues();
    return this.callHomey('setCapabilityValue', 'stove_regulation', mode)
      .then(() => { this.regulationMode = mode; })
      .then(() => publish ? this.publishDashboardUpdate(previous) : undefined);
  }
  setStateOnOff() {
    return this.callHomey('setCapabilityValue', 'onoff', this.regulationMode !== MODE.STOPPED)
      .then(() => {
        if (!this.getCapabilityValue('onoff')) this.externalTemperatureStaleNotified = false;
        return this.checkExternalTemperatureFreshness();
      });
  }

  updateEnergyPowerConso() {
    const now = Date.now();
    const lastPower = this.getCapabilityValue('measure_power');
    const lastEnergy = this.getCapabilityValue('meter_power');
    const elapsed = Math.max(0, now - this.lastEnergyUpdate);
    const energy = (finite(lastEnergy) ? lastEnergy : 0)
      + (finite(lastPower) ? lastPower : 0) * elapsed / 3600000000;
    const fanPower = [10, 22, 35, 35, 47.5, 47.5, 49, 33];
    const power = this.stoveState === STATE.STARTING ? 345
      : this.stoveState === STATE.STARTED ? fanPower[Number(this.getCapabilityValue('target_fan_speed'))]
        : this.stoveState === STATE.STOPPING ? 33
          : [STATE.STOPPED, STATE.FAULTED].includes(this.stoveState) ? 1.3 : null;
    return this.callHomey('setCapabilityValue', 'meter_power', energy)
      .then(() => { this.lastEnergyUpdate = now; })
      .then(() => this.callHomey('setCapabilityValue', 'measure_power', power));
  }

  setBurnedPellets(kilos) {
    const index = this.getStoreValue('reloadDoneIndex');
    const baseline = finite(index) && index <= kilos ? index : kilos;
    const consumed = kilos - baseline;
    return Promise.resolve()
      .then(() => baseline !== index ? this.callHomey('setStoreValue', 'reloadDoneIndex', baseline) : undefined)
      .then(() => this.callHomey('setCapabilityValue', 'pellets_burned', kilos))
      .then(() => this.callHomey('setCapabilityValue', 'pellets_burned_since_load', consumed))
      .then(() => {
        if (this.settings.withPreAlarm && consumed >= this.settings.deltaPelletsBurned
          && !this.getStoreValue('prePelletsAttentionSended')) {
          return this.withActiveDevice(() => this.preAlarmePelets.trigger(this, {}, {}))
            .then(() => this.callHomey('setStoreValue', 'prePelletsAttentionSended', true));
        }
      });
  }

  setPelletsReloadDone(publish = true) {
    const previous = this.getDashboardValues();
    const kilos = this.getCapabilityValue('pellets_burned');
    if (!finite(kilos)) return Promise.reject(localizedError(this.homey, 'Pellet counter unavailable'));
    return this.callHomey('setStoreValue', 'reloadDoneIndex', kilos)
      .then(() => this.callHomey('setCapabilityValue', 'pellets_burned_since_load', 0))
      .then(() => this.callHomey('setStoreValue', 'prePelletsAttentionSended', false))
      .then(() => this.withActiveDevice(() => this.alarmePelletsChangeOff.trigger(this, {}, {})))
      .then(() => publish ? this.publishDashboardUpdate(previous) : undefined);
  }

  setFanSpeed(value, trigger = true) {
    const previous = this.getDashboardValues();
    return this.callHomey('setCapabilityValue', 'target_fan_speed', String(value))
      .then(() => trigger ? this.publishDashboardUpdate(previous) : undefined);
  }
  setPower(value, trigger = true) {
    const previous = this.getDashboardValues();
    return this.callHomey('setCapabilityValue', 'target_power', String(value))
      .then(() => trigger ? this.publishDashboardUpdate(previous) : undefined);
  }
  getDashboardValues() {
    const pelletsConsumed = this.getCapabilityValue('pellets_burned_since_load');
    return {
      targetTemperature: this.getCapabilityValue('target_temperature'),
      temperature: this.getCapabilityValue('measure_temperature'),
      power: this.getCapabilityValue('target_power'),
      fanSpeed: this.getCapabilityValue('target_fan_speed'),
      state: this.getCapabilityValue('stove_state'),
      regulation: this.getCapabilityValue('stove_regulation'),
      pelletsAlarm: this.getCapabilityValue('alarm_pellets'),
      pelletsConsumed,
      pelletsLow: Boolean(this.settings.withPreAlarm
        && finite(pelletsConsumed)
        && pelletsConsumed >= Number(this.settings.deltaPelletsBurned)),
      autoMode: this.getCapabilityValue('auto_mode'),
      ignitionAllowed: this.getCapabilityValue('stove_ignation'),
      externalTemperature: Boolean(this.useExtCaptor),
      temperatureStale: Boolean(this.useExtCaptor && this.externalTemperatureStale),
    };
  }
  publishDashboardUpdate(previous) {
    const values = this.getDashboardValues();
    const changed = Object.keys(values).some(key => !Object.is(values[key], previous[key]));
    if (!changed) return Promise.resolve();
    const dashboardUpdate = this.withActiveDevice(() => this.homey.api.realtime('stove_dashboard_update', {
      sourceId: this.getData().id,
      name: this.getName(),
      ...values,
    }));
    const powerOrFanChanged = !Object.is(values.power, previous.power)
      || !Object.is(values.fanSpeed, previous.fanSpeed);
    if (!powerOrFanChanged || ![STATE.STARTING, STATE.STARTED].includes(this.stoveState)) {
      return dashboardUpdate;
    }
    const power = Number(values.power);
    const fanSpeed = Number(values.fanSpeed);
    if (!finite(values.temperature) || !Number.isFinite(power) || !Number.isFinite(fanSpeed)) {
      return dashboardUpdate;
    }
    return dashboardUpdate.then(() => this.withActiveDevice(() => this.powerFanChangeFlow.trigger(this, {
      temperature: values.temperature, power, fan_speed: fanSpeed,
    }, {})).catch(error => {
      if (!this.disposed) this.error('Failed to trigger power or fan speed change Flow', error);
    }));
  }
  setTargetTemperature(value) {
    const previous = this.getDashboardValues();
    return this.callHomey('setCapabilityValue', 'target_temperature', value)
      .then(() => this.publishDashboardUpdate(previous))
      .then(() => this.checkTemperatureAboveTarget()).then(() => this.onTempChange());
  }
  setCurrentTemp(value) {
    const previous = this.getDashboardValues();
    return this.callHomey('setCapabilityValue', 'measure_temperature', value)
      .then(() => this.publishDashboardUpdate(previous))
      .then(() => this.checkTemperatureAboveTarget()).then(() => this.onTempChange());
  }
  checkTemperatureAboveTarget() {
    const temperature = this.getCapabilityValue('measure_temperature');
    const target = this.getCapabilityValue('target_temperature');
    if (!finite(temperature) || !finite(target)) return Promise.resolve();
    const delta = temperature - target;
    const previousDelta = this.lastTemperatureDelta;
    this.lastTemperatureDelta = delta;
    // The first valid sample establishes a baseline, including after a restart.
    if (!finite(previousDelta) || delta <= previousDelta) return Promise.resolve();
    return this.withActiveDevice(() => this.temperatureAboveTargetFlow.trigger(this,
      { temperature, target, delta }, { previousDelta, delta }))
      .catch(error => {
        if (!this.disposed) this.error('Failed to trigger temperature above target Flow', error);
      });
  }

  setExternalTemp(value) {
    const temp = this.validateTemperature(value, 'external temperature');
    const previous = this.getDashboardValues();
    return this.callHomey('setCapabilityValue', 'external_temperature', temp)
      .then(() => {
        this.lastExternalTemperatureUpdate = Date.now();
        this.externalTemperatureStaleNotified = false;
        this.externalTemperatureStale = false;
        // Publish external sensor changes before regulation can change power
        // and fan speed, otherwise the outer snapshot reports them twice.
        return this.publishDashboardUpdate(previous);
      })
      .then(() => this.useExtCaptor ? this.setCurrentTemp(temp) : undefined);
  }
  setInternalTemp(value) {
    const temp = this.validateTemperature(value, 'internal temperature');
    return this.callHomey('setCapabilityValue', 'internal_temperature', temp)
      .then(() => !this.useExtCaptor ? this.setCurrentTemp(temp) : undefined);
  }

  setPreset(value) {
    const preset = this.number(value, 'preset', 0, 3, true);
    const power = this.settings[preset === 3 ? 'presetSilenceBurningPower' : `preset${preset}BurningPower`];
    const fan = preset === 3 || this.regulationMode === MODE.SILENT ? 0 : this.settings[`preset${preset}FanSpeed`];
    return this.applyPreset(power, fan);
  }
  setHGPreset() { return this.applyTargetPresetForHG(); }
  applyTargetPresetForHG() {
    return this.applyPreset(this.settings.presetHGBurningPower, this.settings.presetHGFanSpeed);
  }
  applyTargetPresetForCurrentTemp() {
    const temp = this.getCapabilityValue('measure_temperature');
    const target = this.getCapabilityValue('target_temperature');
    if (!finite(temp) || !finite(target)) return Promise.resolve();
    const delta = temp - target;
    const preset = delta < this.deltaN1 ? 0 : delta < this.deltaN2 ? 1
      : this.deltaSilenceEnabled && delta >= this.deltaSilence ? 3 : 2;
    return this.setPreset(preset);
  }
  applyPreset(power, fanSpeed) {
    const p = this.number(power, 'power', 1, 5, true);
    const f = this.number(fanSpeed, 'fan speed', 0, 7, true);
    const previous = this.getDashboardValues();
    return this.sendHTTPRequest(this.getcallCboxURL('RFAN', true, f))
      .then(() => this.setFanSpeed(f, false))
      .then(() => this.sendHTTPRequest(this.getcallCboxURL('POWR', true, p)))
      .then(() => this.setPower(p, false))
      .then(() => this.publishDashboardUpdate(previous));
  }

  isRegulationMode(mode) { return this.getCapabilityValue('stove_regulation') === mode; }
  isSmartStartEnabled() { return this.smartStartEnbale === true; }
  isSmartPauseEnabled() { return this.smartPauseEnable === true; }
  isIgnationAllowed() { return this.getCapabilityValue('stove_ignation') === true; }
  isAutoModeEnable() { return this.getCapabilityValue('auto_mode') === true; }

  isCanStartWSStartKnonwTemp() {
    if (!this.isIgnationAllowed() || this.stoveState !== STATE.STOPPED) return false;
    if (!this.smartStartEnbale && this.regulationMode !== MODE.PAUSED) return true;
    const temp = this.getCapabilityValue('measure_temperature');
    const target = this.getCapabilityValue('target_temperature');
    if (!finite(temp) || !finite(target)) return false;
    if (this.regulationMode === MODE.PAUSED) return temp <= target + this.settings.restartPauseTemp;
    return temp <= target;
  }
  isCanPauseWKnonwTemp() {
    const temp = this.getCapabilityValue('measure_temperature');
    const target = this.getCapabilityValue('target_temperature');
    return this.smartPauseEnable === true && this.stoveState === STATE.STARTED
      && finite(temp) && finite(target) && temp >= target + this.tempSmartPause;
  }
  isCanStartForHG() {
    const temp = this.getCapabilityValue('measure_temperature');
    return this.isIgnationAllowed() && this.stoveState === STATE.STOPPED
      && finite(temp) && temp <= this.settings.hgMinTemp;
  }
  isCanPauseForHG() {
    const temp = this.getCapabilityValue('measure_temperature');
    return this.stoveState === STATE.STARTED && (!finite(temp) || temp > this.settings.hgMaxTemp);
  }

  onTempChange() {
    if (!this.isAutoModeEnable()) return Promise.resolve();
    const mode = this.regulationMode;
    if ([MODE.WAITING, MODE.PAUSED].includes(mode) && this.isCanStartWSStartKnonwTemp()) {
      return this.applyTargetPresetForCurrentTemp()
        .then(() => this.setOnOffPoele(true))
        .then(() => this.setRegulation(MODE.BURNING));
    }
    if ([MODE.BURNING, MODE.SILENT].includes(mode)) {
      if (this.isCanPauseWKnonwTemp()) {
        return this.setOnOffPoele(false).then(() => this.setRegulation(MODE.PAUSED));
      }
      if (mode === MODE.BURNING && [STATE.STARTING, STATE.STARTED].includes(this.stoveState)) {
        return this.applyTargetPresetForCurrentTemp();
      }
    }
    if (mode === MODE.HG) {
      if (this.isCanPauseForHG()) return this.setOnOffPoele(false);
      if (this.isCanStartForHG()) return this.applyTargetPresetForHG().then(() => this.setOnOffPoele(true));
    }
    return Promise.resolve();
  }

  setIgnationAllowed(value) {
    if (typeof value !== 'boolean') throw localizedError(this.homey, 'Invalid ignition permission');
    const previous = this.getDashboardValues();
    return this.callHomey('setCapabilityValue', 'stove_ignation', value)
      .then(() => this.publishDashboardUpdate(previous))
      .then(() => value ? this.onTempChange() : undefined);
  }
  enableAutoMode(value) {
    if (typeof value !== 'boolean') throw localizedError(this.homey, 'Invalid automatic mode');
    const previous = this.getDashboardValues();
    return this.callHomey('setCapabilityValue', 'auto_mode', value)
      .then(() => this.publishDashboardUpdate(previous))
      .then(() => value ? this.onTempChange() : undefined);
  }
  setSilenceMode(value) { return this.changeSetting('deltaSilenceEnable', value); }
  setSmartPause(value) { return this.changeSetting('smartPause', value); }
  changeSetting(key, value) {
    if (typeof value !== 'boolean') throw localizedError(this.homey, `Invalid ${key}`);
    return this.callHomey('setSettings', { [key]: value })
      .then(() => { this.applySettings({ ...this.settings, [key]: value }); })
      .then(() => this.onTempChange());
  }
  onCapabilityLocked(value) { return this.setIgnationAllowed(value); }
  onCapabilityAuto(value) { return this.enableAutoMode(value); }

  onCapabilityTargetTemperature(value) {
    const temp = Math.round(this.number(value, 'target temperature', 15, 30));
    return this.sendHTTPRequest(this.getcallCboxURL('SETP', true, temp))
      .then(() => this.setTargetTemperature(temp));
  }
  onCapabilityTargetPower(value) {
    if (this.isAutoModeEnable()) throw localizedError(this.homey, 'AUTO_MODE_ENABLED');
    const power = this.number(value, 'power', 1, 5, true);
    return this.sendHTTPRequest(this.getcallCboxURL('POWR', true, power)).then(() => this.setPower(power));
  }
  onCapabilityTargetFanSpeed(value) {
    if (this.isAutoModeEnable()) throw localizedError(this.homey, 'AUTO_MODE_ENABLED');
    const speed = this.number(value, 'fan speed', 0, 7, true);
    return this.sendHTTPRequest(this.getcallCboxURL('RFAN', true, speed)).then(() => this.setFanSpeed(speed));
  }

  onCapabilityOnOff(value) {
    if (typeof value !== 'boolean') throw localizedError(this.homey, 'Invalid on/off value');
    if (!value) {
      const stop = [STATE.STOPPED, STATE.STOPPING].includes(this.stoveState)
        ? Promise.resolve() : this.setOnOffPoele(false);
      return stop.then(() => {
        this.pendingOff = this.stoveState !== STATE.STOPPED;
        return this.setRegulation(MODE.STOPPED);
      }).then(() => this.setStateOnOff());
    }
    if (!this.isIgnationAllowed()) throw localizedError(this.homey, 'Ignition is disabled');
    if (this.stoveState === STATE.STOPPING || this.pendingOff) {
      throw new Error(this.homey.__('waitForStop'));
    }
    if (this.stoveState !== STATE.STOPPED) throw new Error(this.homey.__('illegalStateOnOff'));
    const canStart = !this.isAutoModeEnable() || this.isCanStartWSStartKnonwTemp();
    return (canStart ? this.setOnOffPoele(true) : Promise.resolve())
      .then(() => this.setRegulation(canStart ? MODE.BURNING : MODE.WAITING))
      .then(() => this.setStateOnOff());
  }

  onCapabilityRegulationMode(value) {
    if (!this.getCapabilityValue('onoff')) throw new Error(this.homey.__('illegalRegulationMode'));
    if (!Object.values(MODE).includes(value) || value === MODE.WAITING) {
      throw new Error(this.homey.__('manualActionImpossible'));
    }
    if (value === MODE.STOPPED) return this.onCapabilityOnOff(false);
    if (value === MODE.HG) {
      if (![STATE.STOPPED, STATE.STARTED].includes(this.stoveState)) throw new Error(this.homey.__('illegalRegulationMode'));
      return this.applyTargetPresetForHG()
        .then(() => this.isCanStartForHG() ? this.setOnOffPoele(true)
          : this.isCanPauseForHG() ? this.setOnOffPoele(false) : undefined)
        .then(() => this.setRegulation(MODE.HG)).then(() => this.setStateOnOff());
    }
    if (value === MODE.PAUSED && this.stoveState === STATE.STARTED) {
      return this.setOnOffPoele(false).then(() => this.setRegulation(value));
    }
    if (value === MODE.BURNING && this.stoveState === STATE.STOPPED) {
      if (!this.isIgnationAllowed() || (this.isAutoModeEnable() && !this.isCanStartWSStartKnonwTemp())) {
        throw new Error(this.homey.__('illegalRegulationMode'));
      }
      return this.setOnOffPoele(true).then(() => this.setRegulation(value));
    }
    if ([MODE.BURNING, MODE.SILENT].includes(value) && [STATE.STARTED, STATE.STARTING].includes(this.stoveState)) {
      const previous = this.regulationMode;
      this.regulationMode = value;
      return this.applyTargetPresetForCurrentTemp()
        .then(() => this.setRegulation(value))
        .catch(error => { this.regulationMode = previous; throw error; });
    }
    throw new Error(this.homey.__('manualActionImpossible'));
  }

  getcallCboxURL(command, isSet, value, address = this.stoveIp) {
    if (typeof address !== 'string' || !address.trim()) throw localizedError(this.homey, 'ERROR_NO_IP');
    const base = new URL(`http://${address.trim()}`);
    if (base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw localizedError(this.homey, 'Invalid CBox address');
    const parts = isSet ? ['SET', command, value] : ['GET', command];
    return `${base.origin}/cgi-bin/sendmsg.lua?cmd=${parts.map(part => encodeURIComponent(part)).join('+')}`;
  }
  getOnOffRequestURL(on) {
    return this.getcallCboxURL('LABL', false).replace('GET+LABL', `CMD+${on ? 'ON' : 'OFF'}`);
  }
  setOnOffPoele(on) {
    if (on && !this.isIgnationAllowed()) return Promise.reject(localizedError(this.homey, 'Ignition is disabled'));
    if (on && this.stoveState !== STATE.STOPPED) return Promise.reject(localizedError(this.homey, 'Stove is not stopped'));
    return this.sendHTTPRequest(this.getOnOffRequestURL(on)).then(() => {
      // Until the next sample, prevent another decision from repeating ON/OFF.
      this.stoveState = on ? STATE.STARTING : STATE.STOPPING;
      this.pendingOff = !on;
      // The public state and its Flow trigger are updated together by polling.
    });
  }
  sendHTTPRequest(url) {
    if (this.disposed) return Promise.reject(localizedError(this.homey, 'CBox device stopped'));
    let cancelRequest;
    const isPollingRequest = !!this._pollingRequest;
    return request(url, {
      onRequest: cancel => {
        cancelRequest = cancel;
        if (this.disposed) cancel();
        else {
          if (!this.activeRequests) this.activeRequests = new Set();
          this.activeRequests.add(cancel);
        }
      },
    }).then(data => {
      this.ensureActive();
      if (!isPollingRequest) {
        return this.callHomey('setCapabilityValue', 'alarm_connectivity', false).then(() => data);
      }
      return data;
    }, error => {
      if (this.disposed) throw error;
      if (!isPollingRequest) {
        this.communicationFailureCount = 0;
      }
      const localized = localizedError(this.homey, error.message);
      if (!isKnownError(error.message)) {
        localized.message = translate(this.homey, 'errors.communication');
      }
      localized.cause = error;
      return Promise.reject(localized);
    }).finally(() => {
      if (cancelRequest && this.activeRequests) this.activeRequests.delete(cancelRequest);
    });
  }
}
module.exports = CBoxDevice;
