#include <Arduino.h>
#include <SPI.h>
#include <TinyGPSPlus.h>
#include <RadioLib.h>
#include "pkt.h"
//static_assert(sizeof(struct AckPacket) == 6, "AckPacket size != 6");

#ifndef NODE_ID
#define NODE_ID 2
#endif

#define GPS_DEBUG 0
#define RX_HEX_DEBUG 1

#ifndef LED_BUILTIN
#define LED_BUILTIN LED_BLUE
#endif

// Modem Parameters (Meshtastic LongFast)
const float FREQ_MHZ = 906.875;
const uint8_t SF = 11;
const unsigned long BW = 250000;
const uint8_t CR = 5;
const uint16_t PREAMBLE = 16;
const uint8_t SYNCWORD = 0x2B;

#ifndef SX126X_CS
#define SX126X_CS (32 + 13)
#endif
#ifndef SX126X_DIO1
#define SX126X_DIO1 (0 + 10)
#endif
#ifndef SX126X_RESET
#define SX126X_RESET (0 + 9)
#endif
#ifndef SX126X_BUSY
#define SX126X_BUSY (0 + 29)
#endif

SX1262 radio = new Module(SX126X_CS, SX126X_DIO1, SX126X_RESET, SX126X_BUSY);
uint8_t rxBuffer[64];

//constexpr uint8_t RX_GPS_PIN = 22;
//constexpr uint8_t TX_GPS_PIN = 20;
#ifndef GPS_TX_PIN
#define GPS_TX_PIN 22
#endif
#ifndef GPS_RX_PIN
#define GPS_RX_PIN 20
#endif


TinyGPSPlus gps;

struct GpsFix {
	int32_t lat_E7;
	int32_t lng_E7;
	int16_t altM;
	uint8_t sats;
	bool valid;
};
GpsFix latestFix;
static SemaphoreHandle_t gpsMutexHandle;

volatile bool radioInTx = false;
static uint16_t packetIdCounter = 0;

constexpr uint8_t radioIrqQueueLen = 12;
static QueueHandle_t radioIrqQueue;
constexpr uint8_t txPongQueueLen = 4;
static QueueHandle_t txPongQueue;
static TaskHandle_t txPongTaskHandle;

enum RadioIrqType : uint8_t {
	RADIO_IRQ_RX_DONE = 1,
	RADIO_IRQ_TX_DONE = 2,
};

struct RadioIrqEvent {
	RadioIrqType type;
	uint32_t microsAtIrq;
};

struct PongReq {
	uint16_t reqNodeId;
	int16_t  rssi;
	int16_t  snrX10;
};

uint16_t rejectedBadLength;
uint16_t rejectedCrc;
uint16_t rejectedForeign;

// FUNCTION DECLARATIONS
void setup(void);
void loop(void);
void gpsPoll(void*);
void lora_handleRx(void*);
void txPongTask(void*);
void blinkLED(void*);
void onRadioDio1(void);
void handleRxDone(uint32_t);
void dumpHex(const uint8_t* buf, size_t len);

void gpsPoll(void* parameter){
	while(1){
		while(Serial1.available()){
			if(gps.encode(Serial1.read())){
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
				xSemaphoreTake(gpsMutexHandle, portMAX_DELAY);
				latestFix = fix;
				xSemaphoreGive(gpsMutexHandle);
				#if GPS_DEBUG
				Serial.printf("[GPS] fix valid=%d lat=%ld lng=%ld sats=%u\n",
					fix.valid, fix.lat_E7, fix.lng_E7, fix.sats);
				#endif
			}
		}
		vTaskDelay(pdMS_TO_TICKS(50));
	}
}

void onRadioDio1(void){
	RadioIrqEvent ev;
	ev.microsAtIrq = micros();
	Serial.println("radio irq");
	if(radioInTx){
		ev.type = RADIO_IRQ_TX_DONE;
	} else {
		ev.type = RADIO_IRQ_RX_DONE;
	}
	BaseType_t woken = pdFALSE;
	xQueueSendFromISR(radioIrqQueue, &ev, &woken);
	portYIELD_FROM_ISR(woken);
}

