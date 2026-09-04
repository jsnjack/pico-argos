// SPDX-License-Identifier: GPL-3.0-or-later

import {
    DEFAULT_HYSTERESIS_W,
    PANEL_TEXT_LIMIT,
    PowerDisplay,
    SNAP_W,
    batterySnapshot,
    parseChargeMode,
    parseUevent,
    readingFromUevent,
} from './logic.js';

// A charge-reporting battery, as a Dell laptop's embedded controller writes
// it: microamp-hours and microamps, with no energy or power attribute.
const CHARGE_UEVENT = [
    'DEVTYPE=power_supply',
    'POWER_SUPPLY_NAME=BAT0',
    'POWER_SUPPLY_TYPE=Battery',
    'POWER_SUPPLY_STATUS=Charging',
    'POWER_SUPPLY_HEALTH=Good',
    'POWER_SUPPLY_PRESENT=1',
    'POWER_SUPPLY_CYCLE_COUNT=55',
    'POWER_SUPPLY_VOLTAGE_MIN_DESIGN=11700000',
    'POWER_SUPPLY_VOLTAGE_NOW=11630000',
    'POWER_SUPPLY_CURRENT_NOW=2382000',
    'POWER_SUPPLY_CHARGE_FULL_DESIGN=8082000',
    'POWER_SUPPLY_CHARGE_FULL=7920000',
    'POWER_SUPPLY_CHARGE_NOW=1493000',
    'POWER_SUPPLY_CAPACITY=18',
    'POWER_SUPPLY_TEMP=339',
    'POWER_SUPPLY_MANUFACTURE_YEAR=2025',
    'POWER_SUPPLY_MANUFACTURE_MONTH=10',
    'POWER_SUPPLY_MANUFACTURE_DAY=21',
    '',
].join('\n');

const MAINS_ONLINE = parseUevent(
    'POWER_SUPPLY_NAME=AC\nPOWER_SUPPLY_TYPE=Mains\nPOWER_SUPPLY_ONLINE=1\n');
const MAINS_OFFLINE = parseUevent(
    'POWER_SUPPLY_NAME=AC\nPOWER_SUPPLY_TYPE=Mains\nPOWER_SUPPLY_ONLINE=0\n');

// Two USB-C ports, one of them carrying a 20 V, 3 A power-delivery contract.
const SOURCES = [
    parseUevent([
        'POWER_SUPPLY_TYPE=USB',
        'POWER_SUPPLY_ONLINE=0',
        'POWER_SUPPLY_VOLTAGE_MAX=5000000',
        'POWER_SUPPLY_CURRENT_MAX=0',
        'POWER_SUPPLY_USB_TYPE=[C] PD PD_PPS',
        '',
    ].join('\n')),
    parseUevent([
        'POWER_SUPPLY_TYPE=USB',
        'POWER_SUPPLY_ONLINE=1',
        'POWER_SUPPLY_VOLTAGE_MAX=20000000',
        'POWER_SUPPLY_CURRENT_MAX=3000000',
        'POWER_SUPPLY_USB_TYPE=C [PD] PD_PPS',
        '',
    ].join('\n')),
];

// The moment every dated assertion below is read at: the fixture battery was
// made on 21 October 2025, which is ten whole months earlier.
const NOW_MS = Date.parse('2026-09-04T12:00:00Z');
const CONTEXT = {
    mains: MAINS_ONLINE,
    sources: SOURCES,
    chargeTypes: '[Trickle] Fast Standard Adaptive Custom',
    chargeLimit: '80',
    nowMs: NOW_MS,
};

// Every key=value line is kept, and the noise around them is not.
const parsed = parseUevent(CHARGE_UEVENT);
if (parsed.get('POWER_SUPPLY_STATUS') !== 'Charging' ||
    parsed.get('POWER_SUPPLY_CURRENT_NOW') !== '2382000' ||
    parsed.size !== 18)
    throw new Error(`uevent parsing failed: ${parsed.size} values`);
