# Weather reference plugin

Copy this directory to `$XDG_CONFIG_HOME/pico-argos/plugins/weather/`. The
plugin deliberately keeps the legacy source at
`https://weather.yauhen.cc/api/v1/glance`; it makes one bounded request and
parses the response once into current, two-hour, UV, and rain-timeline state.
Do not replace that endpoint during migration unless the user explicitly asks
for a different weather source.

The panel retains the temperature, rain-intensity dots, symbolic condition
icon, and center placement. The native menu summarizes rain onset, peak, and
end, followed by at most eight representative nonzero forecast entries instead
of allowing the two-hour timeline to fill the screen.

## Location

The endpoint accepts optional `lat` and `lon` parameters and otherwise answers
for its own default city. The plugin resolves coordinates from the first
available source:

1. Explicit coordinates in `weather.json`.
2. The city pinned in GNOME Weather.
3. One GeoClue detection at `city` accuracy, bounded by `detectTimeoutMs`.
4. The cached last detection, valid for `cacheTtlMs`.
5. Configured `fallback` coordinates.

With none of these the request omits coordinates entirely and the service
default applies, which is the historical behavior. Detection is best-effort: an
uninstalled, unauthorized, or unresponsive GeoClue is a miss, never a failure,
and never delays the refresh past its deadline. A successful detection is
cached below `$XDG_CACHE_HOME/pico-argos/`, so a routine five-minute refresh
performs no location lookup at all. Coordinates are rounded to four decimals.

Optional configuration lives at:

```text
$XDG_CONFIG_HOME/pico-argos/weather.json
```

```json
{
  "location": "ip",
  "cacheTtlMs": 1800000,
  "detectTimeoutMs": 3000,
  "useGnomeLocation": true
}
```

Set `location` to a `{"latitude": …, "longitude": …}` object to pin the report
to one place and skip every other source. Set it to `"auto"` to follow GNOME
and GeoClue, or to `"ip"` to resolve approximate coordinates from the public
IP address through `https://ipwho.is/`. Every key is optional.

IP mode sends one HTTPS request to `ipwho.is` when its separate 30-minute cache
is empty; the request necessarily reveals the public IP address to that
service. Only the success flag and coordinates are requested, the response is
capped at 4 KiB, and failure preserves the last panel state instead of showing
the weather endpoint's unrelated default city unless an explicit `fallback`
is configured. A VPN or relay makes IP mode follow its exit location rather
than the computer's physical location.

## Following GNOME Weather

The plugin reads `org.gnome.shell.weather`, the same city GNOME Weather and the
Shell's calendar popover use, converting its radian coordinates to degrees. It
does so **only when that schema's `automatic-location` is false**, meaning you
picked the city yourself: an automatic value merely repeats whatever the
location service already reported, so it adds nothing. Set `useGnomeLocation`
to `false` to ignore the setting entirely.

The practical consequence is that turning automatic location off in GNOME
Weather and choosing your city moves both GNOME's own forecast and this panel
together, with no plugin configuration at all. An absent schema, an absent key,
or an unexpected value is treated as no location rather than an error.

GeoClue automatic detection depends on a working backend. It resolves nothing
when location services are disabled, when the WiFi geolocation database has no
coverage for nearby access points, or when the network blocks that database.
