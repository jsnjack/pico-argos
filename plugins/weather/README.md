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
