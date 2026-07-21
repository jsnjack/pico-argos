// SPDX-License-Identifier: GPL-3.0-or-later

/** Converts one bounded GitHub GraphQL search result into review state. */
export function pullReviewsSnapshot(search, user, repositories, issueRepository = 'surfly/it') {
    const count = search?.issueCount;
    if (!Number.isInteger(count) || count < 0)
        throw new Error('GitHub review search has no valid issueCount');
    const queryUser = encodeURIComponent(user);
    const organization = repositories[0].split('/')[0];
    const queryOrganization = encodeURIComponent(organization);
    return {
        version: 1,
        type: 'snapshot',
        panel: {
            text: count === 0 ? '🌴' : `${Math.min(count, 999)} 🔨`,
            appearance: 'compact',
            accessibleName: count === 0
                ? 'No pull requests awaiting review'
                : `${count} pull ${count === 1 ? 'request' : 'requests'} awaiting review`,
            severity: 'normal',
        },
        menu: [
            link('review-requests', 'Review requested', 'https://github.com/pulls/review-requested'),
            link('reviewed', 'Reviewed by me', `https://github.com/pulls?q=is%3Aopen+is%3Apr+reviewed-by%3A${queryUser}+archived%3Afalse`),
            {id: 'work-separator', kind: 'separator'},
            link('assigned', 'Assigned to me', `https://github.com/${issueRepository}/issues/assigned/${queryUser}`),
            link('authored', 'My prs', `https://github.com/pulls?q=is%3Aopen+is%3Apr+author%3A${queryUser}+archived%3Afalse+user%3A${queryOrganization}`),
            {id: 'issues-separator', kind: 'separator'},
            link('new-issue', 'New issues', `https://github.com/${issueRepository}/issues?q=is%3Aopen+is%3Aissue+label%3Anew-issue`),
        ],
    };
}

function link(id, text, uri) {
    return {id, kind: 'link', text, uri};
}
