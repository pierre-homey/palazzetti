'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const vm = require('vm');
const path = require('path');
const EventEmitter = require('events');
const manifest = require('../drivers/cbox/driver.compose.json');
const settingsManifest = require('../drivers/cbox/driver.settings.compose.json');

function load(file, homey, dependencies = {}) {
  const filename = path.resolve(__dirname, '..', file);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, require: id => id === 'homey' ? homey : dependencies[id] || require(require.resolve(id, { paths: [path.dirname(filename)] })),
    URL, Promise, Date, console,
  }, { filename });
  return module.exports;
}
const Device = load('drivers/cbox/device.js', { Device: class {} });
const Driver = load('drivers/cbox/driver.js', { Driver: class {} });
const App = load('app.js', { App: class {} });
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
  defaults(settingsManifest);
  settings.ip = '127.0.0.1';
  d.values = { auto_mode: true, stove_ignation: true, stove_state: 'STOPPED', stove_regulation: 'STOPPED',
    measure_temperature: 20, external_temperature: 20, target_temperature: 21, onoff: false, meter_power: 0 };
  d.available = true;
  d.store = {};
  d.events = [];
  d.dashboardEvents = [];
  d.commands = [];
  d.listeners = {};
  d.capabilities = new Set(manifest.capabilities);
  d.getSettings = () => settings;
  d.getData = () => ({ id: 'test-device' });
  d.id = 'homey-device-id';
  d.getName = () => 'CBox';
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
  d.homey.api = { realtime: (event, data) => {
    d.dashboardEvents.push({ event, data });
    return Promise.resolve();
  } };
  d.homey.setTimeout = fn => { d.timer = fn; return 123; };
  d.homey.clearTimeout = () => { d.timer = null; };
  const card = id => ({ trigger: () => Promise.resolve().then(() => d.events.push(id)) });
  d.homey.flow = { getDeviceTriggerCard: card };
  d.driver = { triggerFlowOnStateChange: (dev, state) => Promise.resolve().then(() => d.events.push(state)) };
  d.alarmePelletsChange = card('empty');
  d.alarmePelletsChangeOff = card('reload');
  d.preAlarmePelets = card('low');
  d.temperatureAboveTargetFlow = card('temperature_above_target');
  d.powerFanChangeFlow = { trigger: () => Promise.resolve() };
  d.sendHTTPRequest = url => Promise.resolve().then(() => { d.commands.push(url); return snapshot(); });
  d.applySettings(settings);
  d.stoveState = 'STOPPED';
  d.regulationMode = 'STOPPED';
  d.lastEnergyUpdate = Date.now();
  return d;
}
function snapshot(overrides = {}) { return { STATUS: 0, SETP: 21, PWR: 3, F2L: 2, T1: 20, PQT: 100, ...overrides }; }

test('dashboard lookup uses the selected paired CBox identifier', async () => {
  const app = new App();
  const device = {
    getData: () => ({ id: 'paired-cbox-id' }),
    getName: () => 'CBox',
    getCapabilityValue: id => ({
      target_temperature: 21,
      measure_temperature: 20,
      target_power: '3',
      target_fan_speed: '2',
      stove_state: 'STARTED',
    })[id],
  };
  app.homey = {
    drivers: { getDriver: id => {
      assert.equal(id, 'cbox');
      return { getDevices: () => [device] };
    } },
  };

  const data = await app.getStoveDashboardData('paired-cbox-id');
  assert.equal(data.deviceId, 'paired-cbox-id');
  assert.equal(data.sourceId, 'paired-cbox-id');
  assert.equal(data.name, 'CBox');
  assert.equal(data.targetTemperature, 21);
  assert.equal(data.temperature, 20);
  assert.equal(data.power, '3');
  assert.equal(data.fanSpeed, '2');
  assert.equal(data.state, 'STARTED');
});

test('widget autocomplete lists current CBox devices and filters by name', async () => {
  const app = new App();
  let autocomplete;
  let devices = [
    { getData: () => ({ id: 'a' }), getName: () => 'Salon' },
    { getData: () => ({ id: 'b' }), getName: () => 'Étage' },
  ];
  app.log = () => {};
  app.homey = {
    dashboards: { getWidget: id => {
      assert.equal(id, 'stove-dashboard');
      return { registerSettingAutocompleteListener: (setting, listener) => {
        assert.equal(setting, 'stove');
        autocomplete = listener;
      } };
    } },
    drivers: { getDriver: () => ({ getDevices: () => devices }) },
    __: key => key,
  };
  await app.onInit();
  assert.equal((await autocomplete('')).length, 2);
  const matches = await autocomplete('SAL');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, 'a');
  devices = [];
  assert.equal((await autocomplete('')).length, 0);
  await assert.rejects(app.getStoveDashboardData('a'), /not found/);
  await assert.rejects(app.getStoveDashboardData(undefined), /Select a stove/);
});

