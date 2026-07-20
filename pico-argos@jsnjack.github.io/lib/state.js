// SPDX-License-Identifier: GPL-3.0-or-later

/** Applies text only when its semantic value changes. */
export class DistinctText {
    constructor(initialValue, write) {
        if (typeof initialValue !== 'string')
            throw new TypeError('Initial text must be a string');
        if (typeof write !== 'function')
            throw new TypeError('Text writer must be a function');

        this._value = initialValue;
        this._write = write;
    }

    /** Returns the currently applied text. */
    get value() {
        return this._value;
    }

    /** Writes changed text and returns whether a write occurred. */
    apply(value) {
        if (typeof value !== 'string')
            throw new TypeError('Text must be a string');
        if (value === this._value)
            return false;

        this._write(value);
        this._value = value;
        return true;
    }
}
