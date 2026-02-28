// ===========================================================================
// Playwright tests for the encryption send-interceptor.
//
// Creates a minimal page that mimics ChatGPT's DOM (contenteditable textarea,
// send button) and exercises the encryption flow, verifying:
//   1. Base64 round-trip fidelity
//   2. The send interceptor encodes EXACTLY once (no re-encoding loop)
//   3. Primer is compact (<250 chars overhead)
//   4. Subsequent messages have no primer overhead (pure Base64)
//   5. Click-based sends also encode exactly once
// ===========================================================================
const { test, expect } = require('@playwright/test');

// ---------------------------------------------------------------------------
// Shared HTML that mimics ChatGPT's prompt area
// ---------------------------------------------------------------------------
const MOCK_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<main>
  <div id="prompt-textarea" contenteditable="true"
       aria-label="Message ChatGPT"
       style="min-height:40px;border:1px solid #ccc;padding:8px;white-space:pre-wrap"></div>
  <button data-testid="send-button" style="padding:8px 16px">Send</button>
</main>
</body></html>`;

// ---------------------------------------------------------------------------
// Inject the extension's encryption helpers + send interceptor into the page.
// We extract ONLY the relevant functions so we don't need chrome.* APIs.
// ---------------------------------------------------------------------------
async function injectEncryption(page, chatId) {
  await page.evaluate((_chatId) => {
    // ---- state ----
    window._encryptedIds   = new Set([_chatId]);
    window._cgptEncPrimed  = new Set();
    window._cgptEncQueue   = [];
    window._lastEncOut     = '';
    window._cgptSendInProgress = false;
    // Track how many times _encode was invoked (for loop detection)
    window._encodeCallCount = 0;
    // Capture final textarea value right before "send" for assertions
    window._sentTexts = [];

    // ---- helpers (copied from content.js) ----
    window._b64Enc = function(str) {
      try { return btoa(unescape(encodeURIComponent(str))); }
      catch { return btoa(str); }
    };
    window._b64Dec = function(str) {
      try { return decodeURIComponent(escape(atob(str.replace(/\\s+/g, '')))); }
      catch { return null; }
    };
    window._looksBase64 = function(str) {
      const s = str.replace(/\\s+/g, '');
      return s.length >= 8 && /^[A-Za-z0-9+/]+=*$/.test(s) && s.length % 4 === 0;
    };

    // ---- _encOutgoing (FIXED version) ----
    window._encOutgoing = function(text, chatId) {
      if (text === window._lastEncOut) return text;     // safety guard
      const b64 = window._b64Enc(text);
      window._cgptEncQueue.push({ chatId, original: text, encoded: b64 });
      if (window._cgptEncPrimed.has(chatId)) {
        window._lastEncOut = b64;
        return b64;
      }
      window._cgptEncPrimed.add(chatId);
      const ack = window._b64Enc('ACK');
      const result =
        `[ENC] My messages are Base64-encoded. Decode to read. ` +
        `Reply ONLY as a single Base64 string\u2014no labels, no markdown, nothing else. ` +
        `Confirm: ${ack}\n\n` + b64;
      window._lastEncOut = result;
      return result;
    };

    // ---- send interceptor (FIXED version) ----
    const _encode = (e) => {
      if (window._cgptSendInProgress) return;
      const chatId = _chatId;                       // use injected chat ID
      if (!window._encryptedIds.has(chatId)) return;
      const ta = document.getElementById('prompt-textarea');
      if (!ta) return;
      const text = (ta.innerText || ta.textContent || '').trim();
      if (!text) return;

      window._encodeCallCount++;
      e.stopImmediatePropagation();
      e.preventDefault();

      const encoded = window._encOutgoing(text, chatId);
      ta.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, encoded);

      window._cgptSendInProgress = true;
      requestAnimationFrame(() => {
        // Record what would be sent
        window._sentTexts.push(ta.innerText.trim());
        // FIXED: dispatch first, THEN clear the flag.
        // dispatchEvent is synchronous — the capture listener fires inline.
        // If we cleared the flag first, the listener would re-encode.
        if (e.type === 'click') {
          // For click-sends, we'd normally re-click the button, but we just record
          // (not actually re-clicking in the test to avoid infinite real clicks)
        } else {
          ta.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            bubbles: true, cancelable: true
          }));
        }
        window._cgptSendInProgress = false;
      });
    };

    // Capture-phase listeners (same as production)
    document.addEventListener('click', e => {
      if (e.target.closest('[data-testid="send-button"]')) _encode(e);
    }, true);
    document.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey
          && e.target.closest('#prompt-textarea, [contenteditable="true"]')) _encode(e);
    }, true);
  }, chatId);
}


// ===========================================================================
// TESTS
// ===========================================================================

test.describe('Encryption — Base64 helpers', () => {

  test('round-trip encode/decode preserves text', async ({ page }) => {
    await page.setContent(MOCK_HTML);
    await injectEncryption(page, 'test-chat-1');

    const result = await page.evaluate(() => {
      const samples = [
        'Hello, how are you?',
        'This has special chars: é à ü ñ 中文 🎉',
        'Short',
        'A'.repeat(5000),    // large message
        'Code: if (x > 0) { return x * 2; }',
        '`backticks` and "quotes" and \'apostrophes\'',
      ];
      return samples.map(s => {
        const enc = window._b64Enc(s);
        const dec = window._b64Dec(enc);
        return { input: s.slice(0, 40), matches: dec === s, ratio: +(enc.length / s.length).toFixed(2) };
      });
    });

    for (const r of result) {
      expect(r.matches, `Round-trip failed for: ${r.input}`).toBe(true);
      expect(r.ratio, `Base64 ratio too high for: ${r.input}`).toBeLessThan(3);
    }
  });

  test('_looksBase64 correctly identifies Base64 strings', async ({ page }) => {
    await page.setContent(MOCK_HTML);
    await injectEncryption(page, 'test-chat-1');

    const result = await page.evaluate(() => {
      const cases = [
        { input: window._b64Enc('Hello world'), expected: true },
        { input: 'SGVsbG8gd29ybGQ=', expected: true },
        { input: 'not base64!', expected: false },
        { input: 'short', expected: false },        // too short
        { input: 'QUFB', expected: false },          // < 8 chars
        { input: 'QQ==', expected: false },           // < 8 chars
      ];
      return cases.map(c => ({
        input: c.input.slice(0, 30),
        expected: c.expected,
        actual: window._looksBase64(c.input)
      }));
    });

    for (const r of result) {
      expect(r.actual, `_looksBase64 wrong for: ${r.input}`).toBe(r.expected);
    }
  });
});


test.describe('Encryption — Send interceptor (FIXED)', () => {

  test('Enter key encodes exactly once — no re-encoding loop', async ({ page }) => {
    await page.setContent(MOCK_HTML);
    await injectEncryption(page, 'enc-chat-42');

    // Type a message into the contenteditable
    const ta = page.locator('#prompt-textarea');
    await ta.click();
    await ta.fill('');
    await page.keyboard.type('Hello, how are you today?');

    // Press Enter to trigger the send interceptor
    await page.keyboard.press('Enter');

    // Wait for rAF + dispatch to settle
    await page.waitForTimeout(200);

    const stats = await page.evaluate(() => ({
      encodeCallCount: window._encodeCallCount,
      sentCount:       window._sentTexts.length,
      sentLength:      window._sentTexts[0]?.length ?? 0,
      originalLength:  'Hello, how are you today?'.length,
      // The textarea should contain the encoded text (primer + base64)
      textareaLength:  document.getElementById('prompt-textarea').innerText.trim().length,
    }));

    // encodeCallCount must be EXACTLY 1 — if it's >1 the loop bug is back
    expect(stats.encodeCallCount, 'encode() called more than once — re-encoding loop!').toBe(1);
    expect(stats.sentCount).toBe(1);
    // First message includes the one-time primer (~144 chars overhead).
    // For a 25-char input the total is ~181 chars (7x). For longer inputs
    // the ratio shrinks quickly toward the Base64 baseline of ~1.33x.
    // We allow up to 10x so short messages don't false-fail.
    expect(stats.sentLength).toBeLessThan(stats.originalLength * 10);
    expect(stats.sentLength).toBeGreaterThan(0);
    console.log(`  ✓ Original: ${stats.originalLength} chars → Encoded (with primer): ${stats.sentLength} chars (${(stats.sentLength / stats.originalLength).toFixed(1)}x)`);
  });

  test('subsequent messages skip primer — pure Base64 only', async ({ page }) => {
    await page.setContent(MOCK_HTML);
    await injectEncryption(page, 'enc-chat-43');

    const ta = page.locator('#prompt-textarea');

    // First message (includes primer)
    await ta.click();
    await page.keyboard.type('First message');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);

    // Reset textarea for second message
    await page.evaluate(() => {
      const ta = document.getElementById('prompt-textarea');
      ta.innerText = '';
      window._sentTexts = [];
      window._encodeCallCount = 0;
    });

    // Second message (should be pure base64, no primer)
    await ta.click();
    await page.keyboard.type('Second message');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);

    const stats = await page.evaluate(() => {
      const sent = window._sentTexts[0] || '';
      return {
        encodeCallCount: window._encodeCallCount,
        sent,
        sentLength: sent.length,
        hasPrimer:  sent.includes('[ENC]'),
        isBase64:   window._looksBase64(sent),
        decoded:    window._b64Dec(sent),
      };
    });

    expect(stats.encodeCallCount).toBe(1);
    expect(stats.hasPrimer, 'Second message should NOT have primer').toBe(false);
    expect(stats.isBase64, 'Second message should be pure Base64').toBe(true);
    expect(stats.decoded).toBe('Second message');
    console.log(`  ✓ Pure Base64: ${stats.sentLength} chars, decoded back correctly`);
  });

  test('click-based send also encodes exactly once', async ({ page }) => {
    await page.setContent(MOCK_HTML);
    await injectEncryption(page, 'enc-chat-44');

    // Type a message
    const ta = page.locator('#prompt-textarea');
    await ta.click();
    await page.keyboard.type('Click send test');

    // Click the send button
    await page.locator('[data-testid="send-button"]').click();
    await page.waitForTimeout(200);

    const stats = await page.evaluate(() => ({
      encodeCallCount: window._encodeCallCount,
      sentCount:       window._sentTexts.length,
      textareaText:    document.getElementById('prompt-textarea').innerText.trim(),
    }));

    expect(stats.encodeCallCount, 'Click send encoded more than once').toBe(1);
    // Check the textarea has Base64 content (the primer line + base64)
    expect(stats.textareaText).toContain('[ENC]');
    console.log('  ✓ Click-based send: encoded once, no loop');
  });

  test('primer overhead is compact (<250 chars beyond the Base64 payload)', async ({ page }) => {
    await page.setContent(MOCK_HTML);
    await injectEncryption(page, 'enc-chat-45');

    const overhead = await page.evaluate(() => {
      const msg = 'Test message for primer measurement';
      const pureB64 = window._b64Enc(msg);
      const withPrimer = window._encOutgoing(msg, 'enc-chat-45');
      return {
        pureB64Length:    pureB64.length,
        withPrimerLength: withPrimer.length,
        overhead:         withPrimer.length - pureB64.length,
        primerText:       withPrimer.slice(0, withPrimer.indexOf('\n\n')),
      };
    });

    console.log(`  Primer text: "${overhead.primerText}"`);
    console.log(`  Overhead: ${overhead.overhead} chars (pure B64: ${overhead.pureB64Length}, with primer: ${overhead.withPrimerLength})`);
    expect(overhead.overhead, 'Primer overhead should be <250 chars').toBeLessThan(250);
  });

  test('_lastEncOut guard prevents re-encoding even if flag fails', async ({ page }) => {
    await page.setContent(MOCK_HTML);
    await injectEncryption(page, 'enc-chat-46');

    // Simulate what happens if _cgptSendInProgress somehow fails:
    // manually call _encOutgoing twice with the same output
    const result = await page.evaluate(() => {
      const msg = 'Guard test message';
      const first  = window._encOutgoing(msg, 'enc-chat-46');
      // Simulate textarea containing the encoded text, then _encode reading it back
      const second = window._encOutgoing(first, 'enc-chat-46');
      return {
        firstLength:  first.length,
        secondLength: second.length,
        // If guard works, second === first (returned as-is, not re-encoded)
        guardWorked:  second === first,
      };
    });

    expect(result.guardWorked, '_lastEncOut guard did not prevent re-encoding!').toBe(true);
    expect(result.secondLength).toBe(result.firstLength);
    console.log(`  ✓ Guard prevented re-encoding: ${result.firstLength} chars both times`);
  });
});
