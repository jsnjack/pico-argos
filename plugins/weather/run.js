#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';

import {weatherSnapshot} from './logic.js';

try {
    const latitude = coordinate('WEATHER_LATITUDE', -90, 90);
    const longitude = coordinate('WEATHER_LONGITUDE', -180, 180);
    const location = GLib.getenv('WEATHER_LOCATION') ?? `${latitude}, ${longitude}`;
    if (location.length === 0 || [...location].length > 128)
        throw new Error('WEATHER_LOCATION must contain 1 through 128 characters');
    const uri = 'https://api.open-meteo.com/v1/forecast' +
        `?latitude=${latitude}&longitude=${longitude}` +
        '&current=temperature_2m,apparent_temperature,precipitation,weather_code' +
        '&hourly=temperature_2m,rain,uv_index&forecast_hours=12&timezone=auto';
    const message = Soup.Message.new('GET', uri);
    message.request_headers.append('Accept', 'application/json');
    message.request_headers.append('User-Agent', 'pico-argos-weather');
    const bytes = new Soup.Session({timeout: 15}).send_and_read(message, null);
    if (message.status_code < 200 || message.status_code >= 300)
        throw new Error(`Weather service returned HTTP ${message.status_code}`);
    if (bytes.get_size() > 1_048_576)
        throw new Error('Weather response exceeds 1 MiB');
    const data = JSON.parse(
        new TextDecoder('utf-8', {fatal: true}).decode(bytes.get_data()));
    print(JSON.stringify(weatherSnapshot(data, location)));
} catch (error) {
    printerr(`[weather] ${error.message}`);
    System.exit(1);
}

function coordinate(name, minimum, maximum) {
    const raw = GLib.getenv(name);
    const value = Number(raw);
    if (raw === null || !Number.isFinite(value) || value < minimum || value > maximum)
        throw new Error(`${name} is required and must be from ${minimum} through ${maximum}`);
    return value;
}
