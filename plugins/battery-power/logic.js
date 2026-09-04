// SPDX-License-Identifier: GPL-3.0-or-later

// Pure logic for the battery power plugin: it turns the kernel's
// POWER_SUPPLY_* attributes into a protocol version 1 snapshot. Displayed
// numbers are deliberately coarse and smoothed. A battery gauge is
// electrically noisy, and a panel that repaints on that noise costs far more
// than the digits it would gain.

/** Hard panel budget; must not exceed the manifest's reserveTextChars. */
export const PANEL_TEXT_LIMIT = 7;

/** Weight of the newest sample in the displayed power average. */
export const DEFAULT_SMOOTHING = 0.25;

/** Watts the average must move before the panel text is rewritten. */
export const DEFAULT_HYSTERESIS_W = 0.4;

/** A sample this far from the average is a real load change, not noise. */
export const SNAP_W = 5;

/** Below this the battery is neither charging nor discharging. */
export const FLOW_THRESHOLD_W = 0.05;

const MAX_PANEL_WATTS = 9_999;
const ESTIMATE_STEP_MINUTES = 5;
const COARSE_ESTIMATE_STEP_MINUTES = 15;
const COARSE_ESTIMATE_HOURS = 2;
const MAX_ESTIMATE_HOURS = 48;
const MENU_TEXT_LIMIT = 512;
const MICRO = 1_000_000;
const DECI_DEGREES = 10;
const MONTHS_PER_YEAR = 12;
const YEARS_IN_MONTHS = 24;
const MAX_SOURCES = 8;
const USB_KINDS = {C: 'USB-C', PD: 'USB-C PD', PD_PPS: 'USB-C PD'};
// Kernel health strings that name a fault rather than an operating note:
// Warm and Cool are ordinary, Hot and Cold are not.
const CRITICAL_HEALTH = new Set([
    'Dead', 'Overheat', 'Over voltage', 'Over current', 'Unspecified failure',
]);
const WARNING_HEALTH = new Set([
    'Cold', 'Hot', 'No battery', 'Calibration required',
    'Watchdog timer expire', 'Safety timer expire',
]);
const ARROWS = {charging: '↑', discharging: '↓', idle: ''};
const STATUS_TEXT = {
    Charging: 'Charging',
    Discharging: 'Discharging',
    Full: 'Full',
    'Not charging': 'Not charging',
};

/**
 * Turns a noisy series of power samples into the value the panel shows. The
 * running average absorbs single-sample spikes and the hysteresis band keeps
 * the last digit still while the load merely drifts, but a sample far from
 * the average is taken as measured: a load that really started belongs on the
 * panel now, not once an average has caught up with it.
 */
export class PowerDisplay {
    constructor({
        smoothing = DEFAULT_SMOOTHING,
        hysteresisW = DEFAULT_HYSTERESIS_W,
    } = {}) {
        this._smoothing = smoothing;
        this._hysteresisW = hysteresisW;
        this._average = null;
        this._displayed = null;
    }

    /** The watts the panel shows, or null before the first usable sample. */
    get watts() {
        return this._displayed;
    }

    /** Forgets the average so the next sample is shown as measured. */
    reset() {
        this._average = null;
        this._displayed = null;
    }

    /**
     * Folds one measured sample in and returns the value to display.
     *
     * @param {number} sampleW - measured power in watts
     * @returns {?number} the value to display, or null before the first one
     */
    update(sampleW) {
        if (!Number.isFinite(sampleW) || sampleW < 0)
            return this._displayed;
        if (this._average === null || Math.abs(sampleW - this._average) >= SNAP_W)
            this._average = sampleW;
        else
            this._average += this._smoothing * (sampleW - this._average);
        const candidate = Math.round(this._average * 10) / 10;
        if (this._displayed === null || candidate === 0 ||
            Math.abs(candidate - this._displayed) >= this._hysteresisW)
            this._displayed = candidate;
        return this._displayed;
    }
}

