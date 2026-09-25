'use strict';
const Homey = require('homey');
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
  // Only SDK entry points enqueue. Internal methods return their promises and
  // never enqueue recursively, so a multi-command operation cannot deadlock.
  runOperation(operation) {
    const result = (this.operationTail || Promise.resolve()).then(() => {
      if (this.disposed) throw new Error('CBox device stopped');
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
    this.applySettings(this.getSettings());
    this.alarmePelletsChange = this.homey.flow.getDeviceTriggerCard('pellets_attention');
    this.alarmePelletsChangeOff = this.homey.flow.getDeviceTriggerCard('pellets_attention_off');
    this.preAlarmePelets = this.homey.flow.getDeviceTriggerCard('pre_pellets_attention');
    return this.runOperation(() => sequence(manifest.capabilities.map(id => () =>
      this.hasCapability(id) ? undefined : this.addCapability(id)))
      .then(() => this.hasCapability('locked') ? this.removeCapability('locked') : undefined)
      .then(() => sequence([
        () => this.initializeValue('stove_ignation', true),
        () => this.initializeValue('auto_mode', true),
        () => this.initializeValue('meter_power', 0),
        () => this.setCapabilityValue('stove_connection', null),
      ]))
      .then(() => {
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
      .then(() => this.onTimeOut().catch(error => this.error('CBox initial update failed', error)))
      .then(() => this.schedulePoll());
  }

  initializeValue(id, value) {
    return this.getCapabilityValue(id) == null ? this.setCapabilityValue(id, value) : Promise.resolve();
  }

  applySettings(settings) {
    this.settings = { ...settings };
    this.stoveIp = settings.ip;
    this.smartStartEnbale = settings.smartStart;
    this.smartPauseEnable = settings.smartPause;
    this.tempSmartPause = settings.pauseTemp;
    this.useExtCaptor = settings.externalTerm;
    this.deltaN1 = settings.deltaN1;
    this.deltaN2 = settings.deltaN2;
    this.deltaSilence = settings.deltaSilence;
    this.deltaSilenceEnabled = settings.deltaSilenceEnable;
  }

  onSettings({ newSettings }) {
    return this.runOperation(() => {
      if (!(newSettings.deltaN1 < newSettings.deltaN2 && newSettings.deltaN2 <= newSettings.deltaSilence)) {
        throw new Error('Temp. N1 < Temp. N2 <= Temp. Silence required');
      }
      if (!(newSettings.hgMinTemp < newSettings.hgMaxTemp)) throw new Error('Invalid frost protection temperatures');
      const check = newSettings.ip !== this.stoveIp
        ? this.sendHTTPRequest(this.getcallCboxURL('LABL', false, null, newSettings.ip))
        : Promise.resolve();
      return check.then(() => {
        // Homey saves settings after this hook; use the proposed values internally.
        return this.setCapabilityValue('measure_temperature', this.getCapabilityValue(
          newSettings.externalTerm ? 'external_temperature' : 'internal_temperature'))
          .then(() => { this.applySettings(newSettings); });
      });
    });
  }

  schedulePoll() {
    if (this.disposed) return;
    if (this.timeoutId != null) this.homey.clearTimeout(this.timeoutId);
    this.timeoutId = this.homey.setTimeout(() => {
      this.timeoutId = null;
      this.onTimeOut().catch(error => this.error('CBox update failed', error))
        .then(() => this.schedulePoll());
    }, 60000);
  }

  stopPolling() {
    this.disposed = true;
    if (this.timeoutId != null) this.homey.clearTimeout(this.timeoutId);
    this.timeoutId = null;
    if (this.unloadListener) this.homey.removeListener('unload', this.unloadListener);
    this.unloadListener = null;
  }
  onDeleted() { this.stopPolling(); }
  onUninit() { this.stopPolling(); return this.operationTail || Promise.resolve(); }

  checkComm() { return this.sendHTTPRequest(this.getcallCboxURL('LABL', false)); }

  onTimeOut() {
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = this.runOperation(() =>
      Promise.resolve().then(() => this.sendHTTPRequest(this.getcallCboxURL('ALLS', false)))
        .then(data => this.validateSnapshot(data))
        .then(data => this.updateAllStates(data))
        .then(() => this.updateEnergyPowerConso())
        .then(() => this.setCapabilityValue('stove_connection', false))
        .then(() => this.setAvailable())
        .then(() => this.onTempChange())
        .catch(error => this.setCapabilityValue('stove_connection', true)
          .then(() => this.setUnavailable(error.message))
          .then(() => { throw error; })))
      .finally(() => { this.pollPromise = null; });
    return this.pollPromise;
  }

  validateSnapshot(data) {
    if (!data || typeof data !== 'object') throw new Error('Invalid CBox state');
    return {
      STATUS: number(data.STATUS, 'STATUS', 0, 65535, true),
      SETP: number(data.SETP, 'SETP'), PWR: number(data.PWR, 'PWR', 1, 5, true),
      F2L: number(data.F2L, 'F2L', 0, 7, true), T1: number(data.T1, 'T1'),
      PQT: number(data.PQT, 'PQT', 0),
    };
  }

  updateAllStates(data) {
    // Publish the whole sample before regulation; two changed temperatures must
    // not launch two conflicting decisions against a half-updated sample.
    return sequence([
      () => this.setCapabilityValue('target_temperature', data.SETP),
      () => this.setPower(data.PWR),
      () => this.setFanSpeed(data.F2L),
      () => this.setCapabilityValue('internal_temperature', data.T1),
      () => this.setCapabilityValue('measure_temperature', this.useExtCaptor
        ? this.getCapabilityValue('external_temperature') : data.T1),
      () => this.setBurnedPellets(data.PQT),
      () => this.updateStates(data.STATUS),
      () => this.setStateOnOff(),
    ]);
  }

  updateStates(status) {
    const previous = this.getCapabilityValue('stove_state');
    const states = { 0: STATE.STOPPED, 3: STATE.STARTING, 6: STATE.STARTED, 10: STATE.STOPPING };
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
    if (!burning) this.pendingOff = false;
    const alarm = status === 253;
    const oldAlarm = this.getCapabilityValue('alarm_pellets');
    return this.setCapabilityValue('stove_state', next)
      .then(() => this.setRegulation(mode))
      .then(() => this.setCapabilityValue('alarm_pellets', alarm))
      .then(() => alarm && !oldAlarm ? this.alarmePelletsChange.trigger(this, {}, {}) : undefined)
      .then(() => oldAlarm && !alarm ? this.setPelletsReloadDone() : undefined)
      .then(() => previous !== next ? this.driver.triggerFlowOnStateChange(this, next) : undefined);
  }

  setRegulation(mode) {
    return this.setCapabilityValue('stove_regulation', mode).then(() => { this.regulationMode = mode; });
  }
  setStateOnOff() {
    return this.setCapabilityValue('onoff', this.regulationMode !== MODE.STOPPED);
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
    return this.setCapabilityValue('meter_power', energy)
      .then(() => { this.lastEnergyUpdate = now; })
      .then(() => this.setCapabilityValue('measure_power', power));
  }

  setBurnedPellets(kilos) {
    const index = this.getStoreValue('reloadDoneIndex');
    const baseline = finite(index) && index <= kilos ? index : kilos;
    const consumed = kilos - baseline;
    return Promise.resolve()
      .then(() => baseline !== index ? this.setStoreValue('reloadDoneIndex', baseline) : undefined)
      .then(() => this.setCapabilityValue('pellets_burned', kilos))
      .then(() => this.setCapabilityValue('pellets_burned_since_load', consumed))
      .then(() => {
        if (this.settings.withPreAlarm && consumed >= this.settings.deltaPelletsBurned
          && !this.getStoreValue('prePelletsAttentionSended')) {
          return this.preAlarmePelets.trigger(this, {}, {})
            .then(() => this.setStoreValue('prePelletsAttentionSended', true));
        }
      });
  }

  setPelletsReloadDone() {
    const kilos = this.getCapabilityValue('pellets_burned');
    if (!finite(kilos)) return Promise.reject(new Error('Pellet counter unavailable'));
    return this.setStoreValue('reloadDoneIndex', kilos)
      .then(() => this.setCapabilityValue('pellets_burned_since_load', 0))
      .then(() => this.setStoreValue('prePelletsAttentionSended', false))
      .then(() => this.alarmePelletsChangeOff.trigger(this, {}, {}));
  }

  setFanSpeed(value) { return this.setCapabilityValue('target_fan_speed', String(value)); }
  setPower(value) { return this.setCapabilityValue('target_power', String(value)); }
  setTargetTemperature(value) {
    return this.setCapabilityValue('target_temperature', value).then(() => this.onTempChange());
  }
  setCurrentTemp(value) {
    return this.setCapabilityValue('measure_temperature', value).then(() => this.onTempChange());
  }
  setExternalTemp(value) {
    const temp = number(value, 'external temperature');
    return this.setCapabilityValue('external_temperature', temp)
      .then(() => this.useExtCaptor ? this.setCurrentTemp(temp) : undefined);
  }
  setInternalTemp(value) {
    const temp = number(value, 'internal temperature');
    return this.setCapabilityValue('internal_temperature', temp)
      .then(() => !this.useExtCaptor ? this.setCurrentTemp(temp) : undefined);
  }

  setPreset(value) {
    const preset = number(value, 'preset', 0, 3, true);
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
    const p = number(power, 'power', 1, 5, true);
    const f = number(fanSpeed, 'fan speed', 0, 7, true);
    return this.sendHTTPRequest(this.getcallCboxURL('RFAN', true, f))
      .then(() => this.setFanSpeed(f))
      .then(() => this.sendHTTPRequest(this.getcallCboxURL('POWR', true, p)))
      .then(() => this.setPower(p));
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
    if (typeof value !== 'boolean') throw new Error('Invalid ignition permission');
    return this.setCapabilityValue('stove_ignation', value)
      .then(() => value ? this.onTempChange() : undefined);
  }
  enableAutoMode(value) {
    if (typeof value !== 'boolean') throw new Error('Invalid automatic mode');
    return this.setCapabilityValue('auto_mode', value).then(() => value ? this.onTempChange() : undefined);
  }
  setSilenceMode(value) { return this.changeSetting('deltaSilenceEnable', value); }
  setSmartPause(value) { return this.changeSetting('smartPause', value); }
  changeSetting(key, value) {
    if (typeof value !== 'boolean') throw new Error(`Invalid ${key}`);
    return this.setSettings({ [key]: value })
      .then(() => { this.applySettings({ ...this.settings, [key]: value }); })
      .then(() => this.onTempChange());
  }
  onCapabilityLocked(value) { return this.setIgnationAllowed(value); }
  onCapabilityAuto(value) { return this.enableAutoMode(value); }

  onCapabilityTargetTemperature(value) {
    const temp = Math.round(number(value, 'target temperature', 15, 30));
    return this.sendHTTPRequest(this.getcallCboxURL('SETP', true, temp))
      .then(() => this.setTargetTemperature(temp));
  }
  onCapabilityTargetPower(value) {
    if (this.isAutoModeEnable()) throw new Error('AUTO_MODE_ENABLED');
    const power = number(value, 'power', 1, 5, true);
    return this.sendHTTPRequest(this.getcallCboxURL('POWR', true, power)).then(() => this.setPower(power));
  }
  onCapabilityTargetFanSpeed(value) {
    if (this.isAutoModeEnable()) throw new Error('AUTO_MODE_ENABLED');
    const speed = number(value, 'fan speed', 0, 7, true);
    return this.sendHTTPRequest(this.getcallCboxURL('RFAN', true, speed)).then(() => this.setFanSpeed(speed));
  }

  onCapabilityOnOff(value) {
    if (typeof value !== 'boolean') throw new Error('Invalid on/off value');
    if (!value) {
      const stop = [STATE.STOPPED, STATE.STOPPING].includes(this.stoveState)
        ? Promise.resolve() : this.setOnOffPoele(false);
      return stop.then(() => this.setRegulation(MODE.STOPPED)).then(() => this.setStateOnOff());
    }
    if (!this.isIgnationAllowed()) throw new Error('Ignition is disabled');
    if (this.stoveState !== STATE.STOPPED) throw new Error(this.homey.__('illegalStateOnOff'));
    const canStart = !this.isAutoModeEnable() || this.isCanStartWSStartKnonwTemp();
    return (canStart ? this.setOnOffPoele(true) : Promise.resolve())
      .then(() => this.setRegulation(canStart ? MODE.BURNING : MODE.WAITING))
      .then(() => this.setStateOnOff());
  }

  onCapabilityRegulationMode(value) {
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
    if (!this.getCapabilityValue('onoff')) throw new Error(this.homey.__('illegalRegulationMode'));
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
    if (typeof address !== 'string' || !address.trim()) throw new Error('ERROR_NO_IP');
    const base = new URL(`http://${address.trim()}`);
    if (base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Invalid CBox address');
    const parts = isSet ? ['SET', command, value] : ['GET', command];
    return `${base.origin}/cgi-bin/sendmsg.lua?cmd=${parts.map(part => encodeURIComponent(part)).join('+')}`;
  }
  getOnOffRequestURL(on) {
    return this.getcallCboxURL('LABL', false).replace('GET+LABL', `CMD+${on ? 'ON' : 'OFF'}`);
  }
  setOnOffPoele(on) {
    if (on && !this.isIgnationAllowed()) return Promise.reject(new Error('Ignition is disabled'));
    if (on && this.stoveState !== STATE.STOPPED) return Promise.reject(new Error('Stove is not stopped'));
    return this.sendHTTPRequest(this.getOnOffRequestURL(on)).then(() => {
      // Until the next sample, prevent another decision from repeating ON/OFF.
      this.stoveState = on ? STATE.STARTING : STATE.STOPPING;
      this.pendingOff = !on;
      // The public state and its Flow trigger are updated together by polling.
    });
  }
  sendHTTPRequest(url) {
    if (this.disposed) return Promise.reject(new Error('CBox device stopped'));
    return request(url);
  }
}
module.exports = CBoxDevice;