test('migration waits for capability creation and first sample before scheduling', () => {
  const d = device();
  d.capabilities.clear();
  d.capabilities.add('stove_connection');
  return d.onInit().then(() => {
    assert.equal(d.capabilities.size, manifest.capabilities.length);
    assert.equal(d.capabilities.has('stove_connection'), false);
    assert.equal(d.available, true);
    assert.equal(d.values.pellets_burned_since_load, 0);
    assert.equal(d.homey.listenerCount('unload'), 1);
    assert.ok(d.timer);
    d.onDeleted();
    assert.equal(d.timer, null);
    assert.equal(d.homey.listenerCount('unload'), 0);
  });
});

test('external temperature stale Flow waits for ON and alerts immediately when turned on', async () => {
  const d = device();
  await d.onInit();
  assert.equal(d.settings.externalTempTimeout, 30);
  assert.equal(d.events.includes('external_temperature_stale'), false);

  const timeout = d.settings.externalTempTimeout * 60000;
  d.lastExternalTemperatureUpdate = Date.now() - timeout - 1;
  await d.checkExternalTemperatureFreshness();
  assert.equal(d.events.includes('external_temperature_stale'), false);
  assert.equal(d.getDashboardValues().temperatureStale, true);

  d.regulationMode = 'BURNING';
  await d.setStateOnOff();
  await d.checkExternalTemperatureFreshness();
  assert.equal(d.events.filter(event => event === 'external_temperature_stale').length, 1);

  d.regulationMode = 'STOPPED';
  await d.setStateOnOff();
  d.regulationMode = 'BURNING';
  await d.setStateOnOff();
  assert.equal(d.events.filter(event => event === 'external_temperature_stale').length, 2);

  d.regulationMode = 'STOPPED';
  await d.setStateOnOff();
  await d.setExternalTemp(21);
  assert.equal(d.externalTemperatureStaleNotified, false);
  assert.equal(d.getDashboardValues().temperatureStale, false);
  d.lastExternalTemperatureUpdate = Date.now() - timeout - 1;
  await d.onSettings({ newSettings: { ...d.settings, externalTerm: false } });
  await d.checkExternalTemperatureFreshness();
  assert.equal(d.events.filter(event => event === 'external_temperature_stale').length, 2);

  await d.onSettings({ newSettings: { ...d.settings, externalTerm: true } });
  assert.equal(d.events.filter(event => event === 'external_temperature_stale').length, 2);
  d.regulationMode = 'BURNING';
  await d.setStateOnOff();
  assert.equal(d.events.filter(event => event === 'external_temperature_stale').length, 3);
});

test('poll scheduling aligns to the next minute instead of drifting', () => {
  const d = device();
  const calls = [];
  d.homey.setTimeout = (fn, delay) => { calls.push(delay); return 123; };
  d.schedulePoll();
  assert.equal(calls.length, 1);
  const expected = 60000 - (Date.now() % 60000);
  assert.ok(Math.abs(calls[0] - expected) < 1000, `expected ~${expected}ms, got ${calls[0]}ms`);
});

test('failed initial connection keeps polling and next update recovers', () => {
  const d = device();
  d.sendHTTPRequest = () => Promise.reject(new Error('offline'));
  return d.onInit().then(() => {
    assert.equal(d.available, true);
    assert.equal(d.events.filter(event => event[0] === 'error').length, 0);
    assert.equal(d.communicationFailureCount, 1);
    assert.ok(d.timer);
    d.sendHTTPRequest = () => Promise.resolve(snapshot());
    return d.onTimeOut();
  }).then(() => {
    assert.equal(d.available, true);
    assert.equal(d.communicationFailureCount, 0);
  });
});

