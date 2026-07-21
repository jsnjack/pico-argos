# VPN reference plugin

Copy this directory to `$XDG_CONFIG_HOME/pico-argos/plugins/vpn/`. It uses the
original NordVPN public status endpoint at
`https://web-api.nordvpn.com/v1/ips/info` by default; set `VPN_STATUS_URL` to
another HTTPS endpoint returning a `protected` boolean and country field. Its
A snowflake symbolic icon (a deliberate "Nord" reference, chosen to avoid
duplicating GNOME's own generic VPN indicator) appears only while protected.
The menu shows the country code and available city/country details but
deliberately omits the public IP address.
