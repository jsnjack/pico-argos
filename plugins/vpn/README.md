# VPN reference plugin

Copy this directory to `$XDG_CONFIG_HOME/pico-argos/plugins/vpn/`. It uses the
original NordVPN public status endpoint at
`https://web-api.nordvpn.com/v1/ips/info` by default; set `VPN_STATUS_URL` to
another HTTPS endpoint returning a `protected` boolean and country field. Its
symbolic snowflake and `Connected to CC` menu line preserve the old indicator.