test('missing address rejects without marking device unavailable', () => {
  const d = device();
  d.stoveIp = null;
  return assert.rejects(d.onTimeOut(), /IP address/).then(() => assert.equal(d.available, true));
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

test('deleting device cancels an in-flight poll without marking it unavailable', t => {
  let received;
  const requestReceived = new Promise(resolve => { received = resolve; });
  const server = http.createServer(() => received());
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve)).then(() => {
    const d = device();
    delete d.sendHTTPRequest;
    d.stoveIp = `127.0.0.1:${server.address().port}`;
    let unavailableCalls = 0;
    d.setUnavailable = () => { unavailableCalls++; return Promise.resolve(); };
    const poll = d.onTimeOut();
    return requestReceived.then(() => {
      d.onDeleted();
      return assert.rejects(poll, /cancelled/);
    }).then(() => {
      assert.equal(unavailableCalls, 0);
      assert.equal(d.values.stove_connection, undefined);
      assert.equal(d.values.alarm_connectivity, undefined);
      assert.equal(d.timer, undefined);
    });
  });
});

for (const [name, status, body] of [
  ['HTTP error', 503, '{}'],
  ['invalid JSON', 200, '{'],
  ['rejected command', 200, '{"SUCCESS":false}'],
  ['broken connection', null, null],
]) {
  test(`connectivity alarm activates only after two consecutive failures on ${name} and clears on recovery`, t => {
    let failing = true;
    const server = http.createServer((req, res) => {
      if (failing && status === null) { req.socket.destroy(); return; }
      res.statusCode = failing ? status : 200;
      res.end(failing ? body : JSON.stringify({ SUCCESS: true, DATA: snapshot() }));
    });
    t.after(() => new Promise(resolve => {
      server.closeAllConnections();
      server.close(resolve);
    }));
    return new Promise(resolve => server.listen(0, '127.0.0.1', resolve)).then(async () => {
      const d = device();
      delete d.sendHTTPRequest;
      d.stoveIp = `127.0.0.1:${server.address().port}`;
      d.values.alarm_connectivity = false;
      d.values.auto_mode = false;
      await assert.rejects(d.onCapabilityTargetPower(4));
      assert.equal(d.values.alarm_connectivity, false);
      assert.notEqual(d.values.target_power, '4');
      await assert.rejects(d.onTimeOut());
      assert.equal(d.available, true);
      assert.equal(d.values.alarm_connectivity, false);
      await assert.rejects(d.onTimeOut());
      assert.equal(d.values.alarm_connectivity, true);
      failing = false;
      await d.onTimeOut();
      assert.equal(d.values.alarm_connectivity, false);
      assert.equal(d.available, true);
      assert.equal(d.values.target_temperature, 21);
    });
  });
}