/**
 * Parses one `uevent` attribute file into its key/value pairs.
 *
 * @param {string} text - the contents of a power-supply `uevent` file
 * @returns {Map<string, string>} the POWER_SUPPLY_* values it declares
 */
export function parseUevent(text) {
    const values = new Map();
    if (typeof text !== 'string')
        return values;
    for (const line of text.split('\n')) {
        const separator = line.indexOf('=');
        if (separator > 0)
            values.set(line.slice(0, separator), line.slice(separator + 1));
    }
    return values;
}

/**
 * Normalizes one battery's attributes, and the supplies and slow attributes
 * beside it, into the reading batterySnapshot() consumes. Charge-reporting
 * batteries are converted to energy at their design voltage, which is
 * constant: the instantaneous voltage would make a resting battery's capacity
 * drift.
 *
 * @param {Map<string, string>} battery - the battery's POWER_SUPPLY_* values
 * @param {object} [options] - the supplies and attributes read beside it
 * @param {?Map<string, string>} [options.mains] - the mains supply's values
 * @param {Map<string, string>[]} [options.sources] - USB source supplies
 * @param {?string} [options.chargeTypes] - the `charge_types` attribute
 * @param {?string} [options.chargeLimit] - the charge end threshold
 * @param {number} [options.nowMs] - the moment the battery's age is read at
 * @returns {object} the normalized reading
 */
export function readingFromUevent(battery, options = {}) {
    const values = battery instanceof Map ? battery : new Map();
    const {
        mains = null,
        sources = [],
        chargeTypes = null,
        chargeLimit = null,
        nowMs = Date.now(),
    } = options;
    const micro = key => scaled(values.get(key), MICRO);
    const voltageV = micro('POWER_SUPPLY_VOLTAGE_NOW');
    const designV = micro('POWER_SUPPLY_VOLTAGE_MIN_DESIGN') ?? voltageV;
    const currentA = absolute(micro('POWER_SUPPLY_CURRENT_NOW'));
    const powerW = absolute(micro('POWER_SUPPLY_POWER_NOW')) ??
        (currentA !== null && voltageV !== null ? currentA * voltageV : null);
    const energyNowWh = energy(micro('POWER_SUPPLY_ENERGY_NOW'),
        micro('POWER_SUPPLY_CHARGE_NOW'), designV);
    const energyFullWh = energy(micro('POWER_SUPPLY_ENERGY_FULL'),
        micro('POWER_SUPPLY_CHARGE_FULL'), designV);
    const energyDesignWh = energy(micro('POWER_SUPPLY_ENERGY_FULL_DESIGN'),
        micro('POWER_SUPPLY_CHARGE_FULL_DESIGN'), designV);
    const temp = scaled(values.get('POWER_SUPPLY_TEMP'), DECI_DEGREES);
    const cycles = scaled(values.get('POWER_SUPPLY_CYCLE_COUNT'), 1);

    return {
        present: values.get('POWER_SUPPLY_PRESENT') !== '0' && values.size > 0,
        status: values.get('POWER_SUPPLY_STATUS') ?? 'Unknown',
        acOnline: mains instanceof Map
            ? mains.get('POWER_SUPPLY_ONLINE') === '1'
            : null,
        powerW,
        capacityPercent: scaled(values.get('POWER_SUPPLY_CAPACITY'), 1) ??
            percentOf(energyNowWh, energyFullWh),
        energyNowWh,
        energyFullWh,
        energyDesignWh,
        cycleCount: cycles !== null && cycles > 0 ? Math.round(cycles) : null,
        temperatureC: temp,
        health: values.get('POWER_SUPPLY_HEALTH') ?? null,
        ageMonths: ageInMonths(values, nowMs),
        adapter: adapterOf(sources),
        chargeMode: parseChargeMode(chargeTypes),
        chargeLimitPercent: percentValue(chargeLimit),
    };
}

/**
 * Builds the snapshot for one reading. The reading's power should already be
 * the displayed value, so the panel, the estimate, and the menu agree.
 *
 * @param {object} reading - a reading from readingFromUevent()
 * @returns {object} protocol version 1 snapshot
 */
