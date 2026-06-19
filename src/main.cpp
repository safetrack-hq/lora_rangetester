// SDCARD_SS_PIN is defined for the built-in SD on some boards.
#include "TypeDef.h"
#include <Arduino.h>
#include <SPI.h>
#include <TinyGPSPlus.h>

#define SD_FAT_TYPE 3
#include <SdFat.h>

#include <RadioLib.h>
#include "pkt.h"


// Try max SPI clock for an SD. Reduce SPI_CLOCK if errors occur.
#define SPI_CLOCK 400000UL   // 400 kHz raw Hz; this fork has no SD_SCK_KHZ

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
		//
#define SD_CS_PIN 11

#define SD_CONFIG SdSpiConfig(SD_CS_PIN, SHARED_SPI, SPI_CLOCK) // hardware SPI shared w sx1262 (radio slept)
																//
#ifndef NODE_ID
#define NODE_ID 1
#endif

// lora pre processor defs
// TODO: replace all pinouts with actuals
#ifndef SX126X_CS
#define SX126X_CS (32 + 13)
#endif //SX126X_CS
#ifndef SX126X_DIO1
#define SX126X_DIO1 (0 + 10)
//#define SX126X_DIO1 (0 + 0)
#endif //SX126X_DIO1
#ifndef SX126X_RESET
#define SX126X_RESET (0 + 9)
#endif //SX126X_RESET
#ifndef SX126X_BUSY
#define SX126X_BUSY (0 + 29)
#endif //SX126X_BUSY


SX1262 radio = new Module(SX126X_CS, SX126X_DIO1, SX126X_RESET, SX126X_BUSY);
uint8_t rxBuffer[64];

constexpr uint8_t RX_GPS_PIN = 22;
constexpr uint8_t TX_GPS_PIN = 20;
constexpr uint8_t PPS_GPS_PIN = 31;
//constexpr uint8_t SD_CS_PIN = 24;

constexpr uint16_t LOG_BUFFER_LEN = 512; // in bytes
const char* logFileHeader = "event_time_us,time_valid,utc_iso,event_type,node_id,packet_id,lat_e7,lng_e7,gps_fix_time_us,rssi_dbm,snr_db\n"; // file header
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
constexpr uint8_t logQueueLen = 32;
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
	uint8_t packetLen;
};

GpsFix latestFix;
static SemaphoreHandle_t gpsMutexHandle;
//constexpr uint8_t LOG_HANDLE_LEN = 
//static QueueHandle_t logHandle;
static QueueHandle_t radioIrqQueue;
constexpr uint8_t radioIrqQueueLen = 12;

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
struct RadioIrqEvent {
	RadioIrqType type;
	uint32_t microsAtIrq;
};
uint16_t rejectedBadLength;
uint16_t rejectedCrc;
uint16_t rejectedForeign;

// FUNCTION DECLARATIONS
void setup(void);
// tasks
void txTelemetry(void*);
void blinkLED(void*);
void writeLogTask(void*);
void gpsPoll(void*);
void lora_handleRx(void*);
void loop(void);
// helper functions
bool makeSequentialFilename(uint8_t, char*, size_t);
bool flushLogBuffer(bool);
bool appendToLogBuffer(const char*, size_t);
// isrs
void onRadioDio1(void);


void txTelemetry(void* parameter){
	//broad cast telem over bleuart
	while (1){
		vTaskDelay(pdMS_TO_TICKS(1000));
	}
}

void blinkLED(void* parameter){
	//vTaskDelete(nullptr);
	while(1){
		Serial.println("led task");
		digitalWrite(LED_BUILTIN, HIGH);
		vTaskDelay(pdMS_TO_TICKS(1000));
		digitalWrite(LED_BUILTIN, LOW);
		vTaskDelay(pdMS_TO_TICKS(1000));
	}
}

