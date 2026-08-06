/**
 * The byte cursor, against the reference's own edge cases — the ones
 * `proof_trace_memory_buffer` spells out and a naive reader gets wrong.
 */

import { describe, expect, test } from "bun:test";

import { ByteCursor } from "../src/cursor.ts";
import { ProofTraceError } from "../src/errors.ts";
import { ByteWriter } from "./encode.ts";

describe("ByteCursor", () => {
  test("reads little-endian, as the format assumes throughout", () => {
    const cursor = new ByteCursor(new ByteWriter().u32(1).u64(0x0102030405).build());
    expect(cursor.readUint32()).toBe(1);
    expect(cursor.readUint64()).toBe(0x0102030405);
    expect(cursor.eof()).toBe(true);
  });

  test("hasWord is eight bytes, not 'any bytes'", () => {
    const cursor = new ByteCursor(new Uint8Array(8));
    expect(cursor.hasWord()).toBe(true);
    cursor.readByte();
    // Seven left: `has_word()` is false but `eof()` is also false, and the
    // reference's two loops branch differently on exactly this state.
    expect(cursor.hasWord()).toBe(false);
    expect(cursor.eof()).toBe(false);
  });

  test("peekSentinel answers only when all eight bytes agree", () => {
    expect(new ByteCursor(new ByteWriter().word(0xaa).build()).peekSentinel()).toBe(0xaa);
    expect(new ByteCursor(new ByteWriter().word(0x00).build()).peekSentinel()).toBe(0x00);
    // Seven 0xff and one 0xfe is *not* the config sentinel, and reading it as
    // one would swallow a term.
    const almost = new ByteWriter().word(0xff).build();
    almost[7] = 0xfe;
    expect(new ByteCursor(almost).peekSentinel()).toBeUndefined();
    expect(new ByteCursor(new Uint8Array(7).fill(0xff)).peekSentinel()).toBeUndefined();
  });

  test("peekSentinel does not consume, expectSentinel does", () => {
    const cursor = new ByteCursor(new ByteWriter().word(0x22).word(0x33).build());
    expect(cursor.peekSentinel()).toBe(0x22);
    expect(cursor.offset).toBe(0);
    cursor.expectSentinel(0x22, "rule");
    expect(cursor.offset).toBe(8);
    expect(() => cursor.expectSentinel(0x22, "rule")).toThrow(ProofTraceError);
    // A failed check leaves the cursor where it was, so the error's offset is
    // the field's own.
    expect(cursor.offset).toBe(8);
  });

  test("a NUL-terminated string stops at the NUL and consumes it", () => {
    const cursor = new ByteCursor(new ByteWriter().cstring("INT.add").cstring("").u8(9).build());
    expect(cursor.readCString()).toBe("INT.add");
    // An empty location string is one byte, and the format uses it constantly.
    expect(cursor.readCString()).toBe("");
    expect(cursor.readByte()).toBe(9);
  });

  test("an unterminated string fails rather than returning a prefix", () => {
    // `read_string` returns false when `len == end_ - ptr_`
    // (`deserializer.h:127-130`); silently returning "abc" would turn a
    // truncated file into a plausible-looking trace.
    const cursor = new ByteCursor(new ByteWriter().raw("abc").build());
    expect(() => cursor.readCString()).toThrow(/Unterminated string \(at byte 0\)/);
  });

  test("strings are latin-1, so every byte round-trips", () => {
    const cursor = new ByteCursor(new ByteWriter().u8(0xff).u8(0x80).u8(0x41).build());
    expect(cursor.readFixedString(3)).toBe("ÿA");
  });

  test("a uint64 past the safe integer range is corruption, not a number", () => {
    const cursor = new ByteCursor(new ByteWriter().bytes([0, 0, 0, 0, 0, 0, 0, 0x80]).build());
    expect(() => cursor.readUint64()).toThrow(/out of range/);
  });

  test("every truncation names the field and the offset", () => {
    const cursor = new ByteCursor(new ByteWriter().u8(1).u8(2).build());
    expect(() => cursor.readUint32()).toThrow(/reading uint32 \(at byte 0\)/);
    cursor.readByte();
    cursor.readByte();
    expect(() => cursor.readByte()).toThrow(/Unexpected end of input \(at byte 2\)/);
  });

  test("startsWith probes without consuming, which is how three magics are tried", () => {
    const cursor = new ByteCursor(new ByteWriter().raw("PTRC").build());
    expect(cursor.startsWith([0x48, 0x49, 0x4e, 0x54])).toBe(false);
    expect(cursor.startsWith([0x50, 0x54, 0x52, 0x43])).toBe(true);
    expect(cursor.offset).toBe(0);
    // A prefix longer than what is left is a clean `false`, not a throw.
    expect(cursor.startsWith([0x50, 0x54, 0x52, 0x43, 0x00])).toBe(false);
  });

  test("readBool is 'any non-zero byte', as read_bool's implicit conversion is", () => {
    const cursor = new ByteCursor(new ByteWriter().u8(0).u8(1).u8(0x7f).build());
    expect(cursor.readBool()).toBe(false);
    expect(cursor.readBool()).toBe(true);
    expect(cursor.readBool()).toBe(true);
  });
});