for (const failedCommand of ['RFAN', 'POWR']) {
  test(`automatic ${failedCommand} failure keeps polling and retries after resynchronization`, async t => {
    let failing = true;
    const commands = [];
    const state = snapshot({ STATUS: 6, PWR: 2, F2L: 1 });
    const server = http.createServer((req, res) => {
      const command = new URL(req.url, 'http://localhost').searchParams.get('cmd');
      commands.push(command);
      const [action, name, value] = command.split(' ');
      if (action === 'SET' && name === failedCommand && failing) {
        res.statusCode = 503;
        res.end('{}');
        return;
      }
      if (action === 'SET') state[name === 'RFAN' ? 'F2L' : 'PWR'] = Number(value);
      res.end(JSON.stringify({ SUCCESS: true, DATA: state }));
    });
    t.after(() => new Promise(resolve => {
      server.closeAllConnections();
      server.close(resolve);
    }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const d = device();
    delete d.sendHTTPRequest;
    d.getSettings().ip = `127.0.0.1:${server.address().port}`;
    await d.onInit();
    assert.equal(d.available, true);
    assert.equal(d.values.alarm_connectivity, false);
    assert.equal(d.values.target_fan_speed, failedCommand === 'POWR' ? '2' : '1');
    assert.equal(d.values.target_power, '2');
    assert.ok(d.timer);
    commands.length = 0;
    failing = false;
    const regulate = d.onTempChange.bind(d);
    d.onTempChange = () => {
      assert.equal(d.values.target_power, String(state.PWR));
      assert.equal(d.values.target_fan_speed, String(state.F2L));
      return regulate();
    };
    // Wait for freshness checking, polling, regulation and timer rescheduling.
    await d.timer();
    assert.deepEqual(commands, ['GET ALLS', 'SET RFAN 2', 'SET POWR 3']);
    assert.equal(d.values.alarm_connectivity, false);
    assert.equal(d.values.target_power, '3');
    assert.equal(d.available, true);
    assert.ok(d.timer);
    d.onDeleted();
  });
}

test('a single transient poll failure does not raise the connectivity alarm', async () => {
  const d = device();
  d.values.alarm_connectivity = false;
  d.communicationFailureCount = 0;
  d.sendHTTPRequest = () => Promise.reject(new Error('timeout'));
  await assert.rejects(d.onTimeOut(), /timeout/);
  assert.equal(d.values.alarm_connectivity, false);
  assert.equal(d.communicationFailureCount, 1);
  d.sendHTTPRequest = () => Promise.resolve(snapshot());
  await d.onTimeOut();
  assert.equal(d.values.alarm_connectivity, false);
  assert.equal(d.communicationFailureCount, 0);
});

test('Homey write failure does not raise a connectivity alarm or mark device unavailable', async () => {
  const d = device();
  d.values.alarm_connectivity = false;
  d.setCapabilityValue = () => Promise.reject(new Error('write failed'));
  await assert.rejects(d.onTimeOut(), /write failed/);
  assert.equal(d.values.alarm_connectivity, false);
  assert.equal(d.available, true);
});

test('late successful poll response after deletion cannot write to Homey', async () => {
  const d = device();
  const gate = deferred();
  d.sendHTTPRequest = () => gate.promise;
  let writes = 0;
  d.setCapabilityValue = () => { writes++; return Promise.resolve(); };
  const poll = d.onTimeOut();
  await tick();
  d.onDeleted();
  gate.resolve(snapshot());
  await assert.rejects(poll, /device has stopped/);
  assert.equal(writes, 0);
  assert.deepEqual(d.events, []);
  assert.equal(d.timeoutId, null);
});

for (const fails of [false, true]) {
  test(`deletion during Homey write stops remaining updates (${fails ? 'Not Found' : 'success'})`, async () => {
    const d = device();
    const gate = deferred();
    let writes = 0;
    d.setCapabilityValue = () => { writes++; return gate.promise; };
    d.setAvailable = () => { throw new Error('must not mark available'); };
    const poll = d.onTimeOut();
    await tick();
    assert.equal(writes, 1);
    d.onDeleted();
    if (fails) gate.reject(new Error('Not Found: Device with ID deleted-device'));
    else gate.resolve();
    await assert.rejects(poll, /device has stopped/);
    assert.equal(writes, 1);
    assert.deepEqual(d.events, []);
    assert.equal(d.timeoutId, null);
  });
}

test('unexpected Not Found is preserved and logged while device is active', async () => {
  const d = device();
  const error = new Error('Not Found: Device with ID unexpected-device');
  d.sendHTTPRequest = () => Promise.reject(error);
  d.values.alarm_connectivity = false;
  await assert.rejects(d.onTimeOut(), actual => actual === error);
  assert.equal(d.events.length, 0);
  assert.equal(d.values.alarm_connectivity, false);
  assert.equal(d.disposed, undefined);
});

test('queued commands do not run after device deletion', () => {
  const d = device();
  const result = d.runOperation(() => { throw new Error('must not execute'); });
  d.onDeleted();
  return assert.rejects(result, /device has stopped/);
});

test('frost protection does not ignite when temperature is above threshold', () => {
  const d = device();
  d.values.onoff = true;
  return d.onCapabilityRegulationMode('HORS_GEL').then(() => {
    assert.equal(d.regulationMode, 'HORS_GEL');
    assert.equal(d.values.onoff, true);
    assert.equal(d.commands.some(url => url.includes('CMD+ON')), false);
  });
});

test('frost protection respects ignition lock even below threshold', () => {
  const d = device();
  d.values.onoff = true;
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

test('allowing ignition while stopped immediately reevaluates automatic start', async () => {
  const d = device();
  d.regulationMode = 'WAITING_TEMP';
  d.values.stove_regulation = 'WAITING_TEMP';
  d.values.stove_ignation = false;
  d.values.measure_temperature = 15;

  await d.setIgnationAllowed(true);

  assert.equal(d.values.stove_ignation, true);
  assert.equal(d.stoveState, 'STARTING');
  assert.equal(d.commands.some(url => url.includes('CMD+ON')), true);
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

test('CBox ignition test status is exposed as starting', async () => {
  const d = device();
  await d.updateStates(5);
  assert.equal(d.stoveState, 'STARTING');
  assert.equal(d.values.stove_state, 'STARTING');
});

test('documented CBox statuses map to the existing public states', async () => {
  const expected = {
    2: 'STARTING', 4: 'STARTING', 5: 'STARTING',
    11: 'STARTED', 14: 'STARTING', 15: 'STARTING', 16: 'STARTING',
    17: 'STARTED', 18: 'STARTED',
    12: 'STOPPING', 19: 'STOPPING',
    13: 'STOPPED', 20: 'STOPPED',
    21: 'FAULTED', 22: 'FAULTED',
  };
  for (const [status, state] of Object.entries(expected)) {
    const d = device();
    await d.updateStates(Number(status));
    assert.equal(d.stoveState, state, `STATUS ${status}`);
  }
});

test('CBox cool-fluid status remains unknown', async () => {
  const d = device();
  await d.updateStates(9);
  assert.equal(d.stoveState, 'UNKNOW');
});

test('invalid snapshot causes no partial capability writes', () => {
  const d = device();
  d.sendHTTPRequest = () => Promise.resolve(snapshot({ PWR: 'NaN', SETP: 30 }));
  return assert.rejects(d.onTimeOut(), /Invalid PWR/).then(() => assert.equal(d.values.target_temperature, 21));
});

test('invalid CBox ambient temperature is not published or used for regulation', async () => {
  const d = device();
  d.useExtCaptor = false;
  d.values.internal_temperature = 19;
  d.values.measure_temperature = 20;
  let decisions = 0;
  d.onTempChange = () => { decisions++; return Promise.resolve(); };
  d.sendHTTPRequest = () => Promise.resolve(snapshot({ T1: 41 }));

  await d.onTimeOut();
  assert.equal(d.validateSnapshot(snapshot({ T1: 0 })).temperatureValid, true);
  assert.equal(d.validateSnapshot(snapshot({ T1: 40 })).temperatureValid, true);
  assert.equal(d.values.internal_temperature, 19);
  assert.equal(d.values.measure_temperature, 20);
  assert.equal(decisions, 0);
  assert.equal(d.values.alarm_connectivity, false);
});

test('external ambient temperature limits are inclusive and rejected values do not refresh data', async () => {
  const d = device();
  d.lastExternalTemperatureUpdate = Date.now();
  const previousTimestamp = d.lastExternalTemperatureUpdate;
  await d.setExternalTemp(0);
  await d.setExternalTemp(40);
  assert.equal(d.values.external_temperature, 40);

  const acceptedTimestamp = d.lastExternalTemperatureUpdate;
  assert.throws(() => d.setExternalTemp(40.1), /Invalid external temperature/);
  assert.equal(d.values.external_temperature, 40);
  assert.equal(d.lastExternalTemperatureUpdate, acceptedTimestamp);
  assert.ok(acceptedTimestamp >= previousTimestamp);

  await assert.rejects(d.onSettings({ newSettings: { ...d.settings, temperatureMin: 40 } }), /Invalid ambient/);
  assert.equal(d.settings.temperatureMin, 0);
  await d.onSettings({ newSettings: { ...d.settings, temperatureMin: -5, temperatureMax: 45 } });
  await d.setExternalTemp(-5);
  await d.setExternalTemp(45);
  assert.equal(d.values.external_temperature, 45);
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

test('saving settings immediately reevaluates Smart Pause with the new delta', async () => {
  const d = device();
  d.stoveState = 'STARTED';
  d.regulationMode = 'BURNING';
  d.values.target_temperature = 21;
  d.values.internal_temperature = 23;

  await d.onSettings({ newSettings: { ...d.settings, externalTerm: false, pauseTemp: 1 } });

  assert.equal(d.tempSmartPause, 1);
  assert.equal(d.regulationMode, 'PAUSED');
  assert.ok(d.commands.some(url => url.includes('CMD+OFF')));
});

test('settings-triggered temperature evaluation is serialized with queued operations', async () => {
  const d = device();
  const evaluationStarted = deferred();
  const finishFirstEvaluation = deferred();
  let evaluations = 0;
  let activeEvaluations = 0;
  let maxActiveEvaluations = 0;
  d.onTempChange = () => {
    evaluations++;
    activeEvaluations++;
    maxActiveEvaluations = Math.max(maxActiveEvaluations, activeEvaluations);
    if (evaluations === 1) {
      evaluationStarted.resolve();
      return finishFirstEvaluation.promise.finally(() => { activeEvaluations--; });
    }
    activeEvaluations--;
    return Promise.resolve();
  };

  const settingsUpdate = d.onSettings({ newSettings: { ...d.settings, pauseTemp: 2 } });
  await evaluationStarted.promise;
  const queuedEvaluation = d.runOperation(() => d.onTempChange());
  await tick();
  assert.equal(evaluations, 1);

  finishFirstEvaluation.resolve();
  await Promise.all([settingsUpdate, queuedEvaluation]);
  assert.equal(evaluations, 2);
  assert.equal(maxActiveEvaluations, 1);
});

test('pellet baseline initializes without false consumption, then prealarm once and reload', () => {
  const d = device();
  return d.setBurnedPellets(100)
    .then(() => { assert.equal(d.values.pellets_burned_since_load, 0); return d.setBurnedPellets(111); })
    .then(() => d.setBurnedPellets(112))
    .then(() => {
      assert.equal(d.events.filter(e => e === 'low').length, 1);
      assert.equal(d.getDashboardValues().pelletsLow, true);
      return d.setPelletsReloadDone();
    })
    .then(() => {
      assert.equal(d.store.reloadDoneIndex, 112);
      assert.equal(d.values.pellets_burned_since_load, 0);
      assert.equal(d.store.prePelletsAttentionSended, false);
      assert.equal(d.getDashboardValues().pelletsLow, false);
      return d.setBurnedPellets(1);
    }).then(() => assert.equal(d.values.pellets_burned_since_load, 0));
});

for (const initialState of ['STARTED', 'STOPPING']) {
  test(`UI OFF stays off through shutdown and late samples from ${initialState}`, async () => {
    const d = device();
    d.stoveState = initialState;
    d.regulationMode = 'BURNING';
    d.values.onoff = true;
    const displayed = [];
    const write = d.setCapabilityValue;
    d.setCapabilityValue = (id, value) => {
      if (id === 'onoff') displayed.push(value);
      return write(id, value);
    };
    await d.onCapabilityOnOff(false);
    for (const status of [6, 10, 99, 6, 10, 0]) {
      d.sendHTTPRequest = () => Promise.resolve(snapshot({ STATUS: status }));
      await d.onTimeOut();
      assert.equal(d.values.onoff, false);
      assert.equal(d.regulationMode, 'STOPPED');
      assert.equal(d.pendingOff, status !== 0);
    }
    assert.ok(displayed.every(value => value === false));
    assert.equal(d.commands.filter(url => url.includes('CMD+OFF')).length,
      initialState === 'STARTED' ? 1 : 0);
    assert.equal(d.commands.some(url => url.includes('CMD+ON')), false);
    // Once shutdown is confirmed, a later physical ignition is still reflected.
    await d.updateAllStates(snapshot({ STATUS: 3 }));
    assert.equal(d.values.onoff, true);
  });
}

test('ON during shutdown is rejected explicitly and never deferred', async () => {
  const d = device();
  d.stoveState = 'STOPPING';
  assert.throws(() => d.onCapabilityOnOff(true), /waitForStop/);
  assert.equal(d.values.onoff, false);
  assert.equal(d.commands.length, 0);
  d.pendingOff = true;
  await d.updateAllStates(snapshot({ STATUS: 6 }));
  assert.throws(() => d.onCapabilityOnOff(true), /waitForStop/);
  await d.onTimeOut();
  assert.equal(d.values.onoff, false);
  assert.equal(d.commands.some(url => url.includes('CMD+ON')), false);
  d.values.auto_mode = false;
  await d.onCapabilityOnOff(true);
  assert.equal(d.values.onoff, true);
  assert.equal(d.commands.filter(url => url.includes('CMD+ON')).length, 1);
});

test('failed UI OFF preserves the active mode and button', async () => {
  const d = device();
  d.stoveState = 'STARTED';
  d.regulationMode = 'BURNING';
  d.values.onoff = true;
  d.sendHTTPRequest = () => Promise.reject(new Error('offline'));
  await assert.rejects(d.onCapabilityOnOff(false), /offline/);
  assert.equal(d.values.onoff, true);
  assert.equal(d.regulationMode, 'BURNING');
  assert.notEqual(d.pendingOff, true);
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
    getDeviceTriggerCard: () => ({ registerRunListener: () => {} }),
    getActionCard: id => ({ registerRunListener: fn => { actions[id] = fn; } }),
    getConditionCard: id => ({ registerRunListener: fn => { conditions[id] = fn; } }),
  } };
  driver.onInit();
  const d = device();
  return assert.rejects(actions.setTargetPower({ device: d, target_power: '4' }), /Disable automatic mode/)
    .then(() => conditions.isAutoModeEnabled({ device: d }))
    .then(value => assert.equal(value, true));
});

test('UI and Flow reject every regulation mode while onoff is OFF', async () => {
  const driver = new Driver();
  const actions = {};
  driver.homey = { flow: {
    getDeviceTriggerCard: () => ({ registerRunListener: () => {} }),
    getActionCard: id => ({ registerRunListener: fn => { actions[id] = fn; } }),
    getConditionCard: () => ({ registerRunListener: () => {} }),
  } };
  driver.onInit();
  const d = device();
  await d.onInit();
  for (const state of ['STOPPED', 'BURNING', 'SILENTLY', 'PAUSED', 'HORS_GEL', 'WAITING_TEMP']) {
    const before = { ...d.values };
    const commands = d.commands.length;
    await assert.rejects(d.listeners.stove_regulation(state), /illegalRegulationMode/);
    await assert.rejects(actions.setRegulationInState({ device: d, state }), /illegalRegulationMode/);
    assert.deepEqual(d.values, before);
    assert.equal(d.regulationMode, 'STOPPED');
    assert.equal(d.commands.length, commands);
  }
  d.onDeleted();
});

test('state-specific Flow only matches the selected new stove state', async () => {
  const driver = new Driver();
  const listeners = {};
  const events = [];
  driver.homey = { flow: {
    getDeviceTriggerCard: id => ({
      registerRunListener: fn => { listeners[id] = fn; },
      trigger: (device, tokens, state) => {
        events.push({ id, device, tokens, state });
        return Promise.resolve();
      },
    }),
    getActionCard: () => ({ registerRunListener: () => {} }),
    getConditionCard: () => ({ registerRunListener: () => {} }),
  } };
  driver.onInit();
  const d = device();
  d.driver = driver;
  await d.updateStates(6);
  assert.equal(events.length, 2);
  const event = events.find(item => item.id === 'on_state_change_to');
  assert.equal(event.device, d);
  assert.equal(event.tokens.state, 'STARTED');
  const matches = listeners.on_state_change_to;
  const card = require('../.homeycompose/flow/triggers/on_state_change_to.json');
  for (const value of card.args[1].values) {
    assert.equal(await matches({ state: value.id }, event.state), value.id === 'STARTED');
    assert.equal(await matches({ state: value.id }, { state: value.id }), true);
  }
  await d.updateStates(6);
  assert.equal(events.length, 2);
});

test('power and fan Flow fires once for changed values while starting or burning', async () => {
  const d = device();
  const events = [];
  d.values.target_power = '3';
  d.values.target_fan_speed = '2';
  d.applySettings({ ...d.settings, externalTerm: false });
  d.powerFanChangeFlow = { trigger: async (dev, tokens) => events.push({ dev, tokens }) };

  await d.updateAllStates(snapshot({ STATUS: 6, PWR: 4, F2L: 5, T1: 19 }));
  assert.equal(events.length, 1);
  assert.equal(events[0].dev, d);
  assert.equal(events[0].tokens.temperature, 19);
  assert.equal(events[0].tokens.power, 4);
  assert.equal(events[0].tokens.fan_speed, 5);

  await d.updateAllStates(snapshot({ STATUS: 6, PWR: 4, F2L: 5, T1: 19 }));
  assert.equal(events.length, 1);

  await d.updateAllStates(snapshot({ STATUS: 0, PWR: 3, F2L: 4, T1: 18 }));
  assert.equal(events.length, 1);

  await d.updateAllStates(snapshot({ STATUS: 3, PWR: 2, F2L: 3, T1: 17 }));
  assert.equal(events.length, 2);
  assert.equal(events[1].tokens.temperature, 17);
  assert.equal(events[1].tokens.power, 2);
  assert.equal(events[1].tokens.fan_speed, 3);
});

test('dashboard updates are pushed as complete snapshots only when values change', async () => {
  const d = device();
  d.applySettings({ ...d.settings, externalTerm: false });
  d.values.target_power = '3';
  d.values.target_fan_speed = '2';

  await d.updateAllStates(snapshot({ STATUS: 6, SETP: 22, PWR: 4, F2L: 5, T1: 19 }));
  assert.equal(d.dashboardEvents.length, 1);
  assert.equal(d.dashboardEvents[0].event, 'stove_dashboard_update');
  assert.equal(d.dashboardEvents[0].data.sourceId, 'test-device');
  assert.equal(d.dashboardEvents[0].data.targetTemperature, 22);
  assert.equal(d.dashboardEvents[0].data.temperature, 19);
  assert.equal(d.dashboardEvents[0].data.power, '4');
  assert.equal(d.dashboardEvents[0].data.fanSpeed, '5');
  assert.equal(d.dashboardEvents[0].data.state, 'STARTED');

  await d.updateAllStates(snapshot({ STATUS: 6, SETP: 22, PWR: 4, F2L: 5, T1: 19 }));
  assert.equal(d.dashboardEvents.length, 1);
});

test('preset Flow receives the new power and fan values together', async () => {
  const d = device();
  const events = [];
  d.stoveState = 'STARTED';
  d.values.target_power = '3';
  d.values.target_fan_speed = '2';
  d.powerFanChangeFlow = { trigger: async (dev, tokens) => events.push(tokens) };

  await d.applyPreset(4, 5);

  assert.equal(events.length, 1);
  assert.equal(events[0].power, 4);
  assert.equal(events[0].fan_speed, 5);
});

test('external temperature regulation publishes a power and fan change only once', async () => {
  const d = device();
  const events = [];
  d.applySettings({ ...d.settings, externalTerm: true });
  d.stoveState = 'STARTED';
  d.values.target_power = '4';
  d.values.target_fan_speed = '5';
  d.powerFanChangeFlow = { trigger: async (dev, tokens) => events.push(tokens) };
  d.onTempChange = () => d.applyPreset(1, 3);

  await d.setExternalTemp(19.5);

  assert.equal(events.length, 1);
  assert.equal(events[0].temperature, 19.5);
  assert.equal(events[0].power, 1);
  assert.equal(events[0].fan_speed, 3);
  await d.setExternalTemp(19.5);
  assert.equal(events.length, 1);
  await d.setExternalTemp(20);
  assert.equal(events.length, 1);
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


test('temperature threshold crosses once per offset and rearms below the threshold', async () => {
  const d = device();
  const driver = new Driver();
  let matches;
  const crossings = [];
  driver.homey = { flow: {
    getDeviceTriggerCard: id => ({ registerRunListener: fn => {
      if (id === 'temperature_above_target') matches = fn;
    } }),
    getActionCard: () => ({ registerRunListener: () => {} }),
    getConditionCard: () => ({ registerRunListener: () => {} }),
  } };
  driver.onInit();
  d.temperatureAboveTargetFlow = { trigger: async (dev, tokens, state) => {
    for (const delta of [1, 2, 3]) {
      if (await matches({ delta }, state)) crossings.push({ delta, tokens });
    }
    assert.equal(await matches({ delta: -1 }, state), false);
  } };
  d.values.auto_mode = false;
  await d.checkTemperatureAboveTarget();
  await d.setCurrentTemp(23);
  assert.deepEqual(crossings.map(event => event.delta), [1, 2]);
  assert.equal(crossings[1].tokens.temperature, 23);
  assert.equal(crossings[1].tokens.target, 21);
  await d.setCurrentTemp(23);
  await d.setCurrentTemp(23.5);
  assert.equal(crossings.length, 2);
  await d.setCurrentTemp(22);
  await d.setCurrentTemp(23);
  assert.deepEqual(crossings.map(event => event.delta), [1, 2, 2]);
  await d.setTargetTemperature(20);
  assert.deepEqual(crossings.map(event => event.delta), [1, 2, 2, 3]);
});

test('temperature threshold uses external sensor and evaluates complete polling samples', async () => {
  const d = device();
  const events = [];
  d.temperatureAboveTargetFlow = { trigger: async (dev, tokens, state) => events.push(state) };
  await d.checkTemperatureAboveTarget();
  // Both temperatures change, but their final difference stays unchanged.
  await d.updateAllStates(snapshot({ SETP: 23, T1: 22 }));
  assert.equal(events.length, 0);
  d.applySettings({ ...d.settings, externalTerm: true });
  await d.setInternalTemp(30);
  assert.equal(events.length, 0);
  await d.setExternalTemp(25);
  assert.equal(events.length, 1);
  assert.equal(events[0].delta, 2);
  d.values.measure_temperature = null;
  await d.checkTemperatureAboveTarget();
  assert.equal(events.length, 1);
});
