// SPDX-License-Identifier: GPL-3.0-or-later

/** Synthetic workload modes exposed by the Phase 0 harness. */
export const SYNTHETIC_MODES = Object.freeze({
    CONSTANT: 'constant',
    CHANGING: 'changing',
    SPAWN: 'spawn',
});

const MODE_TEXT = Object.freeze({
    [SYNTHETIC_MODES.CONSTANT]: 'constant 000000',
    [SYNTHETIC_MODES.SPAWN]: 'spawn    000000',
});

/** Produces fixed-width text for the synthetic performance workloads. */
export class SyntheticOutput {
    constructor() {
        this._sequence = 0;
    }

    /** Resets the changing workload sequence. */
    reset() {
        this._sequence = 0;
    }

    /** Returns the next fixed-width value for a workload mode. */
    next(mode) {
        if (mode === SYNTHETIC_MODES.CHANGING) {
            this._sequence = (this._sequence + 1) % 1_000_000;
            return `changing ${String(this._sequence).padStart(6, '0')}`;
        }

        const text = MODE_TEXT[mode];
        if (text === undefined)
            throw new RangeError(`Unsupported synthetic mode: ${mode}`);
        return text;
    }
}
