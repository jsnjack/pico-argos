// SPDX-License-Identifier: GPL-3.0-or-later

/** Converts one weather.yauhen.cc glance response into protocol state. */
export function weatherSnapshot(data) {
    const temperature = data?.temperature;
    const feelsLike = data?.feels_like;
    const uvIndex = data?.uv_index;
    const location = data?.location?.description;
    requireNumber(temperature?.now, 'current temperature');
    requireNumber(temperature?.end, 'two-hour temperature');
    requireNumber(feelsLike?.now, 'apparent temperature');
    requireNumber(uvIndex?.now, 'UV index');
    requireText(location, 'location');
    requireText(data?.condition, 'condition');

    const rainData = data?.buienalarm?.data;
    if (!Array.isArray(rainData))
        throw new Error('Weather rain timeline is missing');
    const timeline = rainData.map((entry, index) => {
        requireNumber(entry?.value, `rain value ${index}`);
        if (entry.value < 0)
            throw new Error(`Weather rain value ${index} is invalid`);
        return {time: formatTime(entry?.time), value: entry.value};
    });
    const peak = timeline.reduce((maximum, entry) => Math.max(maximum, entry.value), 0);
    const rainDots = peak <= 0.05 ? '' : peak < 0.25 ? ' ·' : peak < 1 ? ' ··' : ' ···';
    const current = formatNumber(temperature.now);
    const menu = [
        label('location', location),
        {id: 'details-separator', kind: 'separator'},
        label('current', `  Now           ${current}° (feels ${formatNumber(feelsLike.now)}°)`),
        label('two-hour', `  In 2 hours    ${formatNumber(temperature.end)}°`),
        label('uv', `  UV Index      ${formatNumber(uvIndex.now)}`),
    ];

    const description = data?.buienalarm?.desc;
    if (description !== undefined && description !== null && description !== '') {
        requireText(description, 'rain description');
        menu.push({id: 'description-separator', kind: 'separator'});
        menu.push(label('rain-description', `  ${description}`));
    }

    const nonzero = timeline.filter(entry => entry.value > 0).slice(0, 53);
    if (peak > 0.05) {
        menu.push({id: 'rain-separator', kind: 'separator'});
        menu.push(label('rain-heading', '  Rain (next 2h):'));
        nonzero.forEach((entry, index) => menu.push(label(
            `rain-${index}`,
            `    ${entry.time}  ${formatNumber(entry.value)} mm/h`)));
    }

    return {
        version: 1,
        type: 'snapshot',
        panel: {
            text: `${current}°${rainDots}`,
            icon: weatherIcon(data.condition),
            appearance: 'compact',
            accessibleName: `${location}, ${current} degrees, ${rainDescription(peak)}`,
            severity: 'normal',
        },
        menu,
    };
}

function weatherIcon(condition) {
    switch (condition) {
        case 'clear':
            return 'weather-clear-symbolic';
        case 'partly_cloudy':
            return 'weather-few-clouds-symbolic';
        case 'overcast':
            return 'weather-overcast-symbolic';
        case 'fog':
            return 'weather-fog-symbolic';
        case 'drizzle':
        case 'rain':
            return 'weather-showers-symbolic';
        case 'snow':
            return 'weather-snow-symbolic';
        case 'thunderstorm':
            return 'weather-storm-symbolic';
        default:
            return 'weather-clear-symbolic';
    }
}

function rainDescription(peak) {
    if (peak <= 0.05)
        return 'no rain';
    if (peak < 0.25)
        return 'light rain';
    if (peak < 1)
        return 'rain';
    return 'heavy rain';
}

function label(id, text) {
    return {id, kind: 'label', text};
}

function formatNumber(value) {
    requireNumber(value, 'numeric value');
    return String(value);
}

function formatTime(value) {
    if (typeof value !== 'string')
        throw new Error('Weather rain timeline time is invalid');
    const match = /T(\d{2}):(\d{2})/.exec(value);
    if (match === null)
        throw new Error('Weather rain timeline time is invalid');
    return `${match[1]}:${match[2]}`;
}

function requireNumber(value, context) {
    if (!Number.isFinite(value))
        throw new Error(`Weather ${context} is invalid`);
}

function requireText(value, context) {
    if (typeof value !== 'string' || value.length === 0 || [...value].length > 512 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
        throw new Error(`Weather ${context} is invalid`);
}