void writeLogTask(void* parameter){

	// init logging
	if (!sd.begin(SD_CONFIG)) {
		Serial.print("sd.begin failed  code=0x");
		Serial.print(sd.sdErrorCode(), HEX);
		Serial.print("  data=0x");
		Serial.println(sd.sdErrorData(), HEX);
		Serial.flush();
		while (1) { delay(500); }   // delay() yields -> USB CDC stays alive
	}
	else{
		Serial.println("a great success!");
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
	Serial.println("file not exists");
	if (!logFile.open(logName, FILE_WRITE)) {
		Serial.println("open failed");
		digitalWrite(LED_BUILTIN, HIGH);
		while(1){delay(1);}
	}
	Serial.println("made file");
	//logFile.print(logFileHeader);
	appendToLogBuffer(logFileHeader, strlen(logFileHeader)); // do not want to write null term to csv
	flushLogBuffer(true);
	
	while(1){
		struct LogEvent event;

		xQueueSend(logQueue, (void *)&event, 10);
		vTaskDelay(pdMS_TO_TICKS(1000));
	}
}

void gpsPoll(void* parameter){
	while(1){
		while(Serial1.available()){              // drain UART each cycle, no per-byte delay
			if(gps.encode(Serial1.read())){
				Serial.println("new fix");
				GpsFix fix;
				fix.lat_E7 = (int32_t)(gps.location.lat() * 10000000.0);
				fix.lng_E7 = (int32_t)(gps.location.lng() * 10000000.0);
				fix.altM = (int16_t)(gps.altitude.meters() * 10000000.0);
				fix.sats = (uint8_t)(gps.satellites.value());
				xSemaphoreTake(gpsMutexHandle, portMAX_DELAY);
				latestFix = fix;
				xSemaphoreGive(gpsMutexHandle);
			}
		}
		vTaskDelay(pdMS_TO_TICKS(50));
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

void onRadioDio1(void){
	RadioIrqEvent ev;
	ev.type = RADIO_IRQ_RX_DONE;
	ev.microsAtIrq = micros();

	BaseType_t woken = pdFALSE;
    xQueueSendFromISR(radioIrqQueue, &ev, &woken);
    portYIELD_FROM_ISR(woken);
}

void lora_handleRx(void* parameter){
    RadioIrqEvent irq;
	while (true) {
		if (xQueueReceive(radioIrqQueue, &irq, portMAX_DELAY) == pdTRUE) {
			switch (irq.type) {
				case RADIO_IRQ_RX_DONE:
					handleRxDone(irq.microsAtIrq);
					break;

				case RADIO_IRQ_TX_DONE:
					handleTxDone(irq.microsAtIrq);
					break;

				case RADIO_IRQ_RX_TIMEOUT:
					handleTimeout(irq.microsAtIrq);
					break;

				//case RADIO_IRQ_CRC_ERR:
				//	handleCrcError(irq.microsAtIrq);
				//	break;
			}
		}
	}
}

void handle_location(const struct LocationPacket* loc, bool valid){
	return;
}

void handle_ack(const struct AckPacket* ack){
	return;
}

void handleRxDone(uint32_t irqMicros) {
    uint64_t eventTimeUs = gpsTimeFromMicros(irqMicros);

    // Read packet and metadata outside ISR
	size_t rxLen = radio.getPacketLength();
    int16_t rssi = radio.getRSSI();
    float snrFloat = radio.getSNR();
    int state = radio.readData(rxBuffer, rxLen);
	
	if(rxLen == 0 || rxLen > sizeof(rxBuffer)){
		rejectedBadLength++;
		return;
	}

	if(state != RADIOLIB_ERR_NONE){
		
	}

	// possibilities:
	// fails crc RADIOLIB_ERR_CRC_MISMATCH or other than err_none
	// improper packet size, improper magic byte, invalid flag: handled by sftrk_validate_packet
	// duplicated packet/old packet/stale packet
	// finally, AckPacket/LocationPacket
	sftrk_flag_t flag = sftrk_validate_packet(rxBuffer, rxLen);

	if(flag == SFTRK_FLAG_INVALID){
		radio.startReceive();
		return;
	}
	switch (flag) {
		case SFTRK_FLAG_INVALID:
			rejectedForeign++;
			return;
		case SFTRK_FLAG_GPS_VALID:
			handle_location((const struct LocationPacket*)rxBuffer, true);
			break;
		case SFTRK_FLAG_GPS_INVALID:
			handle_location((const struct LocationPacket*)rxBuffer, false);
			break;
		case SFTRK_FLAG_ACK:
			handle_ack((const struct AckPacket*)rxBuffer);
			break;
		default:
			break;
	}

	// TODO: implement this in separated funcs for loc and/or ack
    LogEvent log = {};
    log.eventTimeUs = eventTimeUs;
    log.timeValid = eventTimeUs != 0;
    log.eventType = SFTRK_FLAG_GPS_VALID;
    log.rssiDbm = rssi;
    log.snrDb = (int8_t)round(snrFloat * 10);
    log.packetLen = rxLen;

    copyLatestGpsFix(&log.gps);

    xQueueSend(logQueue, &log, 0);

    // restart receive if needed
    radio.startReceive();
}

void setup(void){
	pinMode(LED_BUILTIN, OUTPUT);
	digitalWrite(LED_BUILTIN, LOW);
	Serial.begin(115200);
	while(!Serial){
		delay(1);
	}
	Serial.println("genesis");
	//int radioStatus = radio.begin();
	//Serial.print("radio.begin="); Serial.println(radioStatus);
	//if (radioStatus == RADIOLIB_ERR_NONE) radio.sleep();

	// gps uart
	Serial1.setPins(RX_GPS_PIN, TX_GPS_PIN);
	Serial1.begin(9600);

	Serial.println("gps init...");


	gpsMutexHandle = xSemaphoreCreateMutex();

	logQueue = xQueueCreate(logQueueLen, sizeof(LogEvent));
	radioIrqQueue = xQueueCreate(radioIrqQueueLen, sizeof(RadioIrqEvent));

	Serial.println("queues init");

	int radio_status = radio.begin();
	radio.setSyncWord(0x5F);
	radio.setPreambleLength(8);
	radio.setCRC(2);
	radio.explicitHeader();


	//if(radio_status == RADIOLIB_)
	xTaskCreate(
			lora_handleRx,
			"Handle Lora RX",
			1024,
			NULL,
			3,
			NULL
			);
	Serial.println("handle init");

	xTaskCreate(
			txTelemetry,
			"Send Telemetry",
			1024,
			NULL,
			1,
			NULL);
	Serial.println("telem init...");

	xTaskCreate(
			writeLogTask,
			"Write to Log",
			4096,
			NULL,
			2,
			NULL
			);
	Serial.println("log init");

	xTaskCreate(
			gpsPoll,
			"Poll GPS",
			1024,
			NULL,
			2,
			NULL
			);
	Serial.println("gps task init");

	xTaskCreate(
			blinkLED,
			"Blink LED",
			1024,
			NULL,
			2,
			NULL);
	Serial.println("led init");


}

void loop(void){
	vTaskDelay(pdMS_TO_TICKS(100));
}
