---
name: Network Resilience for Slow/Unstable Connections
about: Improve download reliability on mobile and poor-connection environments
title: "Improve download resilience for slow networks (slow network, timeout, buffer management)"
labels: enhancement, network, mobile
---

## Problem Statement

Downloads frequently fail on mobile devices and networks with poor connectivity (high latency, unstable connections). The current streaming pipeline lacks:

1. **No timeout handling** - `fetch()` can hang indefinitely
2. **No retry mechanism** - Single failure requires starting over
3. **Unbounded buffer growth** - Buffer can accumulate indefinitely on slow networks
4. **No backpressure monitoring** - Doesn't detect or respond to downstream congestion

## Current Implementation Issues

### Issue 1: Missing Fetch Timeout (download-transform.worker.ts:156)
```typescript
const res = await fetch(request.url, { headers: request.authHeaders });
// ⚠️ No timeout! Can hang on unstable networks
```

**Impact**: Mobile users on 3G/poor WiFi experience indefinite hangs.

### Issue 2: No Retry Mechanism
- No exponential backoff on transient errors (5xx, 408)
- User must restart entire download after any network hiccup

**Impact**: One network blip = restart from 0%, frustrating on large files.

### Issue 3: Unbounded Buffer in AES-CTR Decrypt (encryption.ts:186-236)

The `createAesCtrDecryptTransform()` accumulates data in a buffer that:
- Grows until 16-byte alignment is reached
- Has no maximum size limit
- Can exhaust memory on slow networks (buffer waits for data, network is slow)

```typescript
let buffer = new Uint8Array(0);
let bytesProcessed = 0;

return new TransformStream<Uint8Array, Uint8Array>({
  async transform(chunk, controller) {
    // ⚠️ Buffer keeps growing with incoming chunks
    const next = new Uint8Array(buffer.length + chunk.length);
    next.set(buffer);
    next.set(chunk, buffer.length);
    buffer = next;  // No size limit check!
    
    const alignedLength = buffer.length - (buffer.length % 16);
    if (alignedLength > 0) {
      // Process 16-byte aligned blocks
      // Remaining bytes stay in buffer indefinitely
    }
  }
});
```

**Why this matters**:
- AES-CTR requires 16-byte aligned blocks for `crypto.subtle.encrypt/decrypt()`
- Unaligned bytes are held in buffer awaiting next chunk
- On slow networks: buffer accumulates faster than it can be processed
- Example: 1 byte/second network → buffer grows by 1B/sec

**Impact**: OOM errors on low-RAM devices (especially mobile).

### Issue 4: No Backpressure Monitoring
- Buffer doesn't check if downstream (writable stream) is ready
- Can cause data loss or buffering on slow I/O

**Impact**: Race conditions on slow storage (OPFS on older mobile browsers).

## Proposed Solution

### 1. Add Fetch Timeout & Retry with Exponential Backoff
```typescript
async function fetchWithRetry(
  url: string,
  headers: Record<string, string>,
  maxRetries = 3,
  timeoutMs = 30000
): Promise<Response> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(url, { 
          headers, 
          signal: controller.signal 
        });
        clearTimeout(timeoutId);

        if (res.ok) return res;
        
        // Retry on server errors
        if (res.status >= 500 || res.status === 408 || res.status === 429) {
          const delay = Math.pow(2, i) * 1000; // exponential backoff
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        
        throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        clearTimeout(timeoutId);
        throw err;
      }
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      const delay = Math.pow(2, i) * 1000;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Fetch failed after retries');
}
```

**Where to apply**: `download-transform.worker.ts` line 156

### 2. Add Buffer Size Limit to AES-CTR Decrypt
```typescript
export function createAesCtrDecryptTransform(
  key: CryptoKey,
  maxBufferBytes = 1024 * 1024  // 1MB default
): TransformStream<Uint8Array, Uint8Array> {
  let iv: Uint8Array | null = null;
  let buffer = new Uint8Array(0);
  let bytesProcessed = 0;
  let bufferWarningCount = 0;

  return new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      // ... IV extraction logic ...

      const next = new Uint8Array(buffer.length + chunk.length);
      next.set(buffer);
      next.set(chunk, buffer.length);
      buffer = next;

      // ⚠️ NEW: Monitor buffer size
      if (buffer.length > maxBufferBytes) {
        bufferWarningCount++;
        if (bufferWarningCount > 3) {
          controller.error(
            new Error(
              `AES-CTR buffer exceeded ${maxBufferBytes} bytes (${buffer.length}). ` +
              `Network too slow or server not sending data. Try again.`
            )
          );
          return;
        }
        console.warn(
          `[AES-CTR] Buffer size warning: ${buffer.length} / ${maxBufferBytes} bytes. ` +
          `Network may be congested.`
        );
      }

      // Process aligned blocks as before
      const alignedLength = buffer.length - (buffer.length % 16);
      if (alignedLength > 0 && iv) {
        const counter = computeCounter(iv, bytesProcessed);
        const decrypted = await crypto.subtle.decrypt(
          { name: 'AES-CTR', counter, length: AES_CTR_COUNTER_BITS },
          key,
          buffer.slice(0, alignedLength),
        );
        controller.enqueue(new Uint8Array(decrypted));
        buffer = buffer.slice(alignedLength);
        bytesProcessed += alignedLength;
        bufferWarningCount = Math.max(0, bufferWarningCount - 1); // Reset on progress
      }
    },
    async flush(controller) {
      if (buffer.length > 0 && iv) {
        const counter = computeCounter(iv, bytesProcessed);
        const decrypted = await crypto.subtle.decrypt(
          { name: 'AES-CTR', counter, length: AES_CTR_COUNTER_BITS },
          key,
          buffer,
        );
        controller.enqueue(new Uint8Array(decrypted));
      }
    },
  });
}
```

**Where to apply**: `encryption.ts` line 186

### 3. Update `writeDownload()` to Use Retry Logic
```typescript
// In download-transform.worker.ts, replace line 156:
const res = await fetchWithRetry(request.url, request.authHeaders);
```

### 4. Update Progress Reporting
- Add buffer size to progress updates
- Warn user if buffer is growing (network too slow)

```typescript
export type DownloadTransformProgress = {
  phase: 'reading' | 'writing' | 'done';
  processedFiles: number;
  totalFiles: number;
  currentFile: string;
  completedBytes?: number;
  totalBytes?: number;
  bufferBytes?: number;  // NEW: for diagnosis
  networkStalled?: boolean;  // NEW: for user warnings
};
```

## Testing Requirements

1. **Slow network simulation**
   - Use Chrome DevTools throttling (Slow 4G)
   - Test with files > 100MB

2. **Connection interruption**
   - Drop connection mid-download
   - Verify retry triggers and eventually succeeds

3. **Mobile testing**
   - Test on actual mobile devices with poor WiFi
   - Monitor memory usage (DevTools → Memory)
   - Verify no OOM on 1GB+ files

4. **Buffer monitoring**
   - Log buffer size at each chunk
   - Verify max buffer never exceeds limit
   - Check backpressure doesn't cause data loss

## Files to Modify

- [ ] `packages/app/src/shared/encryption.ts` - Add buffer size limit to `createAesCtrDecryptTransform()`
- [ ] `packages/app/src/client/workers/download-transform.worker.ts` - Add `fetchWithRetry()`, use in `writeDownload()`, update progress type
- [ ] Tests - Add slow network and retry scenarios

## Priority

**High** - Affects user experience on mobile, prevents data loss from timeouts

## Labels

`enhancement`, `network`, `mobile`, `performance`, `bug-potential`
