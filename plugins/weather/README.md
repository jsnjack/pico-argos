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
2. One GeoClue detection at `city` accuracy, bounded by `detectTimeoutMs`.
3. The cached last detection, valid for `cacheTtlMs`.
4. Configured `fallback` coordinates.

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
  "location": "auto",
  "fallback": {"latitude": 52.3555, "longitude": 5.0003},
  "cacheTtlMs": 1800000,
  "detectTimeoutMs": 3000
}
```

Set `location` to a `{"latitude": …, "longitude": …}` object to pin the report
to one place and skip detection and caching entirely; leave it at `"auto"` to
follow GeoClue. Every key is optional.

Automatic detection depends on a working GeoClue backend. It resolves nothing
when location services are disabled, when the WiFi geolocation database has no
coverage for nearby access points, or when the network blocks that database.
Note that a VPN defeats IP-based geolocation in particular, since the apparent
address is the exit node rather than yours; pin `location` or set `fallback`
when travelling behind one.
