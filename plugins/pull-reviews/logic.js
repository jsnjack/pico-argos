// SPDX-License-Identifier: GPL-3.0-or-later

/** Converts one bounded GitHub GraphQL search result into review state. */
export function pullReviewsSnapshot(search, user, repositories) {
    const count = search?.issueCount;
    if (!Number.isInteger(count) || count < 0)
        throw new Error('GitHub review search has no valid issueCount');
    const queryUser = encodeURIComponent(user);
    const firstRepository = repositories[0];
    return {
        version: 1,
        type: 'snapshot',
        panel: {
            text: String(Math.min(count, 999)),
            icon: 'emblem-documents-symbolic',
            appearance: 'compact',
            accessibleName: count === 0
                ? 'No pull requests awaiting review'
                : `${count} pull ${count === 1 ? 'request' : 'requests'} awaiting review`,
            severity: 'normal',
        },
        menu: [
            link('review-requests', 'Review requested', 'https://github.com/pulls/review-requested'),
            link('reviewed', 'Reviewed pull requests', `https://github.com/pulls?q=is%3Apr+reviewed-by%3A${queryUser}`),
            link('assigned', 'Assigned issues', `https://github.com/issues?q=is%3Aopen+assignee%3A${queryUser}`),
            link('authored', 'Authored pull requests', `https://github.com/pulls?q=is%3Aopen+author%3A${queryUser}`),
            link('new-issue', 'Create a new issue', `https://github.com/${firstRepository}/issues/new/choose`),
        ],
    };
}

function link(id, text, uri) {
    return {id, kind: 'link', text, uri};
}
