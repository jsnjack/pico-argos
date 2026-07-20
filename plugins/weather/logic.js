// SPDX-License-Identifier: GPL-3.0-or-later

/** Converts one Open-Meteo response into current/forecast protocol state. */
export function weatherSnapshot(data, location) {
    const current = data?.current;
    const hourly = data?.hourly;
    requireNumber(current?.temperature_2m, 'current temperature');
    requireNumber(current?.apparent_temperature, 'apparent temperature');
    requireNumber(current?.precipitation, 'current precipitation');
    requireNumber(current?.weather_code, 'weather code');
    if (!Array.isArray(hourly?.time) || !Array.isArray(hourly.temperature_2m) ||
        !Array.isArray(hourly.rain) || !Array.isArray(hourly.uv_index))
        throw new Error('Weather hourly forecast arrays are missing');

    const rain = current.precipitation;
    const indicator = rain <= 0 ? '·' : rain < 1 ? '▴' : '▲';
    const temperature = Math.round(current.temperature_2m);
    const menu = [
        label('location', location),
        label('current', `Current ${formatTemperature(current.temperature_2m)}`),
        label('apparent', `Feels like ${formatTemperature(current.apparent_temperature)}`),
        label('two-hour', `In two hours ${formatTemperature(hourly.temperature_2m[2])}`),
        label('uv', `UV index ${formatNumber(hourly.uv_index[0])}`),
        label('rain', rain <= 0 ? 'No current rain' : `Current rain ${formatNumber(rain)} mm`),
    ];
    const timeline = hourly.rain.slice(0, 12)
        .map((amount, index) => ({amount, time: hourly.time[index]}))
        .filter(entry => Number.isFinite(entry.amount) && entry.amount > 0)
        .slice(0, 8);
    if (timeline.length !== 0) {
        menu.push({id: 'rain-separator', kind: 'separator'});
        timeline.forEach((entry, index) => menu.push(label(
            `rain-${index}`,
            `${formatTime(entry.time)} rain ${formatNumber(entry.amount)} mm`)));
    }
    return {
        version: 1,
        type: 'snapshot',
        panel: {
            text: `${temperature}°C ${indicator}`,
            icon: weatherIcon(current.weather_code),
            appearance: 'compact',
            accessibleName: `${location}, ${temperature} degrees Celsius, ${rainDescription(rain)}`,
            severity: 'normal',
        },
        menu,
    };
}

function weatherIcon(code) {
    if (code === 0)
        return 'weather-clear-symbolic';
    if ([1, 2].includes(code))
        return 'weather-few-clouds-symbolic';
    if (code === 3 || [45, 48].includes(code))
        return 'weather-overcast-symbolic';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82))
        return 'weather-showers-symbolic';
    if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86))
        return 'weather-snow-symbolic';
    if (code >= 95)
        return 'weather-storm-symbolic';
    return 'weather-severe-alert-symbolic';
}

function rainDescription(amount) {
    if (amount <= 0)
        return 'no rain';
    if (amount < 1)
        return 'light rain';
    return 'rain';
}

function label(id, text) {
    return {id, kind: 'label', text};
}

function formatTemperature(value) {
    requireNumber(value, 'forecast temperature');
    return `${Math.round(value)}°C`;
}

function formatNumber(value) {
    requireNumber(value, 'forecast value');
    return Number(value).toFixed(1).replace(/\.0$/, '');
}

function formatTime(value) {
    if (typeof value !== 'string' || !value.includes('T'))
        throw new Error('Weather timeline time is invalid');
    return value.split('T')[1].slice(0, 5);
}

function requireNumber(value, context) {
    if (!Number.isFinite(value))
        throw new Error(`Weather ${context} is invalid`);
}