if (parseUevent('nonsense\n=empty\n').size !== 0)
    throw new Error('uevent parsing accepted a line without a key');

// Current times voltage is the power flow, and charge times the design
// voltage is the energy: the reading speaks watts whatever the firmware does.
const charge = readingFromUevent(parsed, CONTEXT);
if (Math.abs(charge.powerW - 27.7) > 0.05)
    throw new Error(`Power from current and voltage failed: ${charge.powerW}`);
if (Math.abs(charge.energyNowWh - 17.5) > 0.05 ||
    Math.abs(charge.energyFullWh - 92.7) > 0.05 ||
    Math.abs(charge.energyDesignWh - 94.6) > 0.05)
    throw new Error(`Charge to energy conversion failed: ${charge.energyNowWh}`);
if (charge.capacityPercent !== 18 || charge.cycleCount !== 55 ||
    Math.abs(charge.temperatureC - 33.9) > 0.05 || charge.acOnline !== true ||
    charge.present !== true || charge.health !== 'Good')
    throw new Error(`Reading normalization failed: ${JSON.stringify(charge)}`);

// The adapter's contract is the larger online port's, the charging policy is
// the bracketed one, and the age is counted in whole months.
if (charge.adapter.watts !== 60 || charge.adapter.kind !== 'USB-C PD' ||
    charge.chargeMode !== 'Trickle' || charge.chargeLimitPercent !== 80 ||
    charge.ageMonths !== 10)
    throw new Error(`Supply context failed: ${JSON.stringify(charge)}`);
if (readingFromUevent(parsed, {nowMs: NOW_MS}).adapter !== null)
    throw new Error('An unread port must not become an adapter');
if (parseChargeMode('Fast') !== 'Fast' || parseChargeMode(null) !== null ||
    parseChargeMode('[]') !== null || parseChargeMode('[Fast] Custom') !== 'Fast')
    throw new Error('Charge mode parsing failed');

// An energy-reporting battery is used as it stands, and a driver that signs
// its discharge current negative still reports a positive flow.
const energy = readingFromUevent(parseUevent([
    'POWER_SUPPLY_STATUS=Discharging',
    'POWER_SUPPLY_POWER_NOW=-12300000',
    'POWER_SUPPLY_ENERGY_NOW=30000000',
    'POWER_SUPPLY_ENERGY_FULL=60000000',
    '',
].join('\n')), {mains: MAINS_OFFLINE, nowMs: NOW_MS});
if (Math.abs(energy.powerW - 12.3) > 0.001 || energy.energyNowWh !== 30 ||
    energy.energyFullWh !== 60 || energy.energyDesignWh !== null ||
    energy.capacityPercent !== 50 || energy.cycleCount !== null ||
    energy.temperatureC !== null || energy.acOnline !== false ||
    energy.health !== null || energy.ageMonths !== null)
    throw new Error(`Energy reading failed: ${JSON.stringify(energy)}`);

// A machine with no battery reports nothing to read.
const empty = readingFromUevent(new Map());
if (empty.present !== false || empty.powerW !== null ||
    empty.acOnline !== null || empty.adapter !== null)
    throw new Error(`Absent battery failed: ${JSON.stringify(empty)}`);

// Charging is an up arrow, discharging a down arrow, and both stay inside
// the panel's reserved width.
const charging = batterySnapshot({...charge, powerW: 27.7});
if (charging.panel.text !== '↑27.7 W' ||
    charging.panel.appearance !== 'monospace' ||
    charging.panel.severity !== 'normal' ||
    charging.panel.accessibleName !== 'Charging at 27.7 watts, 18 percent')
    throw new Error(`Charging panel failed: ${JSON.stringify(charging.panel)}`);
const discharging = batterySnapshot({...energy, powerW: 12.3});
if (discharging.panel.text !== '↓12.3 W')
    throw new Error(`Discharging panel failed: ${JSON.stringify(discharging.panel)}`);
