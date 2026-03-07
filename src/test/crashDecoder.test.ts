/**
 * Unit tests for ESP32-C6 crash detection and decoding.
 *
 * Fixtures:
 *   esp32c6_assert.txt  – real serial output captured from an ESP32-C6
 *                         that crashed with "assert failed: npl_freertos_event_init"
 *   firmware.elf        – the matching firmware ELF with debug symbols
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Mock vscode before importing any module that depends on it
// ---------------------------------------------------------------------------
vi.mock('vscode', () => {
  class EventEmitter<T> {
    private _listeners: ((e: T) => void)[] = [];

    get event() {
      return (listener: (e: T) => void) => {
        this._listeners.push(listener);
        return {
          dispose: () => {
            this._listeners = this._listeners.filter((l) => l !== listener);
          },
        };
      };
    }

    fire(e: T) {
      this._listeners.forEach((l) => l(e));
    }

    dispose() {
      this._listeners = [];
    }
  }

  return { EventEmitter };
});

// ---------------------------------------------------------------------------
// Import under test (after vscode mock is in place)
// ---------------------------------------------------------------------------
import { TrbrCrashCapturer, decodeCrash } from '../crashDecoder.js';
import type { CrashEvent } from '../crashDecoder.js';

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------
const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');
const ELF_PATH = path.join(FIXTURES_DIR, 'firmware.elf');
const CRASH_TEXT_PATH = path.join(FIXTURES_DIR, 'esp32c6_assert.txt');

const CRASH_TEXT = fs.readFileSync(CRASH_TEXT_PATH, 'utf8');

// Resolved from PlatformIO packages on this machine
const GDB_PATH = '/Users/claudia/.platformio/packages/tool-riscv32-esp-elf-gdb/bin/riscv32-esp-elf-gdb';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Feed text into the capturer line-by-line and flush.
 * Returns the first detected CrashEvent (or undefined if none).
 */
function feedCrashText(capturer: TrbrCrashCapturer, text: string): CrashEvent | undefined {
  let detected: CrashEvent | undefined;
  capturer.onCrashDetected((e) => {
    if (!detected) { detected = e; }
  });
  capturer.pushData(Buffer.from(text, 'utf8'));
  capturer.flush();
  return detected;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TrbrCrashCapturer – ESP32-C6 assert failure', () => {
  let capturer: TrbrCrashCapturer;

  beforeEach(() => {
    capturer = new TrbrCrashCapturer();
  });

  it('detects the crash via the fallback detector', () => {
    const event = feedCrashText(capturer, CRASH_TEXT);
    expect(event).toBeDefined();
  });

  it('classifies the crash as riscv', () => {
    const event = feedCrashText(capturer, CRASH_TEXT);
    expect(event?.kind).toBe('riscv');
  });

  it('includes the assert message in the raw text', () => {
    const event = feedCrashText(capturer, CRASH_TEXT);
    expect(event?.rawText).toContain('assert failed: npl_freertos_event_init');
  });

  it('includes the register dump in the raw text', () => {
    const event = feedCrashText(capturer, CRASH_TEXT);
    expect(event?.rawText).toContain('Core  0 register dump:');
    expect(event?.rawText).toContain('MEPC');
    expect(event?.rawText).toContain('Stack memory:');
  });

  it('captures MEPC value 0x4080c1aa', () => {
    const event = feedCrashText(capturer, CRASH_TEXT);
    expect(event?.rawText).toContain('0x4080c1aa');
  });
});

describe('decodeCrash – ESP32-C6 with real ELF', () => {
  // Build a CrashEvent from the captured crash text
  function makeCrashEvent(): CrashEvent {
    const lines = CRASH_TEXT.split('\n').filter((l) => l.trim().length > 0);
    return {
      id: 'test-esp32c6-001',
      kind: 'riscv',
      lines,
      rawText: CRASH_TEXT,
      timestamp: Date.now(),
    };
  }

  it.skipIf(!fs.existsSync(ELF_PATH) || !fs.existsSync(GDB_PATH))(
    'decodes the crash and reports fault information',
    async () => {
      const event = makeCrashEvent();
      const decoded = await decodeCrash(event, ELF_PATH, GDB_PATH, 'esp32c6');

      // Fault info must be present
      expect(decoded.faultInfo).toBeDefined();

      // MCAUSE 0x02 = Illegal instruction
      expect(decoded.faultInfo?.faultMessage).toMatch(/illegal instruction/i);
    }
  );

  it.skipIf(!fs.existsSync(ELF_PATH) || !fs.existsSync(GDB_PATH))(
    'resolves panic_abort in the stack trace or MEPC annotation',
    async () => {
      const event = makeCrashEvent();
      const decoded = await decodeCrash(event, ELF_PATH, GDB_PATH, 'esp32c6');

      // MEPC (0x4080c1aa) resolves to panic_abort in esp_system/panic.c
      const hasPanicAbort =
        decoded.stacktrace.some((f) => f.function?.includes('panic_abort')) ||
        Object.values(decoded.regAnnotations ?? {}).some((a) => a.includes('panic_abort'));

      expect(hasPanicAbort).toBe(true);
    }
  );

  it.skipIf(!fs.existsSync(ELF_PATH) || !fs.existsSync(GDB_PATH))(
    'resolves __assert_func from the stack memory or stack trace',
    async () => {
      const event = makeCrashEvent();
      const decoded = await decodeCrash(event, ELF_PATH, GDB_PATH, 'esp32c6');

      // Address 0x4081107c in the stack resolves to __assert_func (assert.c:80).
      // It appears either in the resolved stacktrace or in the raw output.
      const hasFuncInTrace = decoded.stacktrace.some(
        (f) => f.function?.includes('assert') || f.function?.includes('abort')
      );
      const hasFuncInRaw =
        decoded.rawOutput.includes('assert') || decoded.rawOutput.includes('abort');

      expect(hasFuncInTrace || hasFuncInRaw).toBe(true);
    }
  );

  it.skipIf(!fs.existsSync(ELF_PATH) || !fs.existsSync(GDB_PATH))(
    'raw decode fallback extracts MEPC register',
    async () => {
      const event = makeCrashEvent();
      // Use undefined toolPath to force raw decode (no GDB)
      const decoded = await decodeCrash(event, ELF_PATH, undefined, 'esp32c6');

      expect(decoded.regs).toBeDefined();
      // MEPC = 0x4080c1aa
      const mepc = decoded.regs?.['MEPC'] ?? decoded.regs?.['mepc'];
      expect(mepc).toBe(0x4080c1aa);
    }
  );
});