export function batterySnapshot(reading) {
    const flow = flowOf(reading);
    const watts = Number.isFinite(reading?.powerW)
        ? Math.min(Math.abs(reading.powerW), MAX_PANEL_WATTS)
        : null;
    return {
        version: 1,
        type: 'snapshot',
        panel: panelState(reading, flow, watts),
        menu: menuRows(reading, flow, watts),
    };
}

/** Which way the energy is moving, as the panel arrow reports it. */
function flowOf(reading) {
    const status = reading?.status;
    const watts = Number.isFinite(reading?.powerW) ? Math.abs(reading.powerW) : 0;
    if (watts < FLOW_THRESHOLD_W || status === 'Full' || status === 'Not charging')
        return 'idle';
    if (status === 'Charging')
        return 'charging';
    if (status === 'Discharging')
        return 'discharging';
    // Firmware that reports Unknown mid-flow still knows about the adapter.
    return reading?.acOnline === true ? 'charging' : 'discharging';
}

/** The panel: a fixed-width wattmeter, hidden when there is no battery. */
function panelState(reading, flow, watts) {
    if (reading?.present !== true || watts === null)
        return null;
    return {
        text: panelText(flow, watts),
        appearance: 'monospace',
        severity: healthSeverity(reading.health),
        accessibleName: accessibleName(reading, flow, watts),
    };
}

/**
 * The one state worth a color of its own. The charge level is not: GNOME's
 * own indicator already warns about that, and a second warning beside it
 * would only make both easier to ignore.
 */
function healthSeverity(health) {
    if (CRITICAL_HEALTH.has(health))
        return 'critical';
    return WARNING_HEALTH.has(health) ? 'warning' : 'normal';
}

/** The menu: what the battery is doing, then how long, then its condition. */
function menuRows(reading, flow, watts) {
    if (reading?.present !== true)
        return [];
    const rows = [{id: 'state', kind: 'label', text: stateText(reading, flow)}];
    if (healthSeverity(reading.health) !== 'normal')
        rows.push({id: 'fault', kind: 'label', text: `Battery health: ${reading.health}`});
    const estimate = estimateText(reading, flow, watts);
    if (estimate !== null)
        rows.push({id: 'estimate', kind: 'label', text: estimate});

    const details = [];
    const adapter = adapterText(reading, flow);
    if (adapter !== null)
        details.push({id: 'adapter', kind: 'label', text: adapter});
    const mode = modeText(reading);
    if (mode !== null)
        details.push({id: 'mode', kind: 'label', text: mode});
    if (reading.energyNowWh !== null && reading.energyFullWh !== null) {
        details.push({
            id: 'energy',
            kind: 'label',
            text: `${Math.round(reading.energyNowWh)} Wh of ` +
                `${Math.round(reading.energyFullWh)} Wh`,
        });
    }
    const health = healthText(reading);
    if (health !== null)
        details.push({id: 'health', kind: 'label', text: health});
    if (reading.temperatureC !== null) {
        details.push({
            id: 'temperature',
            kind: 'label',
            text: `${Math.round(reading.temperatureC)} °C`,
        });
    }
    if (details.length > 0)
        rows.push({id: 'detail-separator', kind: 'separator'}, ...details);
    return rows.map(row => row.kind === 'separator'
        ? row
        : {...row, text: clampText(row.text, MENU_TEXT_LIMIT)});
}

/** "Charging · 18%", and the notable case of losing charge on the adapter. */
function stateText(reading, flow) {
    const status = STATUS_TEXT[reading.status] ?? 'Unknown';
    const onAdapter = flow === 'discharging' && reading.acOnline === true;
    const state = onAdapter ? `${status} on AC` : status;
    return reading.capacityPercent === null
        ? state
        : `${state} · ${Math.round(reading.capacityPercent)}%`;
}