for (const watts of [0, 0.04, 9.9, 99.9, 100, 240, 99_999]) {
    const text = batterySnapshot({...charge, powerW: watts}).panel.text;
    if (Array.from(text).length > PANEL_TEXT_LIMIT)
        throw new Error(`Panel text exceeds its reserved width: ${text}`);
}
if (batterySnapshot({...charge, powerW: 137.4}).panel.text !== '↑137 W')
    throw new Error('A three-digit reading must drop its decimal');

// The menu explains the panel: what the battery is doing, how long that
// lasts, and the condition it is in.
if (JSON.stringify(charging.menu.map(row => row.id)) !== JSON.stringify([
    'state', 'estimate', 'detail-separator', 'adapter', 'mode', 'energy',
    'health', 'temperature']))
    throw new Error(`Menu rows failed: ${JSON.stringify(charging.menu)}`);
const byId = new Map(charging.menu.map(row => [row.id, row.text]));
if (byId.get('state') !== 'Charging · 18%' ||
    byId.get('estimate') !== '2 h 45 min until full' ||
    byId.get('energy') !== '17 Wh of 93 Wh' ||
    byId.get('adapter') !== 'Adapter 60 W · USB-C PD' ||
    byId.get('mode') !== 'Charge mode Trickle · limit 80%' ||
    byId.get('health') !== 'Health 98% · 55 cycles · 10 months old' ||
    byId.get('temperature') !== '34 °C')
    throw new Error(`Menu text failed: ${JSON.stringify(charging.menu)}`);
const remaining = new Map(discharging.menu.map(row => [row.id, row.text]));
if (remaining.get('estimate') !== '2 h 30 min left' ||
    remaining.get('state') !== 'Discharging · 50%')
    throw new Error(`Remaining menu failed: ${JSON.stringify(discharging.menu)}`);

// Losing charge with the adapter connected is worth saying out loud, in the
// state row and beside the rating the load has outrun.
const onAdapter = batterySnapshot({
    ...energy, acOnline: true, powerW: 12.3, adapter: charge.adapter,
});
const adapterRows = new Map(onAdapter.menu.map(row => [row.id, row.text]));
if (adapterRows.get('state') !== 'Discharging on AC · 50%' ||
    adapterRows.get('adapter') !== 'Adapter 60 W · USB-C PD · not keeping up')
    throw new Error(`Adapter state failed: ${JSON.stringify(onAdapter.menu)}`);

// A real fault colors the panel and says what is wrong; an ordinary
// operating note does neither.
const overheat = batterySnapshot({...charge, health: 'Overheat', powerW: 27.7});
if (overheat.panel.severity !== 'critical' ||
    overheat.menu[1].id !== 'fault' ||
    overheat.menu[1].text !== 'Battery health: Overheat' ||
    !overheat.panel.accessibleName.endsWith('battery health Overheat'))
    throw new Error(`Health fault failed: ${JSON.stringify(overheat.panel)}`);
if (batterySnapshot({...charge, health: 'Cold', powerW: 27.7}).panel.severity !==
    'warning')
    throw new Error('A cold battery must warn');
for (const health of ['Good', 'Warm', 'Cool', 'Unknown', null]) {
    const snapshot = batterySnapshot({...charge, health, powerW: 27.7});
    if (snapshot.panel.severity !== 'normal' ||
        snapshot.menu.some(row => row.id === 'fault'))
        throw new Error(`Ordinary health raised an alert: ${health}`);
}

// Age is counted in months until whole years read better.
const ages = [[1, '1 month old'], [23, '23 months old'], [24, '2 years old'],
    [40, '3 years old'], [0, 'under a month old']];
for (const [months, expected] of ages) {
    const rows = new Map(batterySnapshot({...charge, ageMonths: months, powerW: 1})
        .menu.map(row => [row.id, row.text]));
    if (!rows.get('health').endsWith(expected))
        throw new Error(`Age text failed at ${months}: ${rows.get('health')}`);
}

