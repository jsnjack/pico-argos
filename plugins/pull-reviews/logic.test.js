// SPDX-License-Identifier: GPL-3.0-or-later

import {pullReviewsSnapshot} from './logic.js';

const clear = pullReviewsSnapshot({issueCount: 0}, 'octocat', ['example/project']);
if (clear.panel.text !== null || clear.panel.icon !== 'object-select-symbolic' ||
    clear.menu.length !== 7 ||
    !clear.panel.accessibleName.startsWith('No pull requests'))
    throw new Error('Review all-clear state is incorrect');
const requested = pullReviewsSnapshot({
    issueCount: 12,
    nodes: [{
        number: 42,
        title: 'Make the status menu clearer',
        url: 'https://github.com/example/project/pull/42',
        repository: {nameWithOwner: 'example/project'},
    }],
}, 'octocat', ['example/project']);
if (requested.panel.text !== '¹²' || requested.panel.icon !== 'checkbox-symbolic' ||
    requested.menu.find(item => item.id === 'requested-0')?.text !==
        'example/project #42 — Make the status menu clearer' ||
    requested.menu.filter(item => item.kind === 'link')
        .some(item => !item.uri.startsWith('https://github.com/')) ||
    requested.menu.find(item => item.id === 'assigned')?.text !== 'Assigned to me')
    throw new Error('Review requested state or links are incorrect');
print('ok - pull reviews presents GNOME-native state and bounded requested links');
