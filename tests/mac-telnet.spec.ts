/**
 * MAC-Telnet codec + EC-SRP5/MTWEI crypto tests (offline, no L2 network).
 *
 * The codec and crypto come from `@tikoci/centrs/protocols` (the package this
 * server depends on for MAC-Telnet). These tests exercise that package's pure,
 * bytes-in/bytes-out surface — the same one the live transport uses — plus our
 * local console screen-emulation layer. The live session/console (UDP + RouterOS
 * console negotiation) needs a real L2 segment and is not exercised here.
 */
import { describe, expect, test } from "vite-plus/test";
import {
  buildPacket,
  decodeHeader,
  decodePoint,
  encodeControlBlock,
  encodeHeader,
  encodePoint,
  encodeTerminalDimension,
  formatMac,
  isOnCurve,
  MAC_TELNET_CLIENT_TYPE,
  MAC_TELNET_CONTROL_MAGIC,
  MAC_TELNET_HEADER_LEN,
  MacTelnetControlType,
  MacTelnetPacketType,
  macTelnetPasswordHash,
  mtweiCurve,
  mtweiDocrypto,
  mtweiId,
  mtweiKeygen,
  mtweiOfferValue,
  MTWEI_PUBKEY_LEN,
  MTWEI_VALIDATOR_LEN,
  parseControlBlocks,
  parseMac,
  scalarMul,
} from "@tikoci/centrs/protocols";
import { emulateScreen, extractCommandOutput } from "../src/mac-telnet/console";

describe("MAC address parsing", () => {
  test("parses and round-trips a colon-separated MAC", () => {
    const mac = parseMac("48:A9:8A:C6:42:F6");
    expect([...mac]).toEqual([0x48, 0xa9, 0x8a, 0xc6, 0x42, 0xf6]);
    expect(formatMac(mac)).toBe("48:a9:8a:c6:42:f6");
  });

  test("accepts dash and dot separators", () => {
    expect([...parseMac("48-a9-8a-c6-42-f6")]).toEqual([0x48, 0xa9, 0x8a, 0xc6, 0x42, 0xf6]);
  });

  test("rejects a malformed MAC", () => {
    expect(() => parseMac("48:A9:8A6")).toThrow();
    expect(() => parseMac("zz:zz:zz:zz:zz:zz")).toThrow();
  });
});

describe("MT header codec", () => {
  const src = parseMac("02:00:00:00:00:01");
  const dst = parseMac("48:a9:8a:c6:42:f6");

  test("client header places the session key at offset 14 and client type at 16", () => {
    const header = encodeHeader({
      type: MacTelnetPacketType.sessionStart,
      sourceMac: src,
      destinationMac: dst,
      sessionKey: 0x1234,
      counter: 0,
    });
    expect(header.length).toBe(MAC_TELNET_HEADER_LEN);
    expect(header[0]).toBe(1);
    expect(header[1]).toBe(MacTelnetPacketType.sessionStart);
    expect(header[14]).toBe(0x12);
    expect(header[15]).toBe(0x34);
    expect(header[16]).toBe(MAC_TELNET_CLIENT_TYPE[0]);
    expect(header[17]).toBe(MAC_TELNET_CLIENT_TYPE[1]);
  });

  test("a client-encoded header round-trips with the matching direction", () => {
    const header = encodeHeader({
      type: MacTelnetPacketType.data,
      sourceMac: src,
      destinationMac: dst,
      sessionKey: 0xbeef,
      counter: 4096,
      fromServer: false,
    });
    const decoded = decodeHeader(header, { fromServer: false });
    expect(decoded.version).toBe(1);
    expect(decoded.type).toBe(MacTelnetPacketType.data);
    expect([...decoded.sourceMac]).toEqual([...src]);
    expect([...decoded.destinationMac]).toEqual([...dst]);
    expect(decoded.sessionKey).toBe(0xbeef);
    expect(decoded.counter).toBe(4096);
  });

  test("buildPacket concatenates header + payload", () => {
    const payload = Uint8Array.of(1, 2, 3);
    const packet = buildPacket({
      type: MacTelnetPacketType.data,
      sourceMac: src,
      destinationMac: dst,
      sessionKey: 1,
      counter: 0,
      payload,
    });
    expect(packet.length).toBe(MAC_TELNET_HEADER_LEN + 3);
    expect([...packet.subarray(MAC_TELNET_HEADER_LEN)]).toEqual([1, 2, 3]);
  });
});

