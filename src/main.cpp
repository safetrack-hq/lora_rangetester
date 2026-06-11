// SDCARD_SS_PIN is defined for the built-in SD on some boards.
#include "projdefs.h"
#include "rtos.h"
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

// lora pre processor defs
// TODO: replace all pinouts with actuals
#ifndef SX126X_CS
#define SX126X_CS 11
#endif //SX126X_CS
#ifndef SX126X_DIO1
#define SX126X_DIO1 12
#endif //SX126X_DIO1
#ifndef SX126X_RESET
#define SX126X_RESET 13
#endif //SX126X_RESET
#ifndef SX126X_BUSY
#define SX126X_BUSY 14
#endif //SX126X_BUSY


SX1262 radio = new Module(SX126X_CS, SX126X_DIO1, SX126X_RESET, SX126X_BUSY);

constexpr uint8_t RX_GPS_PIN = 8;
constexpr uint8_t TX_GPS_PIN = 9;
constexpr uint8_t SD_CS_PIN = 10;

constexpr uint16_t LOG_BUFFER_LEN = 512; // in bytes
const char* logFileHeader = "event_time_us,time_valid,utc_iso,event_type,node_id,packet_id,lat_e7,lng_e7,gps_fix_time_us,rssi_dbm,snr_db\n";
char logBuffer[LOG_BUFFER_LEN];
size_t logIndex = 0;

TinyGPSPlus gps;

struct GpsFix {
	int32_t lat_E7;
	int32_t lng_E7;
	int16_t altM;
	uint8_t sats;
	bool valid;
};
QueueHandle_t logQueue;
struct LogEvent {
    uint64_t eventTimeUs;
    uint8_t timeValid;
    uint8_t eventType;
    uint8_t nodeId;
    uint32_t packetId;
    int32_t latE7;
    int32_t lonE7;
    uint64_t gpsFixTimeUs;
    uint8_t gpsValid;
    uint16_t gpsAgeMs;
    int16_t rssiDbm;
    int8_t snrDb;
};

GpsFix latestFix;
static SemaphoreHandle_t gpsMutexHandle;
static QueueHandle_t logHandle;

file_t logFile;
char logName[13];

// lora shi
volatile bool loraRxFlag = false;
enum RadioIrqType : uint8_t {
    RADIO_IRQ_RX_DONE = 1,
    RADIO_IRQ_TX_DONE = 2,
    RADIO_IRQ_RX_TIMEOUT = 3,
    RADIO_IRQ_CAD_DONE = 4
};
struct RadioIRQEvent {
	RadioIrqType type;
	uint32_t microsAtIrq;
};

// FUNCTION DECLARATIONS
void setup(void);
// tasks
void txTelemetry(void*);
void blinkLed(void*);
void writeLogTask(void*);
void gpsPoll(void*);
void lora_handleRx(void*);
void loop(void);
// helper functions
bool makeSequentialFilename(uint8_t, char*, size_t);
bool flushLogBuffer(bool);
bool appendToLogBuffer(const char*, size_t);


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

	// init logging
	if (!sd.begin(SD_CONFIG)) {
		sd.initErrorHalt(&Serial);
	}
	if (!makeSequentialFilename(NODE_ID, logName, sizeof(logName))){
		Serial.println("namespace out");
		digitalWrite(LED_BUILTIN, HIGH);
		while(1){delay(1);}
	}
	if (sd.exists(logName)) {
		Serial.println("file already exists");
		digitalWrite(LED_BUILTIN, HIGH);
		while(1){delay(1);}
	}
	if (!logFile.open(logName, FILE_WRITE)) {
		Serial.println("open failed");
		digitalWrite(LED_BUILTIN, HIGH);
		while(1){delay(1);}
	}
	//logFile.print(logFileHeader);
	appendToLogBuffer(logFileHeader, strlen(logFileHeader)); // do not want to write null term to csv
	
	while(1){
		struct LogEvent event;

		xQueueSend(logHandle, (void *)&event, 10);
	}
}

void gpsPoll(void* parameter){
	while(Serial1.available()){
		if(gps.encode(Serial1.read())){
			GpsFix fix;
			fix.lat_E7 = (int32_t)(gps.location.lat() * 10000000.0);
			fix.lng_E7 = (int32_t)(gps.location.lng() * 10000000.0);
			fix.altM = (int16_t)(gps.altitude.meters() * 10000000.0);
			fix.sats = (uint8_t)(gps.satellites.value());
			xSemaphoreTake(&gpsMutexHandle, portMAX_DELAY);
			latestFix = fix;
			xSemaphoreGive(&gpsMutexHandle);
		}
	}
}


bool makeSequentialFilename(uint8_t nodeId, char* outName, size_t outSize) {
    for (uint16_t i = 1; i <= 9999; i++) {
        snprintf(outName, outSize, "N%02u_%04u.csv", nodeId, i);

        if (!sd.exists(outName)) {
            return true;
        }
    }

    return false; // no names available
}

bool flushLogBuffer(bool forceSync){
	if(!logFile){
		return false;
	}

	if(logIndex == 0){
		if(forceSync){
			logFile.flush();
		}
	}

	size_t written = logFile.write((const uint8_t*)logBuffer, logIndex);

    if (written != logIndex) {
        return false;
    }

    logIndex = 0;

    if (forceSync) {
        logFile.flush();   // commits data/metadata more safely
						   // flush is also very expensive, so should be called infrequently
    }

    return true;
}

/*** 
 * @param data takes in BIG data
 * @param len takes in length to be written from data ref
 * @return returns if it just flushed or not
 ***/
bool appendToLogBuffer(const char* data, size_t len){
	if(!logFile){
		return false;
	}

	if(len > LOG_BUFFER_LEN){ // should never happen but whatever
		flushLogBuffer(false);
		return logFile.write((const uint8_t* )data, len) == len;
	}

	if(logIndex + len > LOG_BUFFER_LEN){ // if overflow would happen after, flush buf
		if(!flushLogBuffer(false)){
			return false;
		}
	}

	memcpy(&logBuffer[logIndex], data, len);
	logIndex += len;

	if(logIndex == LOG_BUFFER_LEN){ // if exactly full, force flush bc we alr here
		return flushLogBuffer(false);
	}

	return true;
}

void lora_handleRx(void* parameter){
	while(1){
		if(receivedFlag){

		}
	}
}

void setup(void){
	pinMode(LED_BUILTIN, OUTPUT);
	Serial.begin(115200);

	// gps uart
	Serial1.setPins(RX_GPS_PIN, TX_GPS_PIN);
	Serial1.begin(9600);


	gpsMutexHandle = xSemaphoreCreateMutex();

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
			4096,
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
			2,
			NULL
			);

	xTaskCreate(
			lora_handleRx,
			"Handle Lora RX",
			1024,
			NULL,
			4,
			NULL
			);
}

void loop(void){
	vTaskDelay(pdMS_TO_TICKS(100));
}
