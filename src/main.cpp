// SDCARD_SS_PIN is defined for the built-in SD on some boards.
#include <Arduino.h>
#include <SPI.h>
#include <TinyGPSPlus.h>
#include <cstring>
#include <inttypes.h>

#define SD_FAT_TYPE 3
#include <SdFat.h>

#include <RadioLib.h>
#include "pkt.h"

// Modem Parameters (Meshtastic LongFast)
const float FREQ_MHZ = 906.875;
const uint8_t SF = 11;
const unsigned long BW = 250000;
const uint8_t CR = 5;
const uint16_t PREAMBLE = 16;
const uint8_t SYNCWORD = 0x2B;

// Try max SPI clock for an SD. Reduce SPI_CLOCK if errors occur.
//#define SPI_CLOCK 400000UL   // 400 kHz raw Hz; this fork has no SD_SCK_KHZ
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
		//
#define SD_CS_PIN 11

#define SD_CONFIG SdSpiConfig(SD_CS_PIN, SHARED_SPI, SPI_CLOCK) // hardware SPI shared w sx1262 (radio slept)
																//
#define SD_SYNC_PERIOD_MS 5000 // force buffer flush every period

#ifndef NODE_ID
#define NODE_ID 1
#endif

#ifndef TARGET_ID
#define TARGET_ID 2
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
constexpr uint8_t BUTTON_PIN = PIN_100;

constexpr uint16_t LOG_BUFFER_LEN = 512; // in bytes
//const char* logFileHeader = "event_time_us,time_valid,utc_iso,event_type,node_id,packet_id,lat_e7,lng_e7,gps_fix_time_us,rssi_dbm,snr_db\n"; // file header
const char* logFileHeader = "event_type,event_time,event_pps_micros,node_id,target_id,packet_id,rx_late7,rx_lnge7,rx_sats,tx_late7,tx_lnge7,tx_sats,rx_rssix10,rx_snrx10,tx_rssix10,tx_snrx10,packet_len,latency_us\n"; // file header
char logBuffer[LOG_BUFFER_LEN];
size_t logIndex = 0;
uint32_t lastSyncMs;
volatile bool radioInTx = false;
volatile bool pps = false;
volatile uint32_t reqLogTxDoneMicros = 0;
volatile bool awaitingLogResponse = false;

static QueueHandle_t txReqQueue;
constexpr uint8_t txReqQueueLen = 4;

TinyGPSPlus gps;