describe("control blocks", () => {
  test("encode then parse round-trips with the magic and length", () => {
    const value = new TextEncoder().encode("ali");
    const block = encodeControlBlock(MacTelnetControlType.username, value);
    expect([...block.subarray(0, 4)]).toEqual([...MAC_TELNET_CONTROL_MAGIC]);
    expect(block[4]).toBe(MacTelnetControlType.username);
    const parsed = parseControlBlocks(block);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].type).toBe(MacTelnetControlType.username);
    expect(new TextDecoder().decode(parsed[0].value)).toBe("ali");
  });

  test("bytes without the magic parse as a single plaindata block", () => {
    const term = new TextEncoder().encode("hello prompt");
    const parsed = parseControlBlocks(term);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].type).toBe("plaindata");
    expect(new TextDecoder().decode(parsed[0].value)).toBe("hello prompt");
  });

  test("a control block followed by plaindata parses into two blocks", () => {
    const endAuth = encodeControlBlock(MacTelnetControlType.endAuth);
    const term = new TextEncoder().encode("[ali@MikroTik] > ");
    const combined = new Uint8Array(endAuth.length + term.length);
    combined.set(endAuth, 0);
    combined.set(term, endAuth.length);
    const parsed = parseControlBlocks(combined);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].type).toBe(MacTelnetControlType.endAuth);
    expect(parsed[1].type).toBe("plaindata");
  });

  test("terminal dimension is little-endian uint16", () => {
    expect([...encodeTerminalDimension(512)]).toEqual([0x00, 0x02]);
  });
});

describe("classic MD5 auth", () => {
  test("password value is 0x00 then MD5 digest, 17 bytes", () => {
    const salt = new Uint8Array(16).fill(0xab);
    const value = macTelnetPasswordHash("secret", salt);
    expect(value.length).toBe(17);
    expect(value[0]).toBe(0x00);
  });
});

describe("MTWEI / EC-SRP5", () => {
  test("keygen produces a 33-byte public key on the curve", () => {
    const seed = new Uint8Array(32).fill(7);
    const { publicKey } = mtweiKeygen(seed);
    expect(publicKey.length).toBe(MTWEI_PUBKEY_LEN);
    expect(isOnCurve(decodePoint(publicKey))).toBe(true);
  });

  test("keygen is deterministic for a fixed seed", () => {
    const seed = new Uint8Array(32).fill(9);
    expect([...mtweiKeygen(seed).publicKey]).toEqual([...mtweiKeygen(seed).publicKey]);
  });

  test("encodePoint then decodePoint round-trip a scalar multiple of G", () => {
    const point = scalarMul(123456789n, mtweiCurve.G);
    const decoded = decodePoint(encodePoint(point));
    expect(decoded).not.toBeNull();
    expect(decoded?.x).toBe(point?.x);
    expect(decoded?.y).toBe(point?.y);
  });

  test("the identity validator is 32 bytes", () => {
    const salt = new Uint8Array(16).fill(0x10);
    const id = mtweiId("ali", "@ali4286@", salt);
    expect(id.length).toBe(32);
  });

  test("the client proof is a deterministic 32-byte value", () => {
    const client = mtweiKeygen(new Uint8Array(32).fill(3));
    const server = mtweiKeygen(new Uint8Array(32).fill(5));
    const salt = new Uint8Array(16).fill(0x22);
    const validator = mtweiId("ali", "@ali4286@", salt);
    const proofA = mtweiDocrypto(client.privateKey, server.publicKey, client.publicKey, validator);
    const proofB = mtweiDocrypto(client.privateKey, server.publicKey, client.publicKey, validator);
    expect(proofA.length).toBe(MTWEI_VALIDATOR_LEN);
    expect([...proofA]).toEqual([...proofB]);
  });

  test("the MTWEI offer value is username then 0x00 then pubkey", () => {
    const { publicKey } = mtweiKeygen(new Uint8Array(32).fill(1));
    const offer = mtweiOfferValue("ali", publicKey);
    expect(offer.length).toBe(3 + 1 + MTWEI_PUBKEY_LEN);
    expect(new TextDecoder().decode(offer.subarray(0, 3))).toBe("ali");
    expect(offer[3]).toBe(0x00);
  });
});

describe("console screen emulation", () => {
  test("CR redraws collapse to the final overwritten line", () => {
    expect(emulateScreen("partial\rfinal  ")[0]).toBe("final");
  });

  test("extractCommandOutput strips the echoed command and trailing prompt", () => {
    const raw = [
      "[ali@MikroTik] > /system identity print",
      "  name: MikroTik",
      "[ali@MikroTik] > ",
    ].join("\r\n");
    expect(extractCommandOutput(raw, "/system identity print")).toBe("  name: MikroTik");
  });

  test("a silent write yields empty output", () => {
    const raw = ["[ali@MikroTik] > /ip address add address=1.1.1.1/24", "[ali@MikroTik] > "].join(
      "\r\n",
    );
    expect(extractCommandOutput(raw, "/ip address add address=1.1.1.1/24")).toBe("");
  });

  test("trailing command newlines cannot consume the first output line", () => {
    const command = ':put "ok"';
    const raw = `[ali@MikroTik] > ${command}\r\nok\r\nsecond line\r\n[ali@MikroTik] > `;
    for (const suffix of ["\n", "\r\n", "\n\n"]) {
      expect(extractCommandOutput(raw, command + suffix)).toBe("ok\nsecond line");
    }
  });
});
