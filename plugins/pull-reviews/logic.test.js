// SPDX-License-Identifier: GPL-3.0-or-later

import {pullReviewsSnapshot} from './logic.js';

const clear = pullReviewsSnapshot({issueCount: 0}, 'octocat', ['example/project']);
if (clear.panel.text !== '🌴' || clear.menu.length !== 7 ||
    !clear.panel.accessibleName.startsWith('No pull requests'))
    throw new Error('Review all-clear state is incorrect');
const requested = pullReviewsSnapshot({issueCount: 12}, 'octocat', ['example/project']);
if (requested.panel.text !== '12 🔨' ||
    requested.menu.filter(item => item.kind === 'link')
        .some(item => !item.uri.startsWith('https://github.com/')) ||
    requested.menu.find(item => item.id === 'assigned')?.text !== 'Assigned to me')
    throw new Error('Review requested state or links are incorrect');
print('ok - pull review plugin preserves all-clear state and related links');