/** How long the present flow can last, to the nearest five minutes. */
function estimateText(reading, flow, watts) {
    if (flow === 'idle' || watts === null || watts < FLOW_THRESHOLD_W)
        return null;
    const remainingWh = flow === 'charging'
        ? subtract(reading.energyFullWh, reading.energyNowWh)
        : reading.energyNowWh;
    if (remainingWh === null || remainingWh <= 0)
        return null;
    const hours = remainingWh / watts;
    if (!Number.isFinite(hours) || hours > MAX_ESTIMATE_HOURS)
        return null;
    const duration = durationText(hours);
    if (duration === null)
        return null;
    return flow === 'charging' ? `${duration} until full` : `${duration} left`;
}

/** "Health 96% · 55 cycles", with whichever half the firmware reports. */
function healthText(reading) {
    const parts = [];
    const health = percentOf(reading.energyFullWh, reading.energyDesignWh);
    if (health !== null)
        parts.push(`Health ${Math.round(health)}%`);
    if (reading.cycleCount !== null) {
        parts.push(reading.cycleCount === 1
            ? '1 cycle'
            : `${reading.cycleCount} cycles`);
    }
    const age = reading.ageMonths ?? null;
    if (age !== null)
        parts.push(`${ageText(age)} old`);
    return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * What the adapter can deliver. No headroom figure appears beside it: the
 * battery gauge measures its own flow, not the rest of the machine's draw,
 * so the watts left for the system cannot be derived from here. Losing
 * charge on a connected adapter does say the load has outrun it.
 */
function adapterText(reading, flow) {
    const adapter = reading.adapter ?? null;
    if (adapter === null || !Number.isFinite(adapter.watts))
        return null;
    const kind = adapter.kind ? ` · ${adapter.kind}` : '';
    const rating = `Adapter ${Math.round(adapter.watts)} W${kind}`;
    return flow === 'discharging' && reading.acOnline === true
        ? `${rating} · not keeping up`
        : rating;
}

/** The firmware's charging policy, which explains an unexpectedly slow charge. */
function modeText(reading) {
    const parts = [];
    const mode = reading.chargeMode ?? null;
    const limit = reading.chargeLimitPercent ?? null;
    if (mode !== null)
        parts.push(`Charge mode ${mode}`);
    if (limit !== null)
        parts.push(`limit ${limit}%`);
    return parts.length === 0 ? null : parts.join(' · ');
}

/** "11 months", or whole years once counting months stops being useful. */
function ageText(months) {
    if (months < 1)
        return 'under a month';
    if (months < YEARS_IN_MONTHS)
        return months === 1 ? '1 month' : `${months} months`;
    return `${Math.floor(months / MONTHS_PER_YEAR)} years`;
}

/** Speech for the panel, which is otherwise an arrow and a number. */
function accessibleName(reading, flow, watts) {
    const level = reading.capacityPercent === null
        ? ''
        : `, ${Math.round(reading.capacityPercent)} percent`;
    const fault = healthSeverity(reading.health) === 'normal'
        ? ''
        : `, battery health ${reading.health}`;
    if (flow === 'charging')
        return `Charging at ${wattsText(watts)} watts${level}${fault}`;
    if (flow === 'discharging')
        return `Discharging at ${wattsText(watts)} watts${level}${fault}`;
    return `${STATUS_TEXT[reading.status] ?? 'Battery'}, ` +
        `no power flow${level}${fault}`;
}

/** One decimal while it fits the reserved width, whole watts above that. */
function panelText(flow, watts) {
    const arrow = ARROWS[flow];
    const detailed = `${arrow}${wattsText(watts)} W`;
    return Array.from(detailed).length <= PANEL_TEXT_LIMIT
        ? detailed
        : `${arrow}${Math.round(watts)} W`;
}

function wattsText(watts) {
    return watts.toFixed(1);
}

/** "2 h 45 min", rounded to the step that keeps the row still. */
function durationText(hours) {
    const step = hours >= COARSE_ESTIMATE_HOURS
        ? COARSE_ESTIMATE_STEP_MINUTES
        : ESTIMATE_STEP_MINUTES;
    const minutes = Math.round(hours * 60 / step) * step;
    if (minutes <= 0)
        return `under ${step} min`;
    const wholeHours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    if (wholeHours === 0)
        return `${restMinutes} min`;
    return restMinutes === 0
        ? `${wholeHours} h`
        : `${wholeHours} h ${restMinutes} min`;
}

/**
 * The best online USB source's negotiated contract, in watts. UCSI reports
 * the maximum the contract allows, not what is flowing through it.
 */
function adapterOf(sources) {
    if (!Array.isArray(sources))
        return null;
    let best = null;
    for (const source of sources.slice(0, MAX_SOURCES)) {
        if (!(source instanceof Map) ||
            source.get('POWER_SUPPLY_ONLINE') !== '1')
            continue;
        const volts = scaled(source.get('POWER_SUPPLY_VOLTAGE_MAX'), MICRO);
        const amps = scaled(source.get('POWER_SUPPLY_CURRENT_MAX'), MICRO);
        if (volts === null || amps === null || volts * amps <= 0)
            continue;
        const watts = volts * amps;
        if (best === null || watts > best.watts) {
            best = {
                watts,
                kind: USB_KINDS[selected(source.get('POWER_SUPPLY_USB_TYPE'))] ?? null,
            };
        }
    }
    return best;
}

/**
 * The charging policy in force, from a `charge_types` attribute that lists
 * every policy the firmware supports and brackets the selected one.
 *
 * @param {?string} text - the attribute's contents
 * @returns {?string} the selected policy
 */
export function parseChargeMode(text) {
    const mode = selected(text) ?? (typeof text === 'string' ? text.trim() : '');
    return /^[A-Za-z][A-Za-z ]{0,31}$/.test(mode) ? mode : null;
}

/** The bracketed token of a sysfs attribute that marks its selected value. */
function selected(text) {
    if (typeof text !== 'string')
        return null;
    const match = /\[([^\]]{1,32})\]/.exec(text);
    return match === null ? null : match[1];
}

