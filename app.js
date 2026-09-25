'use strict';
const Homey = require('homey');
class PalazzettiApp extends Homey.App {
  onInit() {
    this.log('PalazzettiApp has been initialized');
    return Promise.resolve();
  }
}
module.exports = PalazzettiApp;
