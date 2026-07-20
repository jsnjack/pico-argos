# VPN reference plugin

Copy this directory to `$XDG_CONFIG_HOME/pico-argos/plugins/vpn/`. It uses the
NordVPN public status endpoint by default; set `VPN_STATUS_URL` to another HTTPS
endpoint returning a `protected` boolean and country field.
