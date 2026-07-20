# Weather reference plugin

Copy this directory to `$XDG_CONFIG_HOME/pico-argos/plugins/weather/` and set
`WEATHER_LATITUDE`, `WEATHER_LONGITUDE`, and optionally `WEATHER_LOCATION` in
the Shell session environment. The plugin makes one bounded Open-Meteo request
and parses it once into current, two-hour, UV, and nonzero rain-timeline state.