struct GpsFix {
	int32_t lat_E7;
	int32_t lng_E7;
	int16_t altM;
	uint8_t sats;
	bool valid;
	uint32_t unixTime;
};
constexpr uint8_t logQueueLen = 32;
QueueHandle_t logQueue;
struct LogEvent {
    uint8_t event_type;
	uint32_t event_time;
	uint32_t event_pps_micros;
	uint16_t node_id;
	uint16_t target_id;
	uint16_t packet_id;
	int32_t rx_late7;
	int32_t rx_lnge7;
	uint8_t rx_sats;
	int32_t tx_late7;
	int32_t tx_lnge7;
	uint8_t tx_sats;
	int16_t rx_rssix10;
	int16_t rx_snrx10;
	int16_t tx_rssix10;
	int16_t tx_snrx10;
	uint8_t packet_len;
	uint32_t latency_us;
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
    RADIO_IRQ_TX_DONE = 2
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
void handleRxDone(uint32_t);
void pollTx(void*);
void activatePPS(void);
void handle_location(const struct LocationPacket*, bool, int16_t, int16_t, uint32_t);

static int32_t days_from_civil(int y, int m, int d){
	y -= m <= 2;
	int32_t era = (y >= 0 ? y : y-399) / 400;
	int32_t yoe = y - era * 400;
	int32_t doy = (153*(m + (m > 2 ? -3 : 9)) + 2)/5 + d-1;
	int32_t doe = yoe * 365 + yoe/4 - yoe/100 + doy;
	return era * 146097 + doe - 719468;
}

void activatePPS(void){
	Serial.println("pps");
}


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

bool logWriteToCsv(struct LogEvent& event){
	char line[160];
    int len = snprintf(
        line,
        sizeof(line),
        "%u,%" PRIu32 ",%" PRIu32 ",%" PRIu16 ",%" PRIu16 ",%" PRIu16 ",%" PRId32 ",%" PRId32 ",%u,%" PRId32 ",%" PRId32 ",%u,%" PRId16 ",%" PRId16 ",%" PRId16 ",%" PRId16 ",%u,%" PRIu32 "\n",
        (unsigned)event.event_type,
        event.event_time,
        event.event_pps_micros,
        event.node_id,
        event.target_id,
        event.packet_id,
        event.rx_late7,
        event.rx_lnge7,
        (unsigned)event.rx_sats,
        event.tx_late7,
        event.tx_lnge7,
        (unsigned)event.tx_sats,
        event.rx_rssix10,
        event.rx_snrx10,
        event.tx_rssix10,
        event.tx_snrx10,
        (unsigned)event.packet_len,
        event.latency_us
    );

	if(len <= 0 || len >= (int)sizeof(line)){
		return false;
	}

	return appendToLogBuffer(line, (size_t)len);
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
	Serial.println("wrote header");
	
	while(1){
		struct LogEvent event;
		if(xQueueReceive(logQueue, (void *)&event, pdMS_TO_TICKS(1000)) == pdTRUE){
			logWriteToCsv(event);
		}
		if ((uint32_t)(millis() - lastSyncMs) > SD_SYNC_PERIOD_MS) {
			flushLogBuffer(true);
			lastSyncMs = millis();
		}
	}
}

void gpsPoll(void* parameter){
	while(1){
		while(Serial1.available()){              // drain UART each cycle, no per-byte delay
			if(gps.encode(Serial1.read())){
				//Serial.println("new fix");
				GpsFix fix;
				fix.valid = gps.location.isValid();
				if(fix.valid){
					fix.lat_E7 = (int32_t)(gps.location.lat() * 10000000.0);
					fix.lng_E7 = (int32_t)(gps.location.lng() * 10000000.0);
					fix.altM = (int16_t)(gps.altitude.meters());
					fix.sats = (uint8_t)(gps.satellites.value());
				} else {
					fix.lat_E7 = 0;
					fix.lng_E7 = 0;
					fix.altM = 0;
					fix.sats = 0;
				}
				if(gps.date.isValid() && gps.time.isValid()){
					int32_t days = days_from_civil(gps.date.year(), gps.date.month(), gps.date.day());
					fix.unixTime = (uint32_t)days * 86400UL
						+ (uint32_t)gps.time.hour() * 3600UL
						+ (uint32_t)gps.time.minute() * 60UL
						+ (uint32_t)gps.time.second();
				} else {
					fix.unixTime = 0;
				}
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
	
	Serial.println("sd flushed");
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
	if(radioInTx){ev.type = RADIO_IRQ_TX_DONE;} // if in tx (startTransmit), cannot receive
	else{ev.type = RADIO_IRQ_RX_DONE;}
	ev.microsAtIrq = micros();

	BaseType_t woken = pdFALSE; // deterministically fastest way to handle smallest
    xQueueSendFromISR(radioIrqQueue, &ev, &woken);
    portYIELD_FROM_ISR(woken);
}

void lora_handleRx(void* parameter){
    RadioIrqEvent irq;
    uint8_t txReq;
	while (true) {
		// wait on radio IRQ with short timeout so we also poll txReqQueue
		if(xQueueReceive(radioIrqQueue, &irq, pdMS_TO_TICKS(20)) == pdTRUE){
			switch (irq.type) {
				case RADIO_IRQ_RX_DONE:
					handleRxDone(irq.microsAtIrq);
					break;

				case RADIO_IRQ_TX_DONE:
					reqLogTxDoneMicros = irq.microsAtIrq;
					awaitingLogResponse = true;
					radioInTx = false;
					radio.startReceive();
					break;

				default:
					break;
			}
		}
		// drain any pending button-press requests
		while(xQueueReceive(txReqQueue, &txReq, 0) == pdTRUE){
			if(radioInTx){
				Serial.println("[TX] busy (radioInTx), dropping button req");
				continue;
			}
			AckPacket ackPacket;
			sftrk_make_req_log(&ackPacket, NODE_ID, TARGET_ID);
			radioInTx = true;
			int16_t s = radio.startTransmit((const uint8_t*)&ackPacket, sizeof(struct AckPacket));
			if(s != RADIOLIB_ERR_NONE){
				radioInTx = false;
				radio.startReceive();
				Serial.printf("[TX] startTransmit FAIL state=%d\n", s);
			} else {
				Serial.println("[TX] 0x30 sent, awaiting TX_DONE");
			}
		}
	}
}

void handle_location(const struct LocationPacket* loc, bool valid, int16_t rssi, int16_t snrX10, uint32_t rxIrqMicros){
    LogEvent log = {};

	if(valid) {
		log.event_type = SFTRK_FLAG_GPS_VALID;
		Serial.print("[RX] Valid GPS packet from node: ");
		Serial.print(loc->header.nodeId);
		Serial.print("\n");
	}
	else {
		log.event_type = SFTRK_FLAG_GPS_INVALID;
		Serial.print("[RX] Invalid GPS packet from node: ");
		Serial.print(loc->header.nodeId);
		Serial.print("\n");
	}

	GpsFix fix;
	xSemaphoreTake(gpsMutexHandle, portMAX_DELAY);
	fix = latestFix;
	xSemaphoreGive(gpsMutexHandle);

	log.event_time = fix.unixTime;
	log.event_pps_micros = 0;
	log.node_id = loc->header.nodeId;
	log.target_id = loc->header.targetId;
	log.packet_id = loc->packet_id;
	log.rx_late7 = fix.lat_E7;
	log.rx_lnge7 = fix.lng_E7;
	log.rx_sats = fix.sats;
	log.tx_late7 = loc->gps_lat;
	log.tx_lnge7 = loc->gps_lng;
	log.tx_sats = loc->gps_numSat;
	log.rx_rssix10 = rssi;
	log.rx_snrx10 = snrX10;
	log.tx_rssix10 = loc->rx_rssi;
	log.tx_snrx10 = loc->rx_snr;
	log.packet_len = sizeof(struct LocationPacket);

	uint32_t latency = 0;
	if(awaitingLogResponse){
		latency = rxIrqMicros - reqLogTxDoneMicros; // unsigned wrap-safe
		awaitingLogResponse = false;
	}
	log.latency_us = latency;

    xQueueSend(logQueue, &log, 0);
	return;
}

void handle_ack(const struct AckPacket* ack){
	return;
}

void handleRxDone(uint32_t irqMicros) {
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
		rejectedCrc++;
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
			handle_location((const struct LocationPacket*)rxBuffer, true, rssi, (int16_t)round(snrFloat * 10), irqMicros);
			break;
		case SFTRK_FLAG_GPS_INVALID:
			handle_location((const struct LocationPacket*)rxBuffer, false, rssi, (int16_t)round(snrFloat * 10), irqMicros);
			break;
		case SFTRK_FLAG_ACK:
			handle_ack((const struct AckPacket*)rxBuffer);
			break;
		default:
			break;
	}

    //LogEvent log = {};
    //log.eventTimeUs = irqMicros;
    ////log.timeValid = eventTimeUs != 0;
	//log.timeValid = true;
    //log.eventType = SFTRK_FLAG_GPS_VALID;
    //log.rssiDbm = rssi;
    //log.snrDb = (int8_t)round(snrFloat * 10);
    //log.packetLen = rxLen;

    ////copyLatestGpsFix(&log.);

    //xQueueSend(logQueue, &log, pdMS_TO_TICKS(50));

    // restart receive if needed
    radio.startReceive();
}

void pollTx(void* parameter){
	uint8_t stable = 0;
	bool debounced = HIGH;
	while(1){
		bool raw = digitalRead(BUTTON_PIN);
		if(raw == debounced){
			stable = 0;
		} else {
			if(++stable >= 3){
				debounced = raw;
				stable = 0;
				if(debounced == LOW){
					uint8_t dummy = 0;
					xQueueSend(txReqQueue, &dummy, 0);
					Serial.println("button pressed");
				}
			}
		}
		vTaskDelay(pdMS_TO_TICKS(20));
	}
}

void POLL_PPS_IRQ(void* parameters){
	return;
}

void setup(void){
	pinMode(LED_BUILTIN, OUTPUT);
	pinMode(BUTTON_PIN, INPUT_PULLUP);
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
	txReqQueue = xQueueCreate(txReqQueueLen, sizeof(uint8_t));

	Serial.println("queues init");

	int radio_status = radio.begin();
	if(radio_status != RADIOLIB_ERR_NONE){
		while(1){delay(1);}
	}
	radio.setSyncWord(0x5F);
	radio.setPreambleLength(8);
	radio.setCRC(2);
	radio.explicitHeader();
	radio.setDio1Action(onRadioDio1);
	//radio.setOutputPower(21);

	radio.setFrequency(FREQ_MHZ);
	radio.setSpreadingFactor(SF);
	radio.setBandwidth(BW);
	radio.setCodingRate(CR);
	radio.setPreambleLength(PREAMBLE);
	//radio.setSyncWord(SYNCWORD);
	attachInterrupt(digitalPinToInterrupt(PPS_GPS_PIN), activatePPS, RISING);


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
			1,
			NULL);
	Serial.println("led init");


	xTaskCreate(pollTx, "Poll for Tx", 1024, NULL, 2, NULL);
	//xTaskCreate(POLL_PPS_IRQ, "Poll IRQ var for PPS", 1024, NULL, 5, NULL);
	
}

void loop(void){
	//vTaskDelay(pdMS_TO_TICKS(100));
	vTaskDelay(pdMS_TO_TICKS(100));
}