/** Whole months since the cells were made, which the firmware dates. */
function ageInMonths(values, nowMs) {
    const year = scaled(values.get('POWER_SUPPLY_MANUFACTURE_YEAR'), 1);
    const month = scaled(values.get('POWER_SUPPLY_MANUFACTURE_MONTH'), 1);
    const day = scaled(values.get('POWER_SUPPLY_MANUFACTURE_DAY'), 1) ?? 1;
    if (year === null || month === null || month < 1 || month > 12)
        return null;
    const now = new Date(nowMs);
    const months = (now.getUTCFullYear() - year) * MONTHS_PER_YEAR +
        (now.getUTCMonth() + 1 - month) - (now.getUTCDate() < day ? 1 : 0);
    return months >= 0 && months < 1_200 ? months : null;
}

/** A whole percentage from one attribute, or null when it is not one. */
function percentValue(raw) {
    const value = scaled(raw, 1);
    return value !== null && value >= 1 && value <= 100 ? Math.round(value) : null;
}

/** Energy in watt-hours, converting a charge-reporting battery if needed. */
function energy(energyWh, chargeAh, designV) {
    if (energyWh !== null)
        return energyWh;
    if (chargeAh === null || designV === null)
        return null;
    return chargeAh * designV;
}

/** A finite number from one attribute, divided by its unit scale. */
function scaled(raw, divisor) {
    if (typeof raw !== 'string' || raw === '')
        return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value / divisor : null;
}

/** Discharge is reported as a negative current by some drivers. */
function absolute(value) {
    return value === null ? null : Math.abs(value);
}

function subtract(total, part) {
    return total === null || part === null ? null : total - part;
}

function percentOf(part, total) {
    if (part === null || total === null || total <= 0)
        return null;
    return part / total * 100;
}

/** Truncates to a Unicode-scalar budget with an ellipsis. */
function clampText(text, limit) {
    const scalars = Array.from(text);
    if (scalars.length <= limit)
        return text;
    return `${scalars.slice(0, limit - 1).join('')}…`;
}
