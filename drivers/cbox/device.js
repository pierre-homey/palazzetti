'use strict';
const Homey = require('homey');
const http = require('http');

const withLog = false;


const REGULATION_ENUM = {
	WAITING_TEMP: "WAITING_TEMP",
	BURNING: "BURNING",
	STOPPED: "STOPPED",
	PAUSED: "PAUSED",
	SILENTLY: "SILENTLY",
	HG: "HORS_GEL"
}

const STOVE_STATE = {
	UNKNOW: 'UNKNOW',
	STOPPED:'STOPPED',
	STARTING:'STARTING',
	STARTED:'STARTED',
	STOPPING:'STOPPING',
	FAULTED:'FAULTED'
}

class CBoxDevice extends Homey.Device {
	smartStartEnbale = false;
	smartPauseEnable = false;
	tempSmartPause = 45;
	timeoutSmartPause = null;
	useExtCaptor = false;
	stoveIp = null;
	timeoutId;
	stoveState = STOVE_STATE.UNKNOW;
	regulationMode = REGULATION_ENUM.STOPPED;

	async onInit(){
		if( withLog) this.log('CBox Récupération des parametres...');

		const settings = this.getSettings();
		this.smartStartEnbale = settings.smartStart;
		this.smartPauseEnable = settings.smartPause;
		this.tempSmartPause = settings.pauseTemp;
		this.useExtCaptor = settings.externalTerm;
		this.stoveIp = settings.ip;
		this.isAutoModeActive = false;

		this.deltaN1 = settings['deltaN1'];
		this.deltaN2 = settings['deltaN2'];
		this.deltaSilence = settings['deltaSilence'];
		this.deltaSilenceEnabled = settings['deltaSilenceEnable'];


		this.log('CBox Initialisation...');
		this.letUpdateTime = Date.now();
		this.regulationMode = await this.getCapabilityValue( 'stove_regulation' );
		//this.stoveStatus = null;
		this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));
		this.registerCapabilityListener('target_power', this.onCapabilityTargetPower.bind(this));
		this.registerCapabilityListener('target_fan_speed', this.onCapabilityTargetFanSpeed.bind(this));
		this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
		this.registerCapabilityListener('stove_regulation', this.onCapabilityRegulationMode.bind(this));

		//Mise a jour au besoin
		if( !this.hasCapability('pellets_burned') ){
			this.addCapability('pellets_burned');
			await this.setCapabilityValue('pellets_burned', 0);
			await this.setStoreValue('prePelletsAttentionSended', true);
			await this.setStoreValue('reloadDoneIndex', 0);
		}

		if( !this.hasCapability('pellets_burned_since_load') ){
			await this.addCapability('pellets_burned_since_load');
			this.setCapabilityValue('pellets_burned_since_load', 25);
		}

		if( !this.hasCapability('stove_connection') )
			this.addCapability('stove_connection');

		if( !this.hasCapability('stove_ignation') )
			this.addCapability('stove_ignation');
		if( null == await this.getCapabilityValue('stove_ignation')){
			await this.setCapabilityValue('stove_ignation', true);
		}
		this.registerCapabilityListener('stove_ignation', this.onCapabilityLocked.bind(this));

		if( !this.hasCapability('auto_mode') )
			this.addCapability('auto_mode');
		if( null == await this.getCapabilityValue('auto_mode')){
			await this.setCapabilityValue('auto_mode', true);
		}
		this.registerCapabilityListener('auto_mode', this.onCapabilityAuto.bind(this));
		this.isAutoModeActive = this.isAutoModeEnable();

		if( this.hasCapability('locked') )
			this.removeCapability('locked');
		
		if( !this.hasCapability('measure_power') )
			this.addCapability('measure_power');
		if( !this.hasCapability('meter_power') )
			this.addCapability('meter_power');



		this.setCapabilityValue('stove_connection', null)
		//await this.setCapabilityValue('stove_state', this.stoveState);

		//Declenchement de l'alarme en cas de manque de pellet
		this.alarmePelletsChange = this.homey.flow.getDeviceTriggerCard('pellets_attention');
		//Arret de l'alarme en cas de plus de manque de pellet
		this.alarmePelletsChangeOff = this.homey.flow.getDeviceTriggerCard('pellets_attention_off');
		// Declenchement pre alarme
		this. preAlarmePelets = this.homey.flow.getDeviceTriggerCard('pre_pellets_attention');
		//Delenchement changement état
		//this.onChangeState = this.homey.flow.getDeviceTriggerCard('on_state_change');

		if( typeof this.stoveIp === 'undefined') return null;
		else if( this.timeoutId != null ){
			if( withLog) this.log('Suppression d une ancienne tache de maj');
			this.homey.clearInterval(this.timeoutId)
		}
		try{
			if( withLog) this.log('Test de la communication...');
			await this.checkComm();
			this.setCapabilityValue('stove_connection', !true);
			this.setAvailable();
			if( withLog) this.log('Connexion OK')
		}catch(error){
			this.setCapabilityValue('stove_connection', !false);
			this.setUnavailable();
			let notificationErrorCom = this.homey.notifications.createNotification({excerpt:"Communication impossible avec le CBOX"});
			return null;
		}
		try{
			await this.onTimeOut();
		}catch(error){
			let notificationErrorCom = this.homey.notifications.createNotification({excerpt:"Mise a jour impossible des états du poele"});
			return null;
		}
		this.timeoutId  = await this.registerIntervalRequest();
		this.homey.on('unload', () => clearInterval(this.timeoutId));
		if( withLog) this.log('Initialisation finalisée');

		//let notification = this.homey.notifications.createNotification({excerpt:"L'Application a bien démarrée"});

	}


	async registerIntervalRequest(){
		if( withLog) this.log('Enregistrement de la mise a jour réguliere');
		return this.homey.setInterval(async() => {
			try{
				await this.onTimeOut();
			}catch(err){
				if (err.message.startsWith("Not Found")) {
      				console.error("Device introuvable :", err.message);
				}else{
					console.error("Erreur inconnue :", err);
				}
			}
		}, 60000);
	}


	async onSettings(settings){
		this.smartStartEnbale = settings.newSettings.smartStart;
		this.smartPauseEnable = settings.newSettings.smartPause;
		this.tempSmartPause = settings.newSettings.pauseTemp;
		this.useExtCaptor = settings.newSettings.externalTerm;
		
		if( settings.newSettings.deltaN2 <= settings.newSettings.deltaN1)
			throw new Error('Temp. N1 must be lower than Temp. N2');
		
		if( settings.newSettings.deltaN2 > settings.newSettings.deltaSilence)
			throw new Error('Temp. N2 must be lower or equal than Temp. Silence');

		if( settings.newSettings.deltaSilence < settings.newSettings.deltaN2)
			throw new Error('Temp. Silence must be greater or equal than Temp. N2');

		if( settings.oldSettings.ip != settings.newSettings.ip ){
			this.stoveIp = settings.newSettings.ip;
			try{
				await this.checkComm();
				this.setCapabilityValue('stove_connection', !true);
				this.setAvailable();
			}catch(error){
				this.setCapabilityValue('stove_connection', !false);
				this.setUnavailable();
				throw new Error("ERROR_COMM_ERROR");
			}
			this.clearInterval(this.timeoutId);
			this.timeoutId = this.registerIntervalRequest();
		}
		
		if( this.useExtCaptor != settings.oldSettings.externalTerm){
			if( this.useExtCaptor){
				await this.setCapabilityValue('measure_temperature', await this.getCapabilityValue('external_temperature') );
			}else{
				await this.setCapabilityValue('measure_temperature', await this.getCapabilityValue('internal_temperature') );
			}
		}

		this.deltaN1 = settings.newSettings.deltaN1;
		this.deltaN2 = settings.newSettings.deltaN2;
		this.deltaSilence = settings.newSettings.deltaSilence;
		this.deltaSilenceEnabled = settings.newSettings.deltaSilenceEnable;

		await this.onTempChange();
	}
	
	async checkComm(){
		let url = this.getcallCboxURL("LABL", false, null);
		await this.sendHTTPRequest(url);
	}
	
	async onTimeOut(){

		try{
			if( withLog) this.log("Mise a jour des états de la CBox");
			if( withLog) this.log("onTimeOut: regulationMode="+this.regulationMode);
			let url = this.getcallCboxURL("ALLS", false, null);
			let data = await this.sendHTTPRequest(url);
			let resultStoveSate = await this.updateStates(data.STATUS);
			if(withLog) this.log("onTimeOut: resultStoveSate="+ resultStoveSate);
			this.stoveState = resultStoveSate;
			await this.updateAllStates(data);
			await this.updateEnergyPowerConso();
			//this.checkStateAndRegulationMode();
			if( withLog) this.log("MAJ Terminée\n\n\n");
			if( await this.getCapabilityValue('stove_connection') == !false){
				this.setCapabilityValue('stove_connection', !true);
				this.setAvailable();
			}
		}catch(error){
			if( withLog) this.log('Erreur de communication avec la CBox: ', error);
			if( await this.getCapabilityValue('stove_connection') == !true){
				this.setCapabilityValue('stove_connection', !false);
				try{
					this.setUnavailable();
				}catch(error){
					console.log(error);
				}
			}
		}
	}
	
	async updateAllStates(data){
		await Promise.all([
			this.setStateOnOff(),
			this.setTargetTemperature(data.SETP),
			this.setPower(data.PWR),
			this.setFanSpeed(data.F2L),
			this.setInternalTemp(data.T1),
			this.setBurnedPellets(data.PQT)
		]);
		return true;
	}

	async updateEnergyPowerConso(){
		let lastPower = await this.getCapabilityValue('measure_power');
		let newPower = 0;
		if( this.stoveState == STOVE_STATE.STARTING ){
			newPower = 345;
		}
		else if( this.stoveState == STOVE_STATE.STARTED ){
			let state = await this.getCapabilityValue('target_fan_speed');
			//Speed AUTO 7
			let powerBySpeed = 33
			//MAX
			if( state == "6" )
				powerBySpeed = 49;
			else if( state == "5" || state == "4" )
				powerBySpeed = 47.5;
			else if( state == "3" || state == "2" )
				powerBySpeed = 35;
			else if (state == "1")
				powerBySpeed = 22;
			else if (state == "0")
				powerBySpeed = 10;

			newPower = powerBySpeed;
		}
		else if( this.stoveState == STOVE_STATE.STOPPING )
			newPower = 33;
		else if( this.stoveState == STOVE_STATE.STOPPED || finalState == STOVE_STATE.FAULTED )
			newPower = 1.3;
		
		await this.setCapabilityValue('measure_power', newPower);
		let newUpdateTime = Date.now();

		let energie = (lastPower/1000) * ((0.001*(newUpdateTime - this.letUpdateTime))/3600);
		if( withLog) this.log("kWh="+energie);
		let oldEnergie = await this.getCapabilityValue('meter_power');
		this.setCapabilityValue('meter_power', oldEnergie + energie);
		this.letUpdateTime = newUpdateTime

		return true;
	}
	
	/*------ MAJ CAPABILITIES -------------*/
	async updateStates(state ){
		let oldStoveState = await this.getCapabilityValue('stove_state');
		if( withLog ){
			this.log('Befor updateStates:\n'+
				"oldStoveState="+oldStoveState
			);
		}
		let finalState = STOVE_STATE.UNKNOW;
		if( state == 0 )
			finalState = STOVE_STATE.STOPPED;
		else if( state == 3)
			finalState = STOVE_STATE.STARTING;
		else if( state == 6)
			finalState = STOVE_STATE.STARTED;
		else if( state == 10)
			finalState = STOVE_STATE.STOPPING;
		else if( state >= 241 && state <= 253)
			finalState = STOVE_STATE.FAULTED;
		else
			return oldStoveState;

		var promises = new Array();
		if( oldStoveState != finalState ){

			if( withLog ){
				this.log('Final stoveState:\n'+
					"stove_state="+finalState
				);
			}
			promises.push(
  				this.setCapabilityValue('stove_state', finalState)
    				.then(() => this.driver.triggerFlowOnStateChange(this, finalState))
   					.catch(err => this.error('Erreur setCapabilityValue ou triggerFlowOnStateChange', err))
			);
			let isBurning = (finalState == STOVE_STATE.STARTING) || (finalState == STOVE_STATE.STARTED);
			//this.setInsightBurning(isBurning);
			if( this.withLog )this.log('IsBurning='+isBurning);
			if( this.withLog )this.log('regulationMode='+this.regulationMode);

			let isOn = await this.getCapabilityValue( 'onoff' );
			if( this.regulationMode == REGULATION_ENUM.HG ){
				if( !isOn ){
					this.regulationMode = REGULATION_ENUM.STOPPED;
					if( this.withLog )this.log('1 - new regulationMode='+this.regulationMode);
					this.setCapabilityValue('stove_regulation', REGULATION_ENUM.STOPPED);
				} 
			}else if( isBurning && this.regulationMode != REGULATION_ENUM.BURNING && this.regulationMode != REGULATION_ENUM.SILENTLY ){
				this.regulationMode = REGULATION_ENUM.BURNING;
				if( this.withLog )this.log('2 - new regulationMode='+this.regulationMode);
				this.setCapabilityValue('stove_regulation', this.regulationMode);
				if( !isOn ) this.setCapabilityValue('onoff', true);
			}else if( !isBurning && this.regulationMode != REGULATION_ENUM.STOPPED && this.regulationMode != REGULATION_ENUM.PAUSED && this.regulationMode != REGULATION_ENUM.WAITING_TEMP ){
				this.regulationMode = REGULATION_ENUM.STOPPED;
				if( this.withLog )this.log('3 - new regulationMode='+this.regulationMode);
				this.setCapabilityValue('stove_regulation', this.regulationMode);
				if( isOn ) this.setCapabilityValue('onoff', false);
			}
		}
		
		let declenchementAlarmePellets = false;
		let oldStatePelletsAlarme = await this.getCapabilityValue('alarm_pellets');
		if( oldStatePelletsAlarme == null && state == 253 ){
			promises.push( this.setCapabilityValue('alarm_pellets', true) );
			declenchementAlarmePellets = true;
		}else if( oldStatePelletsAlarme == false && state == 253 ){
			promises.push( this.setCapabilityValue('alarm_pellets', true) );
			declenchementAlarmePellets = true;
		}else if( oldStatePelletsAlarme == true && state != 253 ){
			promises.push( this.setCapabilityValue('alarm_pellets', false) );
			promises.push( this.setPelletsReloadDone() );
		}
		
		if( declenchementAlarmePellets ){
			if( withLog) this.log("NO_MORE_PELLETS")
			this.alarmePelletsChange.trigger(this, {}, {})
      			//.then(/*this.log("NO_MORE_PELLETS")*/)
      			.catch(this.error);
		}
		
		
		await Promise.all(promises);
		return finalState;
	}

	async setStateOnOff(){
		let isOn = await this.getCapabilityValue( 'onoff' );
		let isOff = !isOn;
		let regulationMode = this.regulationMode;
		/* on ne change pas si les états connus sont cohérents*/
		if( isOff && STOVE_STATE.STOPPED == this.stoveState  && REGULATION_ENUM.STOPPED == regulationMode ){
			return true;
		}
		if( isOn && STOVE_STATE.STARTED == this.stoveState && REGULATION_ENUM.STOPPED != regulationMode ){
			return true;
		}
		/* On calcul les autres états*/
		/* seul cas a off si l'état est STOPPED et la regulation est STOPPED */
		if( STOVE_STATE.STOPPED == this.stoveState && REGULATION_ENUM.STOPPED == regulationMode){
			this.setCapabilityValue('onoff', false);
			return true;
		}else {
			this.setCapabilityValue('onoff', true);
		}
		return true;
	}
	async setCurrentTemp(temp){
		let oldTemp = await this.getCapabilityValue('measure_temperature');
		if( oldTemp == temp ) return true;
		
		if( withLog) this.log('Mise a jour de la temperature mesurée a '+ temp);
		await this.setCapabilityValue('measure_temperature', temp);
		await this.onTempChange();
		return true;
	}
	async setFanSpeed(fanSpeed){
		let state = await this.getCapabilityValue('target_fan_speed');
		let newSpeed = ""+fanSpeed;
		if( state != newSpeed ){
			if( withLog) this.log('Mise a jour de la ventilation a '+ fanSpeed);
			return await this.setCapabilityValue('target_fan_speed', newSpeed);
		}
		return true;
	}
	async setPower(power){
		let state = await this.getCapabilityValue('target_power');
		let newValue = ""+power;
		if( state != newValue ){
			if( withLog) this.log('Mise a jour de la puissance a '+ newValue);
			return await this.setCapabilityValue('target_power', newValue);
		}
		return true;	
	}
	async setTargetTemperature(targetTemperature){
		//on rearondi par le poele ne gere pas les 0.5
		let knownTemp = Math.round(await this.getCapabilityValue('target_temperature'));
		if( targetTemperature != knownTemp ){
			if( withLog) this.log('Mise a jour de la température de consigne a '+ targetTemperature);
		 	await this.setCapabilityValue('target_temperature', targetTemperature);
			await this.onTempChange();
			return true;
		}
		return true;
	}

	async setPreset(preset){
		let targetPreset = preset;
		if( withLog) this.log('Application du preset numero '+preset);
		const settings = this.getSettings();

		let targetPresetPower = preset;
		let targetPresetFanSpeed = preset;

		let targetPower = 1;
		let targetFanSpeed = 0;

		if( preset < 3 ){
			targetPower = settings['preset'+targetPresetPower+'BurningPower'];
			targetFanSpeed = settings['preset'+targetPresetFanSpeed+'FanSpeed'];
		}else{
			targetPower = settings['presetSilenceBurningPower'];
		}
		if( this.regulationMode == REGULATION_ENUM.SILENTLY){
			targetFanSpeed = 0;
			if( withLog) this.log("Preset Silence Puissance: "+targetPower);

		}else{
			if( withLog) this.log('Preset '+targetPreset + " Puissance: "+targetPower + " Fan: "+targetFanSpeed);
		}

		try{
			await this.applyPreset(targetPower,targetFanSpeed);
		}catch( error ){
			throw new Error("ERROR_COMM_ERROR");
		}
	}

	async setHGPreset(){
		if( withLog) this.log('Application du preset pour le mode HG');
		const settings = this.getSettings();
		let targetPower = settings['presetHGBurningPower'];
		let targetFanSpeed = settings['presetHGFanSpeed'];

		if( withLog) this.log("Preset Hors GEL Puissance: "+targetPower + " Fan: "+targetFanSpeed);
		try{
			await this.applyPreset(targetPower,targetFanSpeed);
		}catch( error ){
			throw new Error("ERROR_COMM_ERROR");
		}
	}
	async setBurnedPellets(kilos){
		let oldValue = await this.getCapabilityValue('pellets_burned');
		let indexRecharge = await this.getStoreValue('reloadDoneIndex');
		if( kilos != oldValue ){
			await this.setCapabilityValue('pellets_burned', kilos);
			await this.setCapabilityValue('pellets_burned_since_load', kilos - indexRecharge)
			let delta = await this.getSetting('deltaPelletsBurned');
			
			if( (kilos - this.getStoreValue('reloadDoneIndex')) >= delta ){
				if ( !this.getStoreValue('prePelletsAttentionSended') ){
					if( await this.getSetting('withPreAlarm') ){
						this.setStoreValue('prePelletsAttentionSended', true);
						this.preAlarmePelets.trigger(this, {}, {})
      						.then(/*this.log("PRE_NO_MORE_PELLETS")*/)
      						.catch(this.error);
					}
				}
			}
		}
		return true;
	}

	async setPelletsReloadDone(){
		if( withLog) this.log("Recharge en pellets faite");
		await this.setCapabilityValue('pellets_burned_since_load', 0);
		await this.setStoreValue('reloadDoneIndex', await this.getCapabilityValue('pellets_burned') );
		this.setStoreValue('prePelletsAttentionSended', false);
		this.alarmePelletsChangeOff.trigger(this, {}, {})
      			.then(/*this.log("PELLETS_OK")*/)
      			.catch(this.error);
		return true;
	}

	async  applyTargetPresetForHG(){
		if( withLog) this.log('Selection du preset');
		const settings = this.getSettings();
		var targetPower = settings['presetHGBurningPower'];
		var targetFanSpeed = settings['presetHGFanSpeed'];
		if( withLog) this.log('Preset HG '+targetPreset + " Puissance: "+targetPower + " Fan: "+targetFanSpeed);
		try{
			await this.applyPreset(targetPower,targetFanSpeed);
		}catch( error ){
			throw new Error("ERROR_COMM_ERROR");
		}
	}


	async applyTargetPresetForCurrentTemp(){
		if( withLog) this.log('Selection du preset');
		let temp = await this.getCapabilityValue('measure_temperature');
		let targetTemp = await this.getCapabilityValue('target_temperature');
		let currentDelta = temp - targetTemp;

		let targetPreset = 0;

		if(temp < targetTemp+this.deltaN1 ){
			targetPreset = 0;//after that currentDelta is >= 0
		}else if(currentDelta >= this.deltaN1 && currentDelta < this.deltaN2 ){
			targetPreset = 1;
		}else if(currentDelta >= this.deltaN2 && currentDelta < this.deltaSilence ){
			targetPreset = 2;
		}else if(currentDelta >= this.deltaN2 && !this.deltaSilenceEnabled ){
			targetPreset = 2
		}else if(currentDelta >= this.deltaSilence && this.deltaSilenceEnabled ){
			targetPreset = 3;
		}else{
			targetPreset = 0;
		}
		if( withLog) this.log('Application du preset='+targetPreset);
		this.setPreset(targetPreset);


	}

	async isRegulationMode(mode){
		return await this.getCapabilityValue('stove_regulation') == mode;
	}

	async setExternalTemp(temp){
		let oldTemp = await this.getCapabilityValue('external_temperature');
		if( oldTemp == temp ) return true;
		if( withLog) this.log('TEMPERATURE EXTERNE'+temp);
		await this.setCapabilityValue('external_temperature', temp);

		if( this.useExtCaptor ){

			await this.setCurrentTemp(temp);
		}
	}

	async setInternalTemp(temp){
		let oldTemp = await this.getCapabilityValue('internal_temperature');
		if( oldTemp == temp ) return true;
		await this.setCapabilityValue('internal_temperature', temp);
		if( !this.useExtCaptor ){
			await this.setCurrentTemp(temp);
		}
	}

	async setIgnationAllowed(canStart){
		await this.setCapabilityValue('stove_ignation',canStart);
		if( true == canStart ){
			this.onTempChange();
		}
	}
	async enableAutoMode(autoMode){
		await this.setCapabilityValue('auto_mode',autoMode);
		if( true == autoMode ){
			this.onTempChange();
		}
	}

	async onTempChange(){
		if( ! await this.getCapabilityValue('auto_mode') ) return;
		if( withLog) this.log('Sur Changement de température');
		let regulationMode = this.regulationMode;
		if( withLog) this.log("Mode de regulation actuel="+regulationMode);
		if( REGULATION_ENUM.WAITING_TEMP == regulationMode || REGULATION_ENUM.PAUSED == regulationMode ){
			let canStartWithSSsettings = await this.isCanStartWSStartKnonwTemp();
			if( canStartWithSSsettings ){
				await this.applyTargetPresetForCurrentTemp();
				await this.setOnOffPoele(true);
				this.regulationMode = REGULATION_ENUM.BURNING;
				this.setCapabilityValue('stove_regulation', this.regulationMode);
			}
			if( withLog) this.log('Peut redémarrer='+canStartWithSSsettings);
		}else if(REGULATION_ENUM.BURNING == regulationMode || REGULATION_ENUM.SILENTLY == regulationMode ){
			let canPaused = await this.isCanPauseWKnonwTemp();
			if( canPaused ){
				await this.setOnOffPoele(false);
				this.regulationMode = REGULATION_ENUM.PAUSED;
				this.setCapabilityValue('stove_regulation', this.regulationMode);
			}else if( REGULATION_ENUM.BURNING == regulationMode ){
				this.applyTargetPresetForCurrentTemp();
			}
		}else if( REGULATION_ENUM.HG == regulationMode ){
			if( await this.isCanPauseForHG() ){
				await this.setOnOffPoele(false);
			}else if( await this.isCanStartForHG () ){
				await this.setOnOffPoele(true);
			}
		}
	}

	async setSilenceMode(isActive){
		if( withLog) this.log('Gestion du mode silene a '+isActive);
		await this.setSettings({
			deltaSilenceEnable: isActive,
		});
		this.deltaSilenceEnabled = isActive;
		return true;
	}

	async setSmartPause(isActive){
		await this.setSettings({
			smartPause: isActive,
		});
		this.smartPauseEnable = isActive;
		return true;
	}

	async isCanStartWSStartKnonwTemp(){
		let startLocked = !await this.getCapabilityValue('stove_ignation');
		if( true == startLocked ){
			if( withLog) this.log('Demarrage bloqué');	
			return false;
		}
		let stoveState = await this.getCapabilityValue('stove_state');
		if( withLog) this.log("isCanStartWSStartKnonwTemp: stoveState="+stoveState);
		
		if( stoveState != STOVE_STATE.STOPPED )
			return false;
		
		let regulationMode = this.regulationMode;
		if( withLog) this.log("isCanStartWSStartKnonwTemp: regulationMode="+regulationMode);

		if( !this.smartStartEnbale &&
				regulationMode != REGULATION_ENUM.PAUSED ){
			if( withLog) this.log("isCanStartWSStartKnonwTemp: State 1");
			return true;
		}

		let mesuredTemp = await this.getCapabilityValue('measure_temperature');
		let targetTemp = await this.getCapabilityValue('target_temperature');
		if( null == mesuredTemp ) return false;

		if( withLog) this.log('deltaReprisePause: regulationMode='+regulationMode);
		if( withLog) this.log("isCanStartWSStartKnonwTemp: mesuredTemp="+mesuredTemp);
		if( withLog) this.log("isCanStartWSStartKnonwTemp: targetTemp="+targetTemp);
		
		const settings = this.getSettings();
		let deltaReprisePause = settings.restartPauseTemp;
		
		if( withLog) this.log("deltaReprisePause: deltaReprisePause="+deltaReprisePause);
		if( withLog) this.log('deltaReprisePause: On verifie si le redemarrage est possible');


		if( regulationMode == REGULATION_ENUM.WAITING_TEMP && mesuredTemp <= targetTemp ){
			if( withLog) this.log("Je suis en WT et mesuredTemp <= targetTemp");
			return true;
		}
		if( regulationMode == REGULATION_ENUM.PAUSED && mesuredTemp <= (targetTemp+deltaReprisePause) ){
			if( withLog) this.log("Je suis en PAUSED et mesuredTemp <= (targetTemp+deltaReprisePause)");
			return true;
		}

		return false;
	}

	async isCanPauseWKnonwTemp(){
		if( withLog) this.log('Etat du smat Pause = '+this.smartPauseEnable);
		if( !this.smartPauseEnable ) return false;
		let stoveState = await this.getCapabilityValue('stove_state');
		if( stoveState != STOVE_STATE.STARTED ) return false;

		let mesured = await this.getCapabilityValue('measure_temperature');
		if( null == mesured ) return false;
		let targetTemp = await this.getCapabilityValue('target_temperature');
		if( mesured >= (this.tempSmartPause+targetTemp) ) return true;

		return false;
	}

	async isCanPauseForHG(){
		if( withLog) this.log('Calcul de la mise en Pause pour le mode HG');
		let stoveState = await this.getCapabilityValue('stove_state');
		if( withLog) this.log('Stove state= '+ stoveState);
		if( stoveState != STOVE_STATE.STARTED ) return false;

		let mesured = await this.getCapabilityValue('measure_temperature');
		
		if( null == mesured ) return true;
		let targetTemp = await this.getSetting('hgMaxTemp');
		if( withLog) this.log('Temp mesuree='+mesured+" Demarrage="+targetTemp);
		if( mesured > targetTemp ) return true;

		return false;
	}

	async isCanStartForHG(){
		if( withLog) this.log('Calcul de la mise en marche pour le mode HG');
		let startLocked = !await this.getCapabilityValue('stove_ignation');
		if( true == startLocked ){
			if( withLog) this.log('Demarrage bloqué');	
			return false;
		}

		let stoveState = await this.getCapabilityValue('stove_state');
		if( stoveState != STOVE_STATE.STOPPED ) return false;

		let mesured = await this.getCapabilityValue('measure_temperature');
		if( null == mesured ) return false;

		let targetTemp = await this.getSetting('hgMinTemp');
		if( withLog) this.log('Temp mesuree='+mesured+" Demarrage="+targetTemp);
		if( mesured <= targetTemp ) return true;

		return false;
	}

	async isSmartStartEnabled(){
		return this.smartStartEnbale;
	}
	
	async isSmartPauseEnabled(){
		return this.smartPauseEnable;
	}

	async isIgnationAllowed(){
		return await this.getCapabilityValue('stove_ignation');
	}
	async isAutoModeEnable(){
		return await this.getCapabilityValue('auto_mode');
	}

	/*------ CAPABILITIES LISTENER ----------*/

	async onCapabilityOnOff(value, opts){
		let url = null;
		let currentStoveState = await this.getCapabilityValue('stove_state');
		if( withLog) this.log("onCapabilityOnOff: currentStoveSate="+currentStoveState);
		if( withLog) this.log("onCapabilityOnOff: value="+value);

		if( this.stoveState == STOVE_STATE.STOPPED && value == true ){
			this.regulationMode = REGULATION_ENUM.WAITING_TEMP;
			await this.setCapabilityValue('stove_regulation', this.regulationMode);
		}else if( this.stoveState == STOVE_STATE.STARTED && value == false ){
			/* NOTHING */
		}else if( this.stoveState == STOVE_STATE.STOPPED && value == false ){
			this.regulationMode = REGULATION_ENUM.STOPPED;
			if( this.withLog )this.log('1 - onCapabilityOnOff regulationMode='+this.regulationMode);
			await this.setCapabilityValue('stove_regulation', this.regulationMode);
			return true;
		}else if( this.stoveState == STOVE_STATE.STOPPING && value == false ){
			this.regulationMode = REGULATION_ENUM.STOPPED;
			if( this.withLog )this.log('2 - onCapabilityOnOff regulationMode='+this.regulationMode);
			await this.setCapabilityValue('stove_regulation', this.regulationMode);
			return true;
		}else{
			throw new Error(this.homey.__('illegalStateOnOff'));
		}
		try{
			if( value ){
				let canStartWKTemp = await this.isCanStartWSStartKnonwTemp();
				if( withLog) this.log("onCapabilityOnOff: canStartWKTemp="+canStartWKTemp);
				if( canStartWKTemp ){/* demande de demarrage*/
					await this.setOnOffPoele(true);
					this.regulationMode = REGULATION_ENUM.BURNING;
					await this.setCapabilityValue('stove_regulation', this.regulationMode);
				}
			}else {
				await this.setOnOffPoele(false);
				this.regulationMode = REGULATION_ENUM.STOPPED;
				if( this.withLog )this.log('3 - onCapabilityOnOff regulationMode='+this.regulationMode);
				await this.setCapabilityValue('stove_regulation', this.regulationMode);
			}
		}catch( error ){
			throw new Error("ERROR_COMM_ERROR");
		}
	}

	async onCapabilityTargetTemperature(value, opts){
		let url = this.getcallCboxURL("SETP", true, Math.round(value));
		try{
			await this.sendHTTPRequest(url);
			await this.setCapabilityValue('target_temperature', value);
			await this.onTempChange();
		}catch( error ){
			throw new Error("ERROR_COMM_ERROR");
		}
	}
	
	async onCapabilityTargetPower(value, opts){
		if( await this.getCapabilityValue('auto_mode'))
			throw new Error("AUTO_MODE_ENABLED");
		let url = this.getcallCboxURL("POWR", true, value);
		try{
			await this.sendHTTPRequest(url);
			this.setCapabilityValue('target_power', value);
		}catch( error ){
			throw new Error("ERROR_COMM_ERROR");
		}
		return true;
	}
	
	async onCapabilityTargetFanSpeed(value, opts){
		if( await this.getCapabilityValue('auto_mode'))
			throw new Error("AUTO_MODE_ENABLED");
		let url = this.getcallCboxURL("RFAN", true, value);
		try{
			await this.sendHTTPRequest(url);
			this.setCapabilityValue('target_fan_speed', value);
		}catch( error ){
			throw new Error("ERROR_COMM_ERROR");
		}
	}

	async onCapabilityRegulationMode(value, opts){
		let isOn = await this.getCapabilityValue('onoff');
		let stoveState = await this.getCapabilityValue('stove_state');
		let startLocked = ! await this.getCapabilityValue('stove_ignation');

		//if( !isOn && value == "STOPPED" ) throw new Error(this.homey.__('illegalRegulationMode'));
		if( isOn && value == REGULATION_ENUM.STOPPED && (stoveState == STOVE_STATE.STOPPED || stoveState == STOVE_STATE.STOPPING) ){
			this.log("onCapabilityRegulationMode: value="+value);
			this.regulationMode = value;
			this.setCapabilityValue('stove_regulation', value);
			this.setCapabilityValue('onoff', false);
			return;
		}else if( value == REGULATION_ENUM.STOPPED ){
			throw new Error(this.homey.__('manualActionImpossible'));
		}

		if( !isOn && value == REGULATION_ENUM.HG && stoveState == STOVE_STATE.STOPPED ){
			await this.applyTargetPresetForHG();
			if( this.isCanStartForHG() ){
				await this.setOnOffPoele(true);
			}
			return;
		}

		if( value == REGULATION_ENUM.WAITING_TEMP ) throw new Error(this.homey.__('manualActionImpossible'));
		if( !isOn ){
			throw new Error(this.homey.__('illegalRegulationMode'));
		}
		/* A CE POINT LE POELE EST FORCEMENT ON (pas forcement en train de bruler) */
		let needPresetUpdate = false;
		if( value == REGULATION_ENUM.SILENTLY && (stoveState == STOVE_STATE.STARTED || stoveState == STOVE_STATE.STARTING) ){
			if( withLog) this.log('Passage en mode silence');
			needPresetUpdate = true;
		}else if( value == REGULATION_ENUM.PAUSED && stoveState == STOVE_STATE.STARTED ){
			await this.setOnOffPoele(false);
		}else if( value == REGULATION_ENUM.BURNING && stoveState == STOVE_STATE.STOPPED ){
			if( !this.isAutoModeEnable || (this.isAutoModeActive && this.isCanStartWSStartKnonwTemp()) ){
				await this.setOnOffPoele(true);
			}else{
				throw new Error(this.homey.__('illegalRegulationMode'));
			}
		}else if( value == REGULATION_ENUM.BURNING && (stoveState == STOVE_STATE.STARTED || stoveState == STOVE_STATE.STARTING) ){
			if( withLog) this.log('Passage en mode burning');
			needPresetUpdate = true;
		}else if( value == REGULATION_ENUM.HG && (stoveState == STOVE_STATE.STOPPED || stoveState == STOVE_STATE.PAUSED ) ){
			await this.applyTargetPresetForHG();
			if( this.isCanStartForHG() ){
				await this.setOnOffPoele(true);
			}
		}else if( value == REGULATION_ENUM.HG && stoveState == STOVE_STATE.STARTED ){
			if( withLog) this.log('Passage en mode HG');
			await this.applyTargetPresetForHG();
			if( this.isCanPauseForHG() ){
				await this.setOnOffPoele(false);
			}
		}else {
			throw new Error(this.homey.__('manualActionImpossible'));
		}
		/* ON MET A JOUR L'ETAT*/
		this.regulationMode = value;
		await this.setCapabilityValue('stove_regulation', value);
		if( needPresetUpdate )
			await this.applyTargetPresetForCurrentTemp();
	}

	async onCapabilityLocked(value, opts){
		this.setCapabilityValue('stove_ignation', value);
	}



	async onCapabilityAuto(value, opts){
		await this.setCapabilityValue('auto_mode', value);
		this.isAutoModeActive = value;
		if( value )
			this.onTempChange();
	}
	
	/*---------- COMMUNICATION AVEC LA CBOX --------*/
	getOnOffRequestURL(isGotoOn) {
		if( null == this.stoveIp ) throw Error('ERROR_NO_IP');;
		let url = "http://"+this.stoveIp+"/cgi-bin/sendmsg.lua?cmd=CMD+";
		if( isGotoOn ){
			url += "ON";
		}else{
			url += "OFF";
		}
		return url;
	}
	
	getcallCboxURL(command, isSet, value) {
		
		if( null == this.stoveIp ) throw Error('ERROR_NO_IP');
		let url = "http://"+this.stoveIp+"/cgi-bin/sendmsg.lua?cmd=";
		if( isSet ){
			url += "SET+"+command+"+"+value;
		}else{
			url += "GET+"+command;
		}
		return url;
	}

	async setOnOffPoele(setOn){
		let url = this.getOnOffRequestURL(setOn);
		try{
			await this.sendHTTPRequest(url);
		}catch( error ){
			throw new Error("ERROR_COMM_ERROR");
		}
	}
	
	async applyPreset(power, fanSpeed){
		if( withLog) this.log('Application preset: Power:'+power+' Fan:'+fanSpeed);
		let urlForFan = this.getcallCboxURL("RFAN", true, fanSpeed);
		let urlForPower = this.getcallCboxURL("POWR", true, power);
		if( withLog) this.log('ENVOIE FAN');
		await this.sendHTTPRequest(urlForFan);
		if( withLog) this.log('ENVOI POWER');
		await this.sendHTTPRequest(urlForPower);
		if( withLog) this.log('SAUVEGARDE ETAT');
		this.setCapabilityValue('target_fan_speed', ""+fanSpeed);
		this.setCapabilityValue('target_power', ""+power);

		return true;
	}
	
	sendHTTPRequest(url){
		return new Promise( (resolve, reject)=>{
			var myRequest = http.get(url, resp =>{
				let data = '';
				resp.on('data', (chunk) => {
					data += chunk;
				});
				resp.on('end', () => {
					try{
						let jsonData = JSON.parse(data);
						if( jsonData.SUCCESS )
							resolve(jsonData.DATA);
						else
							reject(new Error('Failed'));
					}catch(error){
						reject(error);
					}
				});
			});
			myRequest.on("error", function(err){
				reject(err);
			});
			myRequest.setTimeout(5000);
			myRequest.end();
		});
	}
}

module.exports = CBoxDevice;