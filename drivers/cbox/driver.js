'use strict';
const Homey = require('homey');
const crypto = require('crypto');

class CboxDriver extends Homey.Driver {
  onPair(session) {
    const devices = [{ name: 'CBox', data: { id: crypto.randomBytes(16).toString('hex') } }];
    session.setHandler('list_devices', () => Promise.resolve(devices));
  }

  triggerFlowOnStateChange(device, state) {
    return this.onChangeState.trigger(device, { state }, {})
      .then(() => this.onChangeStateTo.trigger(device, { state }, { state }));
  }

  onInit() {
    this.temperatureAboveTarget = this.homey.flow.getDeviceTriggerCard('temperature_above_target');
    this.temperatureAboveTarget.registerRunListener((args, state) => {
      const delta = args.delta;
      return Promise.resolve(typeof delta === 'number' && Number.isFinite(delta) && delta >= 0
        && state.previousDelta < delta && state.delta >= delta);
    });
    this.onChangeState = this.homey.flow.getDeviceTriggerCard('on_state_change');
    this.onChangeStateTo = this.homey.flow.getDeviceTriggerCard('on_state_change_to');
    this.onChangeStateTo.registerRunListener((args, state) => Promise.resolve(args.state === state.state));
    const actions = {
      setTargetPower: args => args.device.onCapabilityTargetPower(args.target_power),
      setTargetFanSpeed: args => args.device.onCapabilityTargetFanSpeed(args.target_fan_speed),
      setPreset: args => args.device.setPreset(args.preset),
      setRegulationInState: args => args.device.onCapabilityRegulationMode(args.state),
      setExternalTemp: args => args.device.setExternalTemp(args.temperature),
      setSmartPause: args => args.device.setSmartPause(String(args.smartPause) === '1'),
      setIgnationAllowed: args => args.device.setIgnationAllowed(String(args.ignationAllowed) === '1'),
      setAutoMode: args => args.device.enableAutoMode(String(args.selectedMode) === '1'),
      setPelletsReload: args => args.device.setPelletsReloadDone(),
      setAllowSilenceMode: args => args.device.setSilenceMode(args.enabled),
    };
    Object.entries(actions).forEach(([id, action]) => {
      this.homey.flow.getActionCard(id).registerRunListener(args =>
        args.device.runOperation(() => action(args)).then(() => true));
    });
    const conditions = {
      isRegulationInState: args => args.device.isRegulationMode(args.state),
      isSmartStartEnabled: args => args.device.isSmartStartEnabled(),
      isSmartPauseEnabled: args => args.device.isSmartPauseEnabled(),
      isIgnationAllowed: args => args.device.isIgnationAllowed(),
      isAutoModeEnabled: args => args.device.isAutoModeEnable(),
    };
    Object.entries(conditions).forEach(([id, condition]) => {
      this.homey.flow.getConditionCard(id).registerRunListener(args =>
        Promise.resolve().then(() => condition(args)));
    });
  }
}
module.exports = CboxDriver;