// A full battery on the adapter is neither charging nor discharging: no
// arrow, no estimate, and speech that says so.
const full = batterySnapshot({
    ...charge, status: 'Full', powerW: 0, capacityPercent: 100,
});
if (full.panel.text !== '0.0 W' ||
    full.panel.accessibleName !== 'Full, no power flow, 100 percent' ||
    full.menu.some(row => row.id === 'estimate'))
    throw new Error(`Full panel failed: ${JSON.stringify(full)}`);

// A charge threshold holds the battery still while the adapter is connected.
const holding = batterySnapshot({...charge, status: 'Not charging', powerW: 0});
if (holding.panel.text !== '0.0 W' || holding.menu[0].text !== 'Not charging · 18%')
    throw new Error(`Held charge failed: ${JSON.stringify(holding)}`);

// Firmware that reports Unknown mid-flow is read through the adapter.
const unknown = batterySnapshot({...charge, status: 'Unknown', powerW: 9});
if (unknown.panel.text !== '↑9.0 W')
    throw new Error(`Unknown status failed: ${JSON.stringify(unknown.panel)}`);
const unplugged = batterySnapshot({
    ...charge, status: 'Unknown', acOnline: false, powerW: 9,
});
if (unplugged.panel.text !== '↓9.0 W')
    throw new Error(`Unknown status on battery failed: ${JSON.stringify(unplugged.panel)}`);

// An implausible estimate is left out rather than shown: a battery trickling
// at a tenth of a watt is not "forty days from empty" in any useful sense.
const trickle = batterySnapshot({...energy, powerW: 0.1});
if (trickle.menu.some(row => row.id === 'estimate'))
    throw new Error(`Implausible estimate failed: ${JSON.stringify(trickle.menu)}`);

// No battery means no panel and no menu, not an error state.
if (batterySnapshot(empty).panel !== null ||
    batterySnapshot(empty).menu.length !== 0)
    throw new Error('An absent battery must hide the indicator');

// A partial reading shows what it has and leaves out the rest.
const partial = batterySnapshot({
    present: true, status: 'Discharging', acOnline: null, powerW: 5,
    capacityPercent: null, energyNowWh: null, energyFullWh: null,
    energyDesignWh: null, cycleCount: null, temperatureC: null,
});
if (partial.panel.text !== '↓5.0 W' ||
    partial.panel.accessibleName !== 'Discharging at 5.0 watts' ||
    JSON.stringify(partial.menu) !== JSON.stringify([
        {id: 'state', kind: 'label', text: 'Discharging'}]))
    throw new Error(`Partial reading failed: ${JSON.stringify(partial)}`);

// The display absorbs noise: a tenth of a watt either way is the same
// reading, and the panel is not rewritten for it.
const display = new PowerDisplay();
if (display.watts !== null || display.update(10) !== 10 || display.watts !== 10)
    throw new Error('The first sample must be shown as measured');
if (display.update(10.1) !== 10 || display.update(9.9) !== 10)
    throw new Error(`Noise moved the panel: ${display.watts}`);
let drifted = display.update(10);
for (let sample = 0; sample < 20; sample++)
    drifted = display.update(11);
if (Math.abs(drifted - 11) > DEFAULT_HYSTERESIS_W)
    throw new Error(`A sustained change never arrived: ${drifted}`);

// A load that really starts is on the panel at once, not once an average has
// caught up with it.
const snapping = new PowerDisplay();
snapping.update(8);
if (snapping.update(8 + SNAP_W) !== 13)
    throw new Error(`A real load change was smoothed away: ${snapping.watts}`);

// Unusable samples keep the last value; a reset forgets it.
if (snapping.update(Number.NaN) !== 13 || snapping.update(-1) !== 13)
    throw new Error('An unusable sample must not reach the panel');
snapping.reset();
if (snapping.watts !== null || snapping.update(2) !== 2)
    throw new Error('A reset display must start again from its next sample');

print('ok - battery power reads the supply class, smooths it, and reports watts');
