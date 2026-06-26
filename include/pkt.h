#include <stdint.h>
#include <stdlib.h>

#define SFTRK_MAGIC 0x56

// flag byte defs
// low nibble represents network protocol revisions
// 0: logging protocol
typedef enum {
	SFTRK_FLAG_NONE = 0x00,
	SFTRK_FLAG_GPS_VALID = 0x10,
	SFTRK_FLAG_GPS_INVALID = 0x20,
	SFTRK_FLAG_REQ_LOG = 0x30,
	SFTRK_FLAG_ACK = 0x40,
	SFTRK_FLAG_INVALID = 0xFF
} sftrk_flag_t;

// header used in all packet types
// 5 bytes
struct Header {
	uint8_t magic;
	sftrk_flag_t flag;
	uint16_t nodeId;
	uint16_t targetId;
}__attribute__((packed));

// used in receiver -> beacon (response)
// 21 bytes
struct LocationPacket {
	struct Header header;
	int16_t rx_rssi; // / 10
	int16_t rx_snr; // / 10
	bool gps_fix; // is fix acquired? (may not be necessary)
	int32_t gps_lng; // / 10000000
	int32_t gps_lat; // / 10000000
	uint8_t gps_numSat;
	uint8_t gps_avgGsvSnr;
	uint16_t packet_id;
}__attribute__((packed));


// used in beacon -> receiver
// sike, actually it's not
// 5 bytes
struct AckPacket {
	struct Header header;
}__attribute__((packed));

static_assert(sizeof(struct Header) == 6, "Header must be 6 bytes");
static_assert(sizeof(struct AckPacket) == 6, "ayo fix ts");
static_assert(sizeof(struct LocationPacket) == 23, "LocationPacket must be 23 bytes");

static inline void sftrk_init_header(struct Header* header, sftrk_flag_t flag, uint16_t node, uint16_t target){
	header->magic = SFTRK_MAGIC;
	header->flag = flag;
	header->nodeId = node;
	header->targetId = target;
}

static inline void sftrk_make_ack(struct AckPacket* ackPacket, uint16_t node, uint16_t target){
	sftrk_init_header(&ackPacket->header, SFTRK_FLAG_ACK, node, target);
}

static inline void sftrk_make_req_log(struct AckPacket* ackPacket, uint16_t node, uint16_t target){
	sftrk_init_header(&ackPacket->header, SFTRK_FLAG_REQ_LOG, node, target);
}

static inline void sftrk_make_location(struct LocationPacket* loc, uint16_t node, uint16_t target, bool gpsFix, int16_t rssi, int16_t snr, int32_t lng, int32_t lat, uint8_t numSat, uint8_t avgSnr, uint16_t packet_id){
	loc->rx_rssi = rssi;
	loc->rx_snr = snr;
	loc->gps_lng = lng;
	loc->gps_lat = lat;
	loc->gps_numSat = numSat;
	loc->gps_avgGsvSnr = avgSnr;
	loc->packet_id = packet_id;
	if(gpsFix){ // i hate ternary operators
		sftrk_init_header(&loc->header, SFTRK_FLAG_GPS_VALID, node, target);
	}else{
		sftrk_init_header(&loc->header, SFTRK_FLAG_GPS_INVALID, node, target);
	}
}

// takes in array of bytes and validates magic byte and flag validity
static inline sftrk_flag_t sftrk_validate_packet(const uint8_t* buf, size_t len){
	if (len < sizeof(struct Header)) return SFTRK_FLAG_INVALID;
	const struct Header* h = (const struct Header*)buf;
	if (h->magic != SFTRK_MAGIC) return SFTRK_FLAG_INVALID;
	switch (h->flag){
		case SFTRK_FLAG_REQ_LOG:
			if(len != sizeof(struct AckPacket)) return SFTRK_FLAG_INVALID;
			break;
		case SFTRK_FLAG_ACK:
			if(len != sizeof(struct AckPacket)) return SFTRK_FLAG_INVALID;
			break;
		case SFTRK_FLAG_GPS_VALID:
		case SFTRK_FLAG_GPS_INVALID:
			if (len != sizeof(struct LocationPacket)) return SFTRK_FLAG_INVALID;
			break;
		default:
			return SFTRK_FLAG_INVALID;
	}
	return h->flag; // valid packet
}
