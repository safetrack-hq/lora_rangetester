// SDCARD_SS_PIN is defined for the built-in SD on some boards.
#include <Arduino.h>
#include <SPI.h>
#include <TinyGPSPlus.h>

#define SD_FAT_TYPE 3
#include <SdFat.h>

#include <RadioLib.h>


//SX1262 radio = new Module(SX126X_CS, SX126X_DIO1, SX126X_RESET, SX126X_BUSY);

constexpr uint8_t RX_GPS = 8;
constexpr uint8_t TX_GPS = 9;

TinyGPSPlus gps;

struct gpsFix {
	int32_t lat_E7;
	int32_t lng_E7;
	int16_t altM;
	uint8_t sats;
	bool valid;
};

gpsFix latestFix;
SemaphoreHandle_t gpsMutex;

void txTelemetry(void* parameter){
	//broad cast telem over bleuart
	while (1){
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

void writeLogTask(void* parameter){
	while(1){
		
	}
}

void gpsPoll(void* parameter){
	while(Serial1.available()){
		if(gps.encode(Serial1.read())){
			gpsFix fix;
			fix.lat_E7 = (int32_t)(gps.location.lat() * 10000000.0);
			fix.lng_E7 = (int32_t)(gps.location.lng() * 10000000.0);
			fix.altM = (int16_t)(gps.altitude.meters() * 10000000.0);
			fix.sats = (uint8_t)(gps.satellites.value());
			xSemaphoreTake(&gpsMutex, portMAX_DELAY);
			latestFix = fix;
			xSemaphoreGive(&gpsMutex);
		}
	}
}

void setup(void){
	Serial.begin(9600);
	Serial1.setPins(RX_GPS, TX_GPS);
	Serial1.begin(9600);
	
	gpsMutex = xSemaphoreCreateMutex();


	pinMode(LED_BUILTIN, OUTPUT);

	xTaskCreate(
			txTelemetry,
			"Send Telemetry",
			1024,
			NULL,
			1,
			NULL);

	xTaskCreate(
			writeLogTask,
			"Write to Log",
			2048,
			NULL,
			2,
			NULL
			);

	xTaskCreate(
			blinkLED,
			"Blink LED",
			1024,
			NULL,
			1,
			NULL);

	xTaskCreate(
			gpsPoll,
			"Poll GPS",
			1024,
			NULL,
			1,
			NULL
			);
}

void loop(void){
	vTaskDelay(pdMS_TO_TICKS(100));
}