void handleRxDone(uint32_t irqMicros){
	size_t rxLen = radio.getPacketLength();
	int16_t rssi = radio.getRSSI();
	float snrFloat = radio.getSNR();
	int state = radio.readData(rxBuffer, rxLen);

	Serial.printf("[RX] len=%u rssi=%d snr=%.1f\n", rxLen, rssi, snrFloat);

	if(rxLen == 0 || rxLen > sizeof(rxBuffer)){
		rejectedBadLength++;
		Serial.println("[RX] reject: bad length");
		if(rxLen > 0 && rxLen <= sizeof(rxBuffer)) dumpHex(rxBuffer, rxLen);
		radio.startReceive();
		return;
	}

	if(state != RADIOLIB_ERR_NONE){
		rejectedCrc++;
		Serial.printf("[RX] reject: CRC state=%d\n", state);
		dumpHex(rxBuffer, rxLen);
		radio.startReceive();
		return;
	}

	// Manual validation for 0x30 (SFTRK_FLAG_REQ_LOG):
	// sftrk_validate_packet falls through to INVALID for this flag,
	// so we check magic/flag/length/targetId inline.
	if(rxLen != sizeof(struct AckPacket)){
		rejectedForeign++;
		Serial.printf("[RX] reject: foreign flag=0x%02X\n", ((const struct Header*)rxBuffer)->flag);
		dumpHex(rxBuffer, rxLen);
		radio.startReceive();
		return;
	}
	const struct Header* h = (const struct Header*)rxBuffer;
	if(h->magic != SFTRK_MAGIC){
		rejectedForeign++;
		Serial.println("[RX] reject: bad magic");
		dumpHex(rxBuffer, rxLen);
		radio.startReceive();
		return;
	}
	if(h->flag != SFTRK_FLAG_REQ_LOG){
		rejectedForeign++;
		Serial.printf("[RX] reject: foreign flag=0x%02X\n", h->flag);
		dumpHex(rxBuffer, rxLen);
		radio.startReceive();
		return;
	}
	if(h->targetId != NODE_ID){
		rejectedForeign++;
		Serial.printf("[RX] reject: targetId=%u != %u\n", h->targetId, NODE_ID);
		dumpHex(rxBuffer, rxLen);
		radio.startReceive();
		return;
	}

	Serial.printf("[RX] accept 0x30 fromNode=%u target=%u\n", h->nodeId, h->targetId);
	dumpHex(rxBuffer, rxLen);

	struct PongReq req;
	req.reqNodeId = h->nodeId;
	req.rssi = rssi;
	req.snrX10 = (int16_t)round(snrFloat * 10);

	if(xQueueSend(txPongQueue, &req, 0) != pdTRUE){
		Serial.println("[RX] WARN: txPongQueue full, dropping pong");
		radio.startReceive();
	} else {
		Serial.printf("[RX] queued pong reqNode=%u rssi=%d snrX10=%d\n",
			req.reqNodeId, req.rssi, req.snrX10);
	}
	// do NOT startReceive on accept path; txPongTask will startTransmit next,
	// and TX_DONE handler will return us to RX.
}

void lora_handleRx(void* parameter){
	RadioIrqEvent irq;
	while(true){
		if(xQueueReceive(radioIrqQueue, &irq, portMAX_DELAY) == pdTRUE){
			Serial.printf("[IRQ] type=%u micros=%lu\n", irq.type, irq.microsAtIrq);
			switch(irq.type){
				case RADIO_IRQ_RX_DONE:
					handleRxDone(irq.microsAtIrq);
					break;
				case RADIO_IRQ_TX_DONE:
					radioInTx = false;
					Serial.println("[TX_DONE] startReceive + notify txPongTask");
					radio.startReceive();
					if(txPongTaskHandle){
						xTaskNotifyGive(txPongTaskHandle);
					}
					break;
				default:
					break;
			}
		}
	}
}

