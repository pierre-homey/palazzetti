'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const EventEmitter = require('events');
const manifest = require('../drivers/cbox/driver.compose.json');

function load(file, homey) {
  const filename = path.resolve(__dirname, '..', file);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, require: id => id === 'homey' ? homey : require(require.resolve(id, { paths: [path.dirname(filename)] })),
    URL, Promise, Date, console,
  }, { filename });
  return module.exports;
}
const Device = load('drivers/cbox/device.js', { Device: class {} });
const Driver = load('drivers/cbox/driver.js', { Driver: class {} });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function device() {
  const d = new Device();
  const settings = { ip: '127.0.0.1' };
  const defaults = items => items.forEach(item => item.children ? defaults(item.children) : settings[item.id] = item.value);
  defaults(manifest.settings);
  settings.ip = '127.0.0.1';
  d.values = { auto_mode: true, stove_ignation: true, stove_state: 'STOPPED', stove_regulation: 'STOPPED',
    measure_temperature: 20, external_temperature: 20, target_temperature: 21, onoff: false, meter_power: 0 };
  d.store = {};
  d.events = [];
  d.commands = [];
  d.listeners = {};
  d.capabilities = new Set(manifest.capabilities);
  d.getSettings = () => settings;
  d.getCapabilityValue = id => d.values[id] == null ? null : d.values[id];
  d.setCapabilityValue = (id, value) => Promise.resolve().then(() => {
    assert.ok(d.capabilities.has(id), `Capability ${id} must exist before write`);
    d.values[id] = value;
  });
  d.getStoreValue = id => d.store[id];
  d.setStoreValue = (id, value) => Promise.resolve().then(() => { d.store[id] = value; });
  d.setSettings = values => Promise.resolve().then(() => Object.assign(settings, values));
  d.hasCapability = id => d.capabilities.has(id);
  d.addCapability = id => tick().then(() => d.capabilities.add(id));
  d.removeCapability = id => tick().then(() => d.capabilities.delete(id));
  d.registerCapabilityListener = (id, fn) => { d.listeners[id] = fn; };
  d.setAvailable = () => Promise.resolve().then(() => { d.available = true; });
  d.setUnavailable = () => Promise.resolve().then(() => { d.available = false; });
  d.error = (...args) => d.events.push(['error', ...args]);
  d.homey = new EventEmitter();
  d.homey.__ = value => value;
  d.homey.setTimeout = fn => { d.timer = fn; return 123; };
  d.homey.clearTimeout = () => { d.timer = null; };
  const card = id => ({ trigger: () => Promise.resolve().then(() => d.events.push(id)) });
  d.homey.flow = { getDeviceTriggerCard: card };
  d.driver = { triggerFlowOnStateChange: (dev, state) => Promise.resolve().then(() => d.events.push(state)) };
  d.alarmePelletsChange = card('empty');
  d.alarmePelletsChangeOff = card('reload');
  d.preAlarmePelets = card('low');
  d.sendHTTPRequest = url => Promise.resolve().then(() => { d.commands.push(url); return snapshot(); });
  d.applySettings(settings);
  d.stoveState = 'STOPPED';
  d.regulationMode = 'STOPPED';
  d.lastEnergyUpdate = Date.now();
  return d;
}
function snapshot(overrides = {}) { return { STATUS: 0, SETP: 21, PWR: 3, F2L: 2, T1: 20, PQT: 100, ...overrides }; }

test('migration waits for capability creation and first sample before scheduling', () => {
  const d = device();
  d.capabilities.clear();
  return d.onInit().then(() => {
    assert.equal(d.capabilities.size, manifest.capabilities.length);
    assert.equal(d.available, true);
    assert.equal(d.values.pellets_burned_since_load, 0);
    assert.equal(d.homey.listenerCount('unload'), 1);
    assert.ok(d.timer);
    d.onDeleted();
    assert.equal(d.timer, null);
    assert.equal(d.homey.listenerCount('unload'), 0);
  });
});

test('failed initial connection keeps polling and next update recovers', () => {
  const d = device();
  d.sendHTTPRequest = () => Promise.reject(new Error('offline'));
  return d.onInit().then(() => {
    assert.equal(d.available, false);
    assert.equal(d.values.stove_connection, true);
    assert.ok(d.timer);
    d.sendHTTPRequest = () => Promise.resolve(snapshot());
    return d.onTimeOut();
  }).then(() => {
    assert.equal(d.available, true);
    assert.equal(d.values.stove_connection, false);
  });
});

test('missing address is unavailable and remains retryable', () => {
  const d = device();
  d.stoveIp = null;
  return assert.rejects(d.onTimeOut(), /ERROR_NO_IP/).then(() => assert.equal(d.available, false));
});

test('operations serialize and rejection does not poison the queue', () => {
  const d = device();
  const gate = deferred();
  const calls = [];
  const first = d.runOperation(() => { calls.push(1); return gate.promise; });
  const failure = assert.rejects(first, /failed/);
  const second = d.runOperation(() => { calls.push(2); });
  return tick().then(() => {
    assert.deepEqual(calls, [1]);
    gate.reject(new Error('failed'));
    return Promise.all([failure, second]);
  }).then(() => assert.deepEqual(calls, [1, 2]));
});

