// SPDX-License-Identifier: GPL-3.0-or-later

const MAX_LINE_BYTES = 64 * 1_024;
const STDERR_TAIL_BYTES = 8 * 1_024;
const STDERR_BYTES_PER_MINUTE = 64 * 1_024;

/** Describes a framing or stream-rate boundary violation. */
export class StreamLimitError extends Error {
    constructor(kind, message) {
        super(message);
        this.name = 'StreamLimitError';
        this.kind = kind;
    }
}

/** Continuously refilled monotonic token bucket with fractional tokens. */
export class TokenBucket {
    constructor(capacity, refillPerSecond, nowUs) {
        if (!(capacity > 0) || !(refillPerSecond > 0))
            throw new RangeError('Token bucket bounds must be positive');
        this.capacity = capacity;
        this.refillPerSecond = refillPerSecond;
        this._tokens = capacity;
        this._lastUs = nowUs;
    }

    /** Consumes tokens after monotonic refill and returns whether allowed. */
    consume(count, nowUs) {
        if (count < 0 || nowUs < this._lastUs)
            throw new RangeError('Invalid token bucket consumption');
        const elapsedSeconds = (nowUs - this._lastUs) / 1_000_000;
        this._tokens = Math.min(
            this.capacity,
            this._tokens + elapsedSeconds * this.refillPerSecond);
        this._lastUs = nowUs;
        if (count > this._tokens)
            return false;
        this._tokens -= count;
        return true;
    }
}

/** Incrementally decodes bounded UTF-8 JSON lines and enforces stdout rates. */
export class StreamFramer {
    constructor({maxMessagesPerSecond, maxBytesPerMinute, nowUs}) {
        this._messages = new TokenBucket(
            maxMessagesPerSecond,
            maxMessagesPerSecond,
            nowUs);
        this._bytes = new TokenBucket(
            maxBytesPerMinute,
            maxBytesPerMinute / 60,
            nowUs);
        this._decoder = new IncrementalUtf8Decoder();
        this._pieces = [];
        this._lineBytes = 0;
    }

    /** Accepts one stdout chunk and returns its complete decoded lines. */
    push(chunk, nowUs) {
        if (!(chunk instanceof Uint8Array))
            throw new TypeError('Stream chunks must be Uint8Array values');
        if (!this._bytes.consume(chunk.length, nowUs))
            throw new StreamLimitError('byte-rate', 'Stream exceeded its stdout byte budget');

        const lines = [];
        let start = 0;
        for (let index = 0; index < chunk.length; index++) {
            if (chunk[index] !== 0x0a)
                continue;
            this._append(chunk.subarray(start, index), true);
            this._lineBytes++;
            if (this._lineBytes > MAX_LINE_BYTES)
                throw new StreamLimitError('line-limit', 'Stream line exceeds 64 KiB');
            if (!this._messages.consume(1, nowUs)) {
                throw new StreamLimitError(
                    'message-rate',
                    'Stream exceeded its message-rate budget');
            }
            try {
                this._pieces.push(this._decoder.finish());
            } catch (error) {
                throw new StreamLimitError('utf8', `Stream emitted invalid UTF-8: ${error.message}`);
            }
            lines.push(this._pieces.join(''));
            this._pieces.length = 0;
            this._lineBytes = 0;
            start = index + 1;
        }
        this._append(chunk.subarray(start), false);
        return lines;
    }

    /** Rejects a truncated final line and flushes decoder validation at EOF. */
    finish() {
        if (this._lineBytes !== 0)
            throw new StreamLimitError('partial-line', 'Stream ended with a partial line');
        try {
            this._decoder.finish();
        } catch (error) {
            throw new StreamLimitError('utf8', `Stream emitted invalid UTF-8: ${error.message}`);
        }
    }

