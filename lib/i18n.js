'use strict';
const en = require('../locales/en.json');
const messages = {
  "CBox device stopped": "deviceStopped",
  "Temp. N1 < Temp. N2 <= Temp. Silence required": "temperatureOrder",
  "Invalid frost protection temperatures": "frostTemperatures",
  "External temperature timeout must be between 1 and 1440 minutes": "externalTimeout",
  "Invalid ambient temperature limits": "temperatureLimits",
  "Invalid CBox state": "invalidState",
  "Pellet counter unavailable": "pelletCounter",
  "Invalid ignition permission": "invalidIgnition",
  "Invalid automatic mode": "invalidAuto",
  "AUTO_MODE_ENABLED": "autoEnabled",
  "Invalid on/off value": "invalidOnOff",
  "Ignition is disabled": "ignitionDisabled",
  "ERROR_NO_IP": "missingAddress",
  "Invalid CBox address": "invalidAddress",
  "Stove is not stopped": "notStopped",
  "Identifiant du poêle manquant dans la requête du widget": "missingDevice",
  "Selected Homey device was not found": "deviceNotFound",
  "Selected Palazzetti device was not found": "stoveNotFound",
  "CBox request cancelled": "requestCancelled",
  "CBox response too large": "responseTooLarge",
  "CBox response aborted": "responseAborted",
  "CBox command failed": "commandFailed",
  "CBox request timed out": "requestTimeout"
};
function translate(homey, key, parameters = {}) {
  const translated = homey.__(key, parameters);
  const fallback = key.split('.').reduce((value, part) => value?.[part], en) || key;
  return Object.entries(parameters).reduce((value, [name, replacement]) =>
    value.replaceAll(`__${name}__`, replacement), translated === key ? fallback : translated);
}
function localizedError(homey, message) {
  const key = messages[message];
  return new Error(translate(homey, `errors.${key || 'invalidValue'}`,
    key ? {} : { name: translate(homey, `parameters.${message.replace(/^Invalid /, '').replaceAll(' ', '_')}`) }));
}
module.exports = { translate, localizedError, isKnownError: message => Boolean(messages[message]) };