test('overlapping polls share one request', () => {
  const d = device();
  const gate = deferred();
  let calls = 0;
  d.sendHTTPRequest = () => { calls++; return gate.promise; };
  const first = d.onTimeOut();
  assert.equal(d.onTimeOut(), first);
  return tick().then(() => { assert.equal(calls, 1); gate.resolve(snapshot()); return first; });
});

test('queued commands do not run after device deletion', () => {
  const d = device();
  const result = d.runOperation(() => { throw new Error('must not execute'); });
  d.onDeleted();
  return assert.rejects(result, /device stopped/);
});

test('frost protection does not ignite when temperature is above threshold', () => {
  const d = device();
  return d.onCapabilityRegulationMode('HORS_GEL').then(() => {
    assert.equal(d.regulationMode, 'HORS_GEL');
    assert.equal(d.values.onoff, true);
    assert.equal(d.commands.some(url => url.includes('CMD+ON')), false);
  });
});

test('frost protection respects ignition lock even below threshold', () => {
  const d = device();
  d.values.measure_temperature = 5;
  d.values.stove_ignation = false;
  return d.onCapabilityRegulationMode('HORS_GEL').then(() => {
    assert.equal(d.commands.some(url => url.includes('CMD+ON')), false);
  });
});

test('frost protection mode persists while stove is stopped', () => {
  const d = device();
  d.regulationMode = 'HORS_GEL';
  return d.updateStates(0).then(() => assert.equal(d.regulationMode, 'HORS_GEL'));
});

test('manual ignition also respects lock', () => {
  const d = device();
  d.values.auto_mode = false;
  d.values.stove_ignation = false;
  assert.throws(() => d.onCapabilityOnOff(true), /disabled/);
  return assert.rejects(d.setOnOffPoele(true), /disabled/);
});

test('unchanged temperature still allows restart when cooling completes', () => {
  const d = device();
  d.regulationMode = 'PAUSED';
  d.stoveState = 'STOPPING';
  d.values.onoff = true;
  return d.onTimeOut().then(() => {
    assert.equal(d.commands.filter(url => url.includes('CMD+ON')).length, 1);
    assert.equal(d.regulationMode, 'BURNING');
    return d.onTempChange();
  }).then(() => assert.equal(d.commands.filter(url => url.includes('CMD+ON')).length, 1));
});

test('poll publishes all temperatures before a single regulation decision', () => {
  const d = device();
  d.useExtCaptor = false;
  let decisions = 0;
  d.onTempChange = () => {
    decisions++;
    assert.equal(d.values.target_temperature, 22);
    assert.equal(d.values.measure_temperature, 24);
    return Promise.resolve();
  };
  d.sendHTTPRequest = () => Promise.resolve(snapshot({ SETP: 22, T1: 24 }));
  return d.onTimeOut().then(() => assert.equal(decisions, 1));
});

test('unknown state does not retain stale stopped state or permit ignition', () => {
  const d = device();
  return d.updateStates(99).then(() => {
    assert.equal(d.stoveState, 'UNKNOW');
    assert.equal(d.isCanStartForHG(), false);
    assert.equal(d.isCanStartWSStartKnonwTemp(), false);
  });
});

test('invalid snapshot causes no partial capability writes', () => {
  const d = device();
  d.sendHTTPRequest = () => Promise.resolve(snapshot({ PWR: 'NaN', SETP: 30 }));
  return assert.rejects(d.onTimeOut(), /Invalid PWR/).then(() => assert.equal(d.values.target_temperature, 21));
});

test('fault energy estimate does not reference undefined finalState', () => {
  const d = device();
  d.stoveState = 'FAULTED';
  d.lastEnergyUpdate = Date.now() - 3600000;
  d.values.measure_power = 100;
  d.values.meter_power = 1;
  return d.updateEnergyPowerConso().then(() => {
    assert.equal(d.values.measure_power, 1.3);
    assert.ok(Math.abs(d.values.meter_power - 1.1) < 0.0001);
  });
});

test('preset failure waits for fan acknowledgement and propagates power error', () => {
  const d = device();
  const gate = deferred();
  d.sendHTTPRequest = url => { d.commands.push(url); return d.commands.length === 1 ? gate.promise : Promise.reject(new Error('power failed')); };
  const result = d.applyPreset(4, 5);
  const failure = assert.rejects(result, /power failed/);
  assert.equal(d.commands.length, 1);
  gate.resolve({});
  return failure.then(() => {
    assert.equal(d.commands.length, 2);
    assert.equal(d.values.target_fan_speed, '5');
    assert.notEqual(d.values.target_power, '4');
  });
});

test('target temperature uses the same integer for command and capability', () => {
  const d = device();
  return d.onCapabilityTargetTemperature(20.5).then(() => {
    assert.match(d.commands[0], /SET\+SETP\+21$/);
    assert.equal(d.values.target_temperature, 21);
  });
});

