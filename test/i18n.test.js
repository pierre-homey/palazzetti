'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const { localizedError } = require('../lib/i18n');
const locales = { en: require('../locales/en.json'), fr: require('../locales/fr.json') };
const lookup = language => (key, parameters = {}) => {
  const value = key.split('.').reduce((object, part) => object?.[part], locales[language]);
  assert.equal(typeof value, 'string', `Missing ${language} translation: ${key}`);
  return Object.entries(parameters).reduce((text, [name, replacement]) =>
    text.replaceAll(`__${name}__`, replacement), value);
};

for (const language of ['fr', 'en']) {
  test(`widget renders states, accessibility labels and errors in ${language}`, async () => {
    const root = {};
    const document = { documentElement: {}, getElementById: () => root };
    const html = fs.readFileSync('widgets/stove-dashboard/public/index.html', 'utf8');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const context = vm.createContext({ document, console: { error() {} } });
    vm.runInContext(script, context);
    const homey = { __: lookup(language), ready() {}, on() {}, getSettings: () => ({}) };
    context.onHomeyReady(homey);
    assert.equal(document.documentElement.lang, language);
    assert.equal(root.textContent, locales[language].widget.select);
    for (const state of ['STARTING', 'STARTED', 'STOPPING', 'STOPPED', 'FAULTED', 'UNKNOW']) {
      for (const regulation of ['PAUSED', 'STOPPED', 'HORS_GEL', 'WAITING_TEMP']) {
        for (const enabled of [true, false]) {
          context.render({ state, regulation, temperature: 19.5, targetTemperature: 21,
            power: 1, fanSpeed: 3, pelletsConsumed: 2.5, pelletsAlarm: enabled,
            autoMode: enabled, ignitionAllowed: enabled, externalTemperature: enabled });
          assert.ok(root.innerHTML.includes(language === 'fr' ? '19,5' : '19.5'));
          assert.ok(root.innerHTML.includes(locales[language].widget.power));
        }
      }
    }
    homey.getSettings = () => ({ stove: { id: 'device' } });
    homey.api = () => Promise.reject(new Error('Technical detail'));
    context.onHomeyReady(homey);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(root.textContent, locales[language].widget.loadError);
  });

  test(`validation and automatic-mode errors are translated in ${language}`, () => {
    const homey = { __: lookup(language) };
    assert.equal(localizedError(homey, 'AUTO_MODE_ENABLED').message, locales[language].errors.autoEnabled);
    assert.equal(localizedError(homey, 'Invalid fan speed').message,
      locales[language].errors.invalidValue.replace('__name__', locales[language].parameters.fan_speed));
  });
}
