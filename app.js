'use strict';

const Homey = require('homey');

class PalazzettiApp extends Homey.App {
  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('PalazzettiApp has been initialized');
  }
}

module.exports = PalazzettiApp;