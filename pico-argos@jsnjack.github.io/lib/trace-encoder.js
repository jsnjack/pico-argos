// SPDX-License-Identifier: GPL-3.0-or-later

const DEFAULT_SLICE_BUDGET_US = 500;
const DEFAULT_CHUNK_CHARS = 16 * 1_024;

/** Incrementally encodes one trace without serializing its event ring at once. */
export class TraceEncoder {
    constructor(document, trace) {
        this._trace = trace;
        this._eventIndex = 0;
        this._prefix = `${JSON.stringify(document).slice(0, -1)},"events":[`;
        this._prefixPending = true;
        this._suffixPending = true;
    }

    /** Returns the next bounded JSON chunk, or null after completion. */
    nextChunk(clock, sliceBudgetUs = DEFAULT_SLICE_BUDGET_US,
        maximumChunkChars = DEFAULT_CHUNK_CHARS) {
        if (this._prefixPending) {
            this._prefixPending = false;
            return this._prefix;
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
