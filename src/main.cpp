#include "projdefs.h"
#include "rtos.h"
#include "services/BLEDis.h"
#include "variant.h"
#include <Arduino.h>
#include <bluefruit.h>
//#include <RadioLib.h>

//SX1262 radio = new Module(SX126X_CS, SX126X_DIO1, SX126X_RESET, SX126X_BUSY);
BLEDis bledis;
BLEUart bleuart;

void txTelemetry(void* parameter){
	//broad cast telem over bleuart
	while (1){
		Serial.write("blah blah");
		vTaskDelay(pdMS_TO_TICKS(1000));
	}
}

void blinkLED(void* parameter){
	while(1){
		digitalWrite(LED_BUILTIN, HIGH);
		vTaskDelay(pdMS_TO_TICKS(1000));
		digitalWrite(LED_BUILTIN, LOW);
		vTaskDelay(pdMS_TO_TICKS(1000));
	}
}

void setup(void){
	Serial.begin(9600);
	
	//start bluefruit Config
	Bluefruit.autoConnLed(true);
	Bluefruit.configPrphBandwidth(BANDWIDTH_MAX);
	Bluefruit.begin();
	Bluefruit.setTxPower(4);
	Bluefruit.Periph.setConnectCallback(ble_connect_callback);
	Bluefruit.Periph.setDisconnectCallback(disconnect_callback);
	Bluefruit.Periph.setConnInterval(6, 12); // apparently 7.5ms-12ms (this is recommendation, doesn't need to followed by host)
	
	bledis.setManufacturer("Joe");
	bledis.setModel("LoRa Range Tester");

	bleuart.setRxCallback(bleuart_rx_callback);
	bleuart.setNotifyCallback(bleuart_notify_callback);
	// end bluefruit config


	pinMode(LED_BUILTIN, OUTPUT);

	xTaskCreate(
			txTelemetry,
			"Send Telemetry",
			1024,
			NULL,
			1,
			NULL);
	xTaskCreate(
			blinkLED,
			"Blink LED",
			1024,
			NULL,
			1,
			NULL);
}

void loop(void){

}