void txPongTask(void* parameter){
	while(true){
		struct PongReq req;
		if(xQueueReceive(txPongQueue, &req, portMAX_DELAY) != pdTRUE){
			continue;
		}

		Serial.println("[TX] got pong req");

		// snapshot GPS fix under mutex
		GpsFix fix;
		xSemaphoreTake(gpsMutexHandle, portMAX_DELAY);
		fix = latestFix;
		xSemaphoreGive(gpsMutexHandle);

		Serial.printf("[TX] fix valid=%d lat=%ld lng=%ld sats=%u\n",
			fix.valid, fix.lat_E7, fix.lng_E7, fix.sats);

		struct LocationPacket pkt;
		uint16_t pid = packetIdCounter++;
		sftrk_make_location(
			&pkt,
			(uint16_t)NODE_ID,
			req.reqNodeId,
			fix.valid,
			req.rssi,
			req.snrX10,
			fix.valid ? fix.lng_E7 : 0,
			fix.valid ? fix.lat_E7 : 0,
			fix.valid ? fix.sats : 0,
			0,
			pid
		);
		pkt.packet_id = pid;

		Serial.printf("[TX] pkt built flag=0x%02X nodeId=%u target=%u pid=%u\n",
			pkt.header.flag, pkt.header.nodeId,
			pkt.header.targetId, pkt.packet_id);
		radio.standby();
		radioInTx = true;
		int16_t txState = radio.startTransmit((uint8_t*)&pkt, sizeof(struct LocationPacket));
		if(txState != RADIOLIB_ERR_NONE){
			// transmit failed to start; abort and return to RX
			radioInTx = false;
			Serial.printf("[TX] startTransmit FAIL state=%d\n", txState);
			radio.startReceive();
			continue;
		}
		Serial.printf("[TX] startTransmit OK pid=%u, awaiting TX_DONE...\n", pkt.packet_id);

		// wait for TX_DONE notification from lora_handleRx
		xTaskNotifyWait(0, 0, NULL, portMAX_DELAY);
		Serial.println("[TX] TX_DONE received, radio back to RX");
	}
}

void blinkLED(void* parameter){
	while(1){
		Serial.println("led task");
		digitalWrite(LED_BUILTIN, HIGH);
		vTaskDelay(pdMS_TO_TICKS(1000));
		digitalWrite(LED_BUILTIN, LOW);
		vTaskDelay(pdMS_TO_TICKS(1000));
	}
}

void dumpHex(const uint8_t* buf, size_t len){
#if RX_HEX_DEBUG
	Serial.print("[HEX] ");
	for(size_t i = 0; i < len; i++){
		Serial.printf("%02X ", buf[i]);
		if((i + 1) % 16 == 0 && (i + 1) != len) Serial.println();
	}
	Serial.println();
#endif
}

void setup(void){
	pinMode(LED_BUILTIN, OUTPUT);
	digitalWrite(LED_BUILTIN, LOW);
	Serial.begin(115200);
	//while(!Serial){
		//delay(1);
	//}
	Serial.println("tx_test genesis");

#ifdef _VARIANT_PROMICRO_V2_DIY_
	pinMode(PIN_GPS_EN, OUTPUT);
	digitalWrite(PIN_GPS_EN, HIGH);
	delay(250);
#endif

	SPI.begin();

	Serial1.setPins(GPS_RX_PIN, GPS_TX_PIN);
	Serial1.begin(9600);
	Serial.println("gps init...");

	gpsMutexHandle = xSemaphoreCreateMutex();
	radioIrqQueue = xQueueCreate(radioIrqQueueLen, sizeof(RadioIrqEvent));
	txPongQueue = xQueueCreate(txPongQueueLen, sizeof(struct PongReq));
	Serial.println("queues init");

	int radio_status = radio.begin();
	if(radio_status != RADIOLIB_ERR_NONE){
		Serial.print("radio.begin failed code=");
		Serial.println(radio_status);
		while(1){ delay(1); }
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
	if(radio.startReceive() != RADIOLIB_ERR_NONE){
		Serial.println("startReceive failed");
		while(1){ delay(1); }
	}
	Serial.println("radio rx mode");

	xTaskCreate(lora_handleRx, "Handle Lora RX", 1024, NULL, 3, NULL);
	Serial.println("lora_handleRx init");

	xTaskCreate(txPongTask, "TX Pong", 1024, NULL, 2, &txPongTaskHandle);
	Serial.println("txPongTask init");

	xTaskCreate(gpsPoll, "Poll GPS", 1024, NULL, 2, NULL);
	Serial.println("gps task init");

	xTaskCreate(blinkLED, "Blink LED", 1024, NULL, 2, NULL);
	Serial.println("led init");
}

void loop(void){
	vTaskDelay(pdMS_TO_TICKS(100));
}
