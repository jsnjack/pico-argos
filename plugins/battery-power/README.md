# Battery power plugin

Shows how fast the battery is charging or discharging, in watts:

| Panel shows | Meaning |
|---|---|
| `↑27.7 W` | Charging at 27.7 watts |
| `↓12.3 W` | Discharging at 12.3 watts |
| `0.0 W` | Neither, because the battery is full or a charge threshold is holding it |
| nothing | The machine has no battery, or its readings stopped |

The menu names the state and the level, estimates how long the present flow
lasts, and reports the adapter, the charging policy, the energy stored, the
health, cycle count and age, and the battery's temperature:

```text
Charging · 55%
1 h 10 min until full
────────────────────────
Adapter 60 W · USB-C PD
Charge mode Trickle
52 Wh of 95 Wh
Health 100% · 55 cycles · 10 months old
31 °C
```

The adapter row is the USB-C power-delivery contract the port negotiated. It
carries no headroom figure: the battery gauge measures its own flow, not the
rest of the machine's draw, so what is left for the system cannot be derived
from here. Losing charge while the adapter is connected does say the load has
outrun it, and both rows say so — `Discharging on AC` and `not keeping up`.

The charging policy explains a charge that is slower than the adapter allows.
Where the firmware also answers for a charge threshold, the limit joins that
row; many machines expose the attribute without being able to read it.

A battery fault — the kernel's health reading of `Overheat`, `Dead`,
`Over voltage`, `Over current` or an unspecified failure — colors the panel
and adds a row naming it. `Hot`, `Cold`, a needed calibration and an expired
timer warn. `Warm` and `Cool` are ordinary operating notes and do neither.

The indicator sits on the left beside the system monitor (`position: "left"`,
order 10), reading as one block of numbers about what the machine is doing.

## Data source

The plugin reads the kernel power-supply class under
`/sys/class/power_supply`. Each cycle reads one `uevent` attribute file per
supply, so the whole reading is a single embedded-controller round trip rather
than one per value.

Power comes from `POWER_SUPPLY_POWER_NOW` where the firmware reports it, and
otherwise from the present current and voltage. A battery that reports charge
in amp-hours is converted to watt-hours at its design voltage, which is
constant: the instantaneous voltage would make a resting battery's stored
energy drift.

Batteries scoped to a device — a mouse or a keyboard — are ignored. The first
system battery in name order is used unless `config.json` names one.

The adapter contract, the charging policy and the charge threshold change
only when something is plugged in or a policy is set, and they cost about as
much to read as the battery itself. They are re-read when the status or the
adapter changes, and otherwise every 15 seconds, so they stay off the
sampling cycle.

## Stability

A battery gauge is electrically noisy, and every changed digit is a panel
repaint. Three things keep the reading calm without making it slow:

- Samples are averaged, so a single odd reading does not reach the panel.
- The displayed value is rewritten only once the average has moved by
  `hysteresisWatts`.
- A sample five watts or more from the average is taken as measured, so a
  load that really started appears on the next cycle rather than fading in.

Unchanged snapshots are repeated every 15 seconds. The core recognizes a
repeat as a no-op before any UI write, and the repeat keeps the runtime's
liveness and freshness clocks current while nothing is happening.

## Configuration

`config.json` beside the plugin, with the defaults shown:

```json
{
  "intervalMs": 2000,
  "battery": "auto",
  "smoothing": 0.25,
  "hysteresisWatts": 0.4
}
```

- `intervalMs` is 1,000 through 30,000. The embedded controller updates its
  own values about once per second, so shorter intervals mostly re-read the
  same numbers.
- `battery` is `auto` or a power-supply name such as `BAT1`.
- `smoothing` is the weight of the newest sample in the average, above 0 and
  at most 1. Use 1 for the raw reading.
- `hysteresisWatts` is 0 through 5.

## Behavior notes

- The estimate is rounded to five minutes, or to fifteen beyond two hours,
  and is left out entirely beyond 48 hours.
- Discharging while the adapter is connected — a load larger than the adapter
  supplies — is called out in the menu.
- GNOME's own indicator already shows the charge level and a low-battery
  warning, so the charge level gets no severity color here. A hardware fault
  does, because nothing else in the panel reports one.
- The battery's serial number is not shown. It identifies the device and
  tells the reader nothing about its state.
