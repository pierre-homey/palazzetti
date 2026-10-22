'use strict';

module.exports = {
  async getStoveDashboardData({ homey, params }) {
    try {
      return await homey.app.getStoveDashboardData(params.deviceId);
    } catch (error) {
      homey.app.error('Stove dashboard request failed', { deviceId: params.deviceId }, error);
      throw error;
    }
  },
};
