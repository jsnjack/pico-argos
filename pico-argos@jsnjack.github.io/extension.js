// SPDX-License-Identifier: GPL-3.0-or-later

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {PerformanceController} from './lib/performance-controller.js';

/** GNOME Shell lifecycle entry point for pico-argos. */
export default class PicoArgosExtension extends Extension {
    enable() {
        this._controller = new PerformanceController(this.getSettings());
        this._controller.enable();
    }

    disable() {
        this._controller?.disable();
        this._controller = null;
    }
}
