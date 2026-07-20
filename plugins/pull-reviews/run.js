#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';

import {pullReviewsSnapshot} from './logic.js';

try {
    const token = requiredEnvironment('GITHUB_TOKEN');
    const user = requiredEnvironment('GITHUB_USER');
    const repositories = requiredEnvironment('GITHUB_REPOSITORIES')
        .split(',').map(value => value.trim()).filter(Boolean);
    if (repositories.length === 0 || repositories.length > 20 ||
        repositories.some(value => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)))
        throw new Error('GITHUB_REPOSITORIES must list at most 20 owner/name values');
    if (!/^[A-Za-z0-9-]+$/.test(user))
        throw new Error('GITHUB_USER is invalid');
    const repositoryQuery = repositories.map(value => `repo:${value}`).join(' ');
    const searchQuery = `is:pr is:open draft:false review-requested:${user} ${repositoryQuery}`;
    const data = requestGraphql(token, searchQuery);
    if (Array.isArray(data.errors) && data.errors.length !== 0)
        throw new Error('GitHub GraphQL returned an error');
    print(JSON.stringify(pullReviewsSnapshot(data.data?.search, user, repositories)));
} catch (error) {
    printerr(`[pull-reviews] ${error.message}`);
    System.exit(1);
}

function requestGraphql(token, searchQuery) {
    const body = JSON.stringify({
        query: 'query($query:String!){search(query:$query,type:ISSUE,first:1){issueCount}}',
        variables: {query: searchQuery},
    });
    const message = Soup.Message.new('POST', 'https://api.github.com/graphql');
    message.request_headers.append('Accept', 'application/vnd.github+json');
    message.request_headers.append('Authorization', `Bearer ${token}`);
    message.request_headers.append('User-Agent', 'pico-argos-pull-reviews');
    message.set_request_body_from_bytes(
        'application/json',
        GLib.Bytes.new(new TextEncoder().encode(body)));
    const bytes = new Soup.Session({timeout: 15}).send_and_read(message, null);
    if (message.status_code < 200 || message.status_code >= 300)
        throw new Error(`GitHub returned HTTP ${message.status_code}`);
    if (bytes.get_size() > 1_048_576)
        throw new Error('GitHub response exceeds 1 MiB');
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.get_data()));
}

function requiredEnvironment(name) {
    const value = GLib.getenv(name);
    if (value === null || value.length === 0)
        throw new Error(`${name} is required`);
    return value;
}
