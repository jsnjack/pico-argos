// SPDX-License-Identifier: GPL-3.0-or-later

const DEFAULT_SLICE_BUDGET_US = 500;
const DEFAULT_CHUNK_CHARS = 16 * 1_024;

/** Incrementally encodes one trace without serializing its event ring at once. */
export class TraceEncoder {
    constructor(document, trace) {
        this._trace = trace;
        this._eventIndex = 0;
        this._hasDocumentEntries = Object.keys(document).length !== 0;
        this._documentIterator = encodeEntries(document);
        this._documentComplete = false;
        this._pendingDocumentToken = '';
        this._documentStartPending = true;
        this._eventsStartPending = true;
        this._suffixPending = true;
    }

    /** Returns the next bounded JSON chunk, or null after completion. */
    nextChunk(clock, sliceBudgetUs = DEFAULT_SLICE_BUDGET_US,
        maximumChunkChars = DEFAULT_CHUNK_CHARS) {
        if (this._documentStartPending) {
            this._documentStartPending = false;
            return '{';
        }

        if (!this._documentComplete) {
            const startedUs = clock.nowUs();
            const parts = [];
            let chunkLength = 0;
            while (chunkLength < maximumChunkChars) {
                if (this._pendingDocumentToken.length === 0) {
                    const next = this._documentIterator.next();
                    if (next.done) {
                        this._documentComplete = true;
                        break;
                    }
                    this._pendingDocumentToken = next.value;
                }
                const remaining = maximumChunkChars - chunkLength;
                const part = this._pendingDocumentToken.slice(0, remaining);
                parts.push(part);
                chunkLength += part.length;
                this._pendingDocumentToken = this._pendingDocumentToken.slice(part.length);
                if (clock.nowUs() - startedUs >= sliceBudgetUs)
                    break;
            }
            if (parts.length > 0)
                return parts.join('');
        }

        if (this._eventsStartPending) {
            this._eventsStartPending = false;
            return `${this._hasDocumentEntries ? ',' : ''}"events":[`;
        }

        if (this._eventIndex < this._trace.length) {
            const startedUs = clock.nowUs();
            const parts = [];
            let chunkLength = 0;

            while (this._eventIndex < this._trace.length) {
                const separator = this._eventIndex === 0 ? '' : ',';
                const event = `${separator}${JSON.stringify(
                    this._trace.eventAt(this._eventIndex))}`;
                if (parts.length > 0 && chunkLength + event.length > maximumChunkChars)
                    break;

                parts.push(event);
                chunkLength += event.length;
                this._eventIndex++;
                if (clock.nowUs() - startedUs >= sliceBudgetUs)
                    break;
            }
            return parts.join('');
        }

        if (this._suffixPending) {
            this._suffixPending = false;
            return ']}\n';
        }
        return null;
    }
}

function* encodeEntries(document) {
    let first = true;
    for (const [key, value] of Object.entries(document)) {
        yield `${first ? '' : ','}${JSON.stringify(key)}:`;
        yield* encodeValue(value);
        first = false;
    }
}

function* encodeValue(value) {
    if (value === null || typeof value !== 'object') {
        yield JSON.stringify(value);
        return;
    }
    if (Array.isArray(value)) {
        yield '[';
        for (let index = 0; index < value.length; index++) {
            if (index !== 0)
                yield ',';
            yield* encodeValue(value[index]);
        }
        yield ']';
        return;
    }

    yield '{';
    let first = true;
    for (const [key, child] of Object.entries(value)) {
        yield `${first ? '' : ','}${JSON.stringify(key)}:`;
        yield* encodeValue(child);
        first = false;
    }
    yield '}';
}
