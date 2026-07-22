// SPDX-License-Identifier: GPL-3.0-or-later

/** Converts one bounded GitHub GraphQL search result into review state. */
export function pullReviewsSnapshot(search, user, repositories, issueRepository = 'surfly/it') {
    const count = search?.issueCount;
    if (!Number.isInteger(count) || count < 0)
        throw new Error('GitHub review search has no valid issueCount');
    const requested = Array.isArray(search?.nodes)
        ? search.nodes.slice(0, 5).map(normalizePullRequest).filter(Boolean)
        : [];
    const queryUser = encodeURIComponent(user);
    const organization = repositories[0].split('/')[0];
    const queryOrganization = encodeURIComponent(organization);
    const menu = [];
    if (requested.length !== 0) {
        menu.push({
            id: 'requested-heading',
            kind: 'label',
            text: count === 1 ? 'Awaiting your review' : `${count} awaiting your review`,
        });
        requested.forEach((pullRequest, index) => menu.push(link(
            `requested-${index}`,
            pullRequestText(pullRequest),
            pullRequest.url)));
        menu.push({id: 'requested-separator', kind: 'separator'});
    }
    menu.push(
        link('review-requests', 'All review requests', 'https://github.com/pulls/review-requested'),
        link('reviewed', 'Reviewed by me', `https://github.com/pulls?q=is%3Aopen+is%3Apr+reviewed-by%3A${queryUser}+archived%3Afalse`),
        {id: 'work-separator', kind: 'separator'},
        link('assigned', 'Assigned to me', `https://github.com/${issueRepository}/issues/assigned/${queryUser}`),
        link('authored', 'My pull requests', `https://github.com/pulls?q=is%3Aopen+is%3Apr+author%3A${queryUser}+archived%3Afalse+user%3A${queryOrganization}`),
        {id: 'issues-separator', kind: 'separator'},
        link('new-issue', 'New issues', `https://github.com/${issueRepository}/issues?q=is%3Aopen+is%3Aissue+label%3Anew-issue`));
    return {
        version: 1,
        type: 'snapshot',
        panel: {
            text: count === 0 ? null : superscript(Math.min(count, 999)),
            icon: count === 0
                ? 'object-select-symbolic'
                : 'checkbox-symbolic',
            appearance: 'compact',
            accessibleName: count === 0
                ? 'No pull requests awaiting review'
                : `${count} pull ${count === 1 ? 'request' : 'requests'} awaiting review`,
            severity: 'normal',
        },
        menu,
    };
}

function link(id, text, uri) {
    return {id, kind: 'link', text, uri};
}

const SUPERSCRIPT_DIGITS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];

function superscript(count) {
    return [...String(count)].map(digit => SUPERSCRIPT_DIGITS[digit]).join('');
}

function normalizePullRequest(value) {
    if (!Number.isInteger(value?.number) || value.number < 1 ||
        typeof value?.title !== 'string' ||
        typeof value?.url !== 'string' ||
        !value.url.startsWith('https://github.com/') ||
        typeof value?.repository?.nameWithOwner !== 'string') {
        return null;
    }
    return {
        number: value.number,
        title: cleanText(value.title),
        url: value.url,
        repository: cleanText(value.repository.nameWithOwner),
    };
}

function pullRequestText(pullRequest) {
    const prefix = `${pullRequest.repository} #${pullRequest.number}`;
    return truncate(`${prefix} — ${pullRequest.title}`, 180);
}

function cleanText(value) {
    return value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
}

function truncate(value, maximumScalars) {
    const scalars = [...value];
    return scalars.length <= maximumScalars
        ? value
        : `${scalars.slice(0, maximumScalars - 1).join('')}…`;
}
