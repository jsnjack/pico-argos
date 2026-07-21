#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later

import Soup from 'gi://Soup?version=3.0';
import System from 'system';

import {weatherSnapshot} from './logic.js';

const WEATHER_SOURCE = 'https://weather.yauhen.cc/api/v1/glance';

try {
    const message = Soup.Message.new('GET', WEATHER_SOURCE);
    message.request_headers.append('Accept', 'application/json');
    message.request_headers.append('User-Agent', 'argos-weather/1.0');
    const bytes = new Soup.Session({timeout: 15}).send_and_read(message, null);
    if (message.status_code < 200 || message.status_code >= 300)
        throw new Error(`Weather service returned HTTP ${message.status_code}`);
    if (bytes.get_size() > 1_048_576)
        throw new Error('Weather response exceeds 1 MiB');
    const data = JSON.parse(
        new TextDecoder('utf-8', {fatal: true}).decode(bytes.get_data()));
    print(JSON.stringify(weatherSnapshot(data)));
} catch (error) {
    printerr(`[weather] ${error.message}`);
    System.exit(1);
}
