// SDCARD_SS_PIN is defined for the built-in SD on some boards.
#include "variant.h"
#include "wiring_digital.h"
#include <Arduino.h>
#include <SPI.h>
#include <TinyGPSPlus.h>

#define SD_FAT_TYPE 3
#include <SdFat.h>

#include <RadioLib.h>


// Try max SPI clock for an SD. Reduce SPI_CLOCK if errors occur.
#define SPI_CLOCK SD_SCK_MHZ(50)

#define SD_FAT_TYPE 3
#if SD_FAT_TYPE == 0
SdFat sd;
typedef File file_t;
#elif SD_FAT_TYPE == 1
SdFat32 sd;
typedef File32 file_t;
#elif SD_FAT_TYPE == 2
SdExFat sd;
typedef ExFile file_t;
#elif SD_FAT_TYPE == 3
SdFs sd;
typedef FsFile file_t;
#else  // SD_FAT_TYPE
#error Invalid SD_FAT_TYPE
#endif  // SD_FAT_TYPE

#define SD_CONFIG SdSpiConfig(SD_CS_PIN, SHARED_SPI, SPI_CLOCK) // SPI shared w sx1262
																//
#ifndef NODE_ID
#define NODE_ID 1
#endif

//SX1262 radio = new Module(SX126X_CS, SX126X_DIO1, SX126X_RESET, SX126X_BUSY);

constexpr uint8_t RX_GPS_PIN = 8;
constexpr uint8_t TX_GPS_PIN = 9;
constexpr uint8_t SD_CS_PIN = 10;

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

file_t logFile;
char logName[13];

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
		logFile.
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


bool makeSequentialFilename(uint8_t nodeId, char *outName, size_t outSize) {
    for (uint16_t i = 1; i <= 9999; i++) {
        snprintf(outName, outSize, "N%02u_%04u.csv", nodeId, i);

        if (!sd.exists(outName)) {
            return true;
        }
    }

    return false; // no names available
}

void setup(void){
	pinMode(LED_BUILTIN, OUTPUT);
	Serial.begin(115200);
	Serial1.setPins(RX_GPS_PIN, TX_GPS_PIN);
	Serial1.begin(9600);

	if (!sd.begin(SD_CONFIG)) {
		sd.initErrorHalt(&Serial);
	}
	
	if (!makeSequentialFilename(NODE_ID, logName, sizeof(logName))){
		Serial.println("namespace out");
		digitalWrite(LED_BUILTIN, HIGH);
		while(1){delay(1);}
	}

	// Remove any existing file.
	if (sd.exists(logName)) {
		Serial.println("file already exists");
		digitalWrite(LED_BUILTIN, HIGH);
		while(1){delay(1);}
	}
	// Create the file.
	if (!logFile.open(logName, FILE_WRITE)) {
		Serial.println("open failed");
		digitalWrite(LED_BUILTIN, HIGH);
		while(1){delay(1);}
	}

	gpsMutex = xSemaphoreCreateMutex();

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