    _append(bytes, terminating) {
        if (bytes.length === 0)
            return;
        this._lineBytes += bytes.length;
        if (this._lineBytes + (terminating ? 1 : 0) > MAX_LINE_BYTES)
            throw new StreamLimitError('line-limit', 'Stream line exceeds 64 KiB');
        try {
            const text = this._decoder.push(bytes);
            if (text.length !== 0)
                this._pieces.push(text);
        } catch (error) {
            throw new StreamLimitError('utf8', `Stream emitted invalid UTF-8: ${error.message}`);
        }
    }
}

class IncrementalUtf8Decoder {
    constructor() {
        this._decoder = new TextDecoder('utf-8', {fatal: true});
        this._carry = new Uint8Array(0);
    }

    push(bytes) {
        const combined = new Uint8Array(this._carry.length + bytes.length);
        combined.set(this._carry);
        combined.set(bytes, this._carry.length);
        const prefixLength = completeUtf8PrefixLength(combined);
        this._carry = combined.slice(prefixLength);
        return this._decoder.decode(combined.subarray(0, prefixLength));
    }

    finish() {
        if (this._carry.length !== 0) {
            const carry = this._carry;
            this._carry = new Uint8Array(0);
            return this._decoder.decode(carry);
        }
        return '';
    }
}

function completeUtf8PrefixLength(bytes) {
    if (bytes.length === 0)
        return 0;
    let continuations = 0;
    let index = bytes.length - 1;
    while (index >= 0 && continuations < 3 && (bytes[index] & 0xc0) === 0x80) {
        continuations++;
        index--;
    }
    if (index < 0)
        return bytes.length;
    const expected = expectedContinuations(bytes[index]);
    if (expected > continuations)
        return index;
    return bytes.length;
}

function expectedContinuations(byte) {
    if (byte >= 0xc2 && byte <= 0xdf)
        return 1;
    if (byte >= 0xe0 && byte <= 0xef)
        return 2;
    if (byte >= 0xf0 && byte <= 0xf4)
        return 3;
    return 0;
}

/** Retains an 8-KiB stderr tail while enforcing a 64-KiB/minute budget. */
export class StreamStderr {
    constructor(nowUs) {
        this._budget = new TokenBucket(
            STDERR_BYTES_PER_MINUTE,
            STDERR_BYTES_PER_MINUTE / 60,
            nowUs);
        this._tail = new Uint8Array(0);
    }

    /** Adds stderr bytes or throws when the rolling rate is exceeded. */
    push(chunk, nowUs) {
        if (!this._budget.consume(chunk.length, nowUs))
            throw new StreamLimitError('stderr-rate', 'Stream exceeded its stderr byte budget');
        if (chunk.length >= STDERR_TAIL_BYTES) {
            this._tail = chunk.slice(chunk.length - STDERR_TAIL_BYTES);
            return;
        }
        const retained = Math.min(this._tail.length, STDERR_TAIL_BYTES - chunk.length);
        const next = new Uint8Array(retained + chunk.length);
        next.set(this._tail.subarray(this._tail.length - retained));
        next.set(chunk, retained);
        this._tail = next;
    }

    /** Returns the current lossy-decoded diagnostic tail. */
    text() {
        return new TextDecoder().decode(this._tail);
    }
}

/** Tracks bounded exponential restart backoff and healthy reset. */
export class StreamRestartPolicy {
    constructor() {
        this._failures = 0;
        this._healthySinceUs = null;
    }

    /** Notes the first valid snapshot for the current child. */
    markHealthy(nowUs) {
        this._healthySinceUs ??= nowUs;
    }

    /** Returns the next delay or a lockout after the tenth failure. */
    fail(nowUs) {
        if (this._healthySinceUs !== null &&
            nowUs - this._healthySinceUs >= 5 * 60 * 1_000_000)
            this.reset();
        this._healthySinceUs = null;
        this._failures++;
        if (this._failures >= 10)
            return {locked: true, delayMs: null, failures: this._failures};
        const delaySeconds = Math.min(60, 2 ** (this._failures - 1));
        return {locked: false, delayMs: delaySeconds * 1_000, failures: this._failures};
    }

    /** Clears backoff after replacement, re-enable, or explicit restart. */
    reset() {
        this._failures = 0;
        this._healthySinceUs = null;
    }
}
