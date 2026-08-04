function abortError(signal) {
  if (signal?.reason?.code) return signal.reason;
  return Object.assign(new Error('model request cancelled'), {
    code: 'MODEL_CANCELLED',
  });
}

function raceWithSignal(value, signal) {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) return Promise.reject(abortError(signal));

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      result => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function tooLargeError(code) {
  return Object.assign(new Error('model response body too large'), { code });
}

async function readLimitedBody(response, maxBytes, {
  signal,
  tooLargeCode = 'MODEL_RESPONSE_ENVELOPE_TOO_LARGE',
} = {}) {
  const reader = response?.body?.getReader?.();
  if (reader) {
    const chunks = [];
    let totalBytes = 0;
    const cancelReader = () => {
      Promise.resolve(reader.cancel()).catch(() => undefined);
    };
    signal?.addEventListener('abort', cancelReader, { once: true });

    try {
      while (true) {
        const { done, value } = await raceWithSignal(reader.read(), signal);
        if (done) break;
        const chunk = Buffer.from(value);
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          await Promise.resolve(reader.cancel()).catch(() => undefined);
          throw tooLargeError(tooLargeCode);
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, totalBytes).toString('utf8');
    } finally {
      signal?.removeEventListener('abort', cancelReader);
      try { reader.releaseLock?.(); } catch { /* already released by cancel */ }
    }
  }

  if (typeof response?.text === 'function') {
    const text = await raceWithSignal(response.text(), signal);
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw tooLargeError(tooLargeCode);
    }
    return text;
  }

  if (typeof response?.json === 'function') {
    const payload = await raceWithSignal(response.json(), signal);
    // ponytail: re-serializing response.json() output may differ from the raw HTTP
    // body (property order, number precision, whitespace). Acceptable because this
    // path is only used for size-limit enforcement, not content-addressable storage.
    const text = JSON.stringify(payload);
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw tooLargeError(tooLargeCode);
    }
    return text;
  }

  throw Object.assign(new Error('model response body unavailable'), {
    code: 'MODEL_RESPONSE_ENVELOPE_INVALID',
  });
}

module.exports = { abortError, raceWithSignal, readLimitedBody };
