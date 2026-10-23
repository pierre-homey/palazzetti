'use strict';
const { localizedError } = require('./lib/i18n');
const Homey = require('homey');
class PalazzettiApp extends Homey.App {
  onInit() {
    const widget = this.homey.dashboards.getWidget('stove-dashboard');
    widget.registerSettingAutocompleteListener('stove', async query => {
      const search = query.toLocaleLowerCase();
      return this.homey.drivers.getDriver('cbox').getDevices()
        .map(device => ({ id: device.getData().id, name: device.getName() }))
        .filter(device => device.name.toLocaleLowerCase().includes(search));
    });
    this.log('PalazzettiApp has been initialized');
    return Promise.resolve();
  }

  async getStoveDashboardData(deviceId) {
    if (typeof deviceId !== 'string' || !deviceId) {
      throw localizedError(this.homey, 'Identifiant du poêle manquant dans la requête du widget');
    }
    const driver = this.homey.drivers.getDriver('cbox');
    const device = driver.getDevices().find(candidate => candidate.getData().id === deviceId);
    if (!device) throw localizedError(this.homey, 'Selected Palazzetti device was not found');
    const settings = device.getSettings?.() || {};
    const pelletsConsumed = device.getCapabilityValue('pellets_burned_since_load');

    const dashboardData = {
      deviceId,
      sourceId: device.getData().id,
      name: device.getName(),
      targetTemperature: device.getCapabilityValue('target_temperature'),
      temperature: device.getCapabilityValue('measure_temperature'),
      power: device.getCapabilityValue('target_power'),
      fanSpeed: device.getCapabilityValue('target_fan_speed'),
      state: device.getCapabilityValue('stove_state'),
      regulation: device.getCapabilityValue('stove_regulation'),
      pelletsAlarm: device.getCapabilityValue('alarm_pellets'),
      pelletsConsumed,
      pelletsLow: Boolean(settings.withPreAlarm
        && Number.isFinite(Number(pelletsConsumed))
        && Number(pelletsConsumed) >= Number(settings.deltaPelletsBurned)),
      autoMode: device.getCapabilityValue('auto_mode'),
      ignitionAllowed: device.getCapabilityValue('stove_ignation'),
      externalTemperature: Boolean(settings.externalTerm),
      temperatureStale: Boolean(settings.externalTerm
        && Date.now() - device.lastExternalTemperatureUpdate
          >= Number(settings.externalTempTimeout ?? 30) * 60000),
    };
    return dashboardData;
  }
}
module.exports = PalazzettiApp;
