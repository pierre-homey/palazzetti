'use strict';
const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
class PalazzettiApp extends Homey.App {
  onInit() {
    this.log('PalazzettiApp has been initialized');
    return Promise.resolve();
  }

  async getDashboardApi() {
    if (!this.dashboardApiPromise) {
      this.dashboardApiPromise = HomeyAPI.createAppAPI({ homey: this.homey }).catch(error => {
        this.dashboardApiPromise = null;
        throw error;
      });
    }
    return this.dashboardApiPromise;
  }

  async getStoveDashboardData(deviceId) {
    if (typeof deviceId !== 'string' || !deviceId) {
      throw new Error('Identifiant du poêle manquant dans la requête du widget');
    }
    let homeyDevice;
    try {
      const api = await this.getDashboardApi();
      homeyDevice = await api.devices.getDevice({ id: deviceId });
    } catch (error) {
      throw new Error(`Lecture de l’appareil Homey impossible : ${error.message || error}`);
    }
    if (!homeyDevice || typeof homeyDevice.data?.id !== 'string') {
      throw new Error('Selected Homey device was not found');
    }

    const driver = this.homey.drivers.getDriver('cbox');
    const device = driver.getDevices().find(candidate => candidate.getData().id === homeyDevice.data.id);
    if (!device) throw new Error('Selected Palazzetti device was not found');
    const settings = device.getSettings?.() || {};
    const pelletsConsumed = device.getCapabilityValue('pellets_burned_since_load');

    const dashboardData = {
      deviceId,
      sourceId: homeyDevice.data.id,
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