test('invalid preset and command parameters are rejected before network access', () => {
  const d = device();
  d.values.auto_mode = false;
  assert.throws(() => d.applyPreset(0, 3), /Invalid power/);
  assert.throws(() => d.onCapabilityTargetFanSpeed('2+CMD+ON'), /Invalid/);
  assert.throws(() => d.setPreset(null), /Invalid/);
  assert.equal(d.commands.length, 0);
});

test('setting validation and failed address probe leave active settings unchanged', () => {
  const d = device();
  const original = d.stoveIp;
  return assert.rejects(d.onSettings({ newSettings: { ...d.settings, deltaN2: -10 } }), /Temp/)
    .then(() => {
      d.sendHTTPRequest = () => Promise.reject(new Error('offline'));
      return assert.rejects(d.onSettings({ newSettings: { ...d.settings, ip: 'new.local' } }), /offline/);
    }).then(() => assert.equal(d.stoveIp, original));
});

test('pellet baseline initializes without false consumption, then prealarm once and reload', () => {
  const d = device();
  return d.setBurnedPellets(100)
    .then(() => { assert.equal(d.values.pellets_burned_since_load, 0); return d.setBurnedPellets(111); })
    .then(() => d.setBurnedPellets(112))
    .then(() => { assert.equal(d.events.filter(e => e === 'low').length, 1); return d.setPelletsReloadDone(); })
    .then(() => {
      assert.equal(d.store.reloadDoneIndex, 112);
      assert.equal(d.values.pellets_burned_since_load, 0);
      assert.equal(d.store.prePelletsAttentionSended, false);
      return d.setBurnedPellets(1);
    }).then(() => assert.equal(d.values.pellets_burned_since_load, 0));
});

test('OFF while ignition is in progress is sent and subsequent sample does not reactivate regulation', () => {
  const d = device();
  d.stoveState = 'STARTING';
  d.regulationMode = 'BURNING';
  return d.onCapabilityOnOff(false)
    .then(() => d.updateStates(3))
    .then(() => {
      assert.ok(d.commands.some(url => url.includes('CMD+OFF')));
      assert.equal(d.regulationMode, 'STOPPED');
    });
});

test('Flow action failures reach Homey and conditions return booleans', () => {
  const driver = new Driver();
  const actions = {};
  const conditions = {};
  driver.homey = { flow: {
    getDeviceTriggerCard: () => ({}),
    getActionCard: id => ({ registerRunListener: fn => { actions[id] = fn; } }),
    getConditionCard: id => ({ registerRunListener: fn => { conditions[id] = fn; } }),
  } };
  driver.onInit();
  const d = device();
  return assert.rejects(actions.setTargetPower({ device: d, target_power: '4' }), /AUTO_MODE_ENABLED/)
    .then(() => conditions.isAutoModeEnabled({ device: d }))
    .then(value => assert.equal(value, true));
});

test('smart pause sends OFF and retains paused mode during cooling', () => {
  const d = device();
  d.stoveState = 'STARTED';
  d.regulationMode = 'BURNING';
  d.values.measure_temperature = 25;
  return d.onTempChange().then(() => {
    assert.equal(d.regulationMode, 'PAUSED');
    assert.ok(d.commands.some(url => url.includes('CMD+OFF')));
    return d.updateStates(10);
  }).then(() => assert.equal(d.regulationMode, 'PAUSED'));
});

test('disabled automatic mode does not regulate on temperature changes', () => {
  const d = device();
  d.values.auto_mode = false;
  d.regulationMode = 'WAITING_TEMP';
  return d.setExternalTemp(5).then(() => assert.equal(d.commands.length, 0));
});

test('missing temperatures do not start a waiting stove or select a preset', () => {
  const d = device();
  d.values.measure_temperature = null;
  d.regulationMode = 'WAITING_TEMP';
  return d.onTempChange().then(() => d.applyTargetPresetForCurrentTemp())
    .then(() => assert.equal(d.commands.length, 0));
});

test('capability listeners wait for writes and return their failures', () => {
  const d = device();
  return d.onInit().then(() => {
    d.setCapabilityValue = () => Promise.reject(new Error('write failed'));
    return assert.rejects(d.listeners.auto_mode(false), /write failed/);
  });
});

test('command acknowledgement does not consume the observed-state Flow transition', () => {
  const d = device();
  return d.onCapabilityOnOff(true).then(() => {
    assert.equal(d.values.stove_state, 'STOPPED');
    return d.updateStates(3);
  }).then(() => assert.ok(d.events.includes('STARTING')));
});

test('rejected ON leaves regulation and public state unchanged', () => {
  const d = device();
  d.sendHTTPRequest = () => Promise.reject(new Error('command failed'));
  return assert.rejects(d.onCapabilityOnOff(true), /command failed/).then(() => {
    assert.equal(d.regulationMode, 'STOPPED');
    assert.equal(d.stoveState, 'STOPPED');
    assert.equal(d.values.onoff, false);
  });
});

test('built device loads without Compose source files', () => {
  if (!fs.existsSync(path.resolve(__dirname, '../.homeybuild/drivers/cbox/device.js'))) return;
  const Built = load('.homeybuild/drivers/cbox/device.js', { Device: class {} });
  assert.equal(typeof Built.prototype.onInit, 'function');
});
