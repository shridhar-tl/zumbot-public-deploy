import fs from 'fs';
import http from 'http';
import https from 'https';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const dummyOverride = {
    onBeforeGenerateResponse: (req) => req,
    onBeforePostResponse: (req) => req,
};

const args = getCmdArguments();

const responderBasePath = (process.env.RESP_BASE_PATH || 'https://bot.utilsware.com').replace(/\/+$/, '');

const disclaimerSeparator = '\n\n---\n';
const disclaimerMarker = '**Disclaimer**';
const defaultDisclaimer = `${disclaimerMarker}: Please note that this response has been generated automatically by an AI bot. While we strive for accuracy, there may be instances where the information is incorrect or inappropriate. We review these responses periodically and will make necessary corrections as needed. We appreciate your understanding.`;
const closedTicketDisclaimer = `${disclaimerMarker}: This ticket has been closed based on the information provided. Please note that this response was generated automatically by an AI bot, and while we strive for accuracy, there may be instances where the information is incorrect or inappropriate. If you believe it is inappropriate to close this ticket or if you have further issues to discuss, you are welcome to reopen the ticket or add a comment explaining the details. It will be reviewed manually at a later point. Thank you for your understanding.`;

const { ticket: issueKey, repo, authToken, ghToken, orgId, botId, updateOnly, ticketType = 'issues', overrideFile, issueUrl: argIssueUrl } = args;
const testMode = args.testMode === true || String(args.testMode).toLowerCase() === 'true';

const padNumber = (number) => number.toString().padStart(5, '0');
const isIssue = ticketType === 'issues';
const issueApiUrl = `https://api.github.com/repos/${repo}/${ticketType}/${issueKey}`;

await (async function () {
    try {
        const overrides = await loadOverride(overrideFile?.trim());
        const issueDetails = await gitFetch(issueApiUrl);
        console.log(`Done fetching ${ticketType} details`);

        if (issueDetails.pull_request) {
            console.log('Pull requests are not handled by the responder. Exiting.');
            return;
        }

        const comments = issueDetails.comments ? await gitFetchAll(`${issueDetails.comments_url ?? `${issueApiUrl}/comments`}?per_page=100`) : [];
        console.log(`Done fetching ${ticketType} comments`);

        const repoLabels = !updateOnly && isIssue ? await gitFetchAll(`https://api.github.com/repos/${repo}/labels?per_page=100`) : [];
        console.log('Done fetching repo labels');

        const request = { issueDetails, comments, repoLabels, updateOnly };
        const preProcessedData = await overrides.onBeforeGenerateResponse(request);
        if (!preProcessedData?.issueDetails || preProcessedData?.canceled) {
            console.warn('No updates made based on response from onBeforeGenerateResponse:', preProcessedData);
            return;
        }

        const apiResponse = await callResponder(
            preProcessedData.issueDetails,
            preProcessedData.comments,
            preProcessedData.repoLabels,
            preProcessedData.updateOnly,
        );
        console.log('Done getting response from bot');

        if (updateOnly) {
            console.log('Done updating resource center');
            return;
        }

        if (apiResponse.completionCost) {
            console.log('Cost incurred for processing this ticket', JSON.stringify(apiResponse.completionCost));
        }

        const result = await overrides.onBeforePostResponse({ response: apiResponse, request });
        if (!result?.response || result?.canceled) {
            console.warn('No updates made based on response from onBeforePostResponse:', result);
            return;
        }
        await updateGitHubIssue(issueDetails, result.response);
        console.log('Done with updating ticket');
    } catch (error) {
        console.error(`Error: ${error.message}`, error);
        process.exitCode = 1;
    }
})();

function getAuthHeaders() {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' };
    if (ghToken) {
        headers.Authorization = `token ${ghToken}`;
    }
    return headers;
}

function gitFetch(url, body, method) {
    const options = { headers: getAuthHeaders() };

    if (body) {
        options.method = method || 'POST';
        options.body = body;
    }

    return callAPI(url, options);
}

async function gitFetchAll(url) {
    const items = [];
    let nextUrl = url;
    while (nextUrl) {
        console.log('About to hit url: ', nextUrl);
        const response = await fetch(nextUrl, { headers: getAuthHeaders() });
        if (!response.ok) throw new Error(`Error calling API: ${response.status} ${response.statusText}; ${await response.text()}`);
        items.push(...(await response.json()));
        nextUrl = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    }
    return items;
}

async function callAPI(url, options) {
    if (options?.body && typeof options.body === 'object') {
        options.body = JSON.stringify(options.body);
    }
    console.log('About to hit url: ', url);
    const response = await fetch(url, options);
    if (!response.ok) {
        const error = new Error(`Error calling API: ${response.status} ${response.statusText}; ${await response.text()}`);
        error.status = response.status;
        throw error;
    }
    return await response.json();
}

function getAuthorRole(user, association) {
    return user?.type === 'Bot' ? 'BOT' : association;
}

function stripDisclaimer(text) {
    const index = text.indexOf(`---\n${disclaimerMarker}`);
    return index >= 0 ? text.substring(0, index).trim() : text;
}

function isEmptyFormAnswer(content) {
    return /^_?no response_?$/i.test(content);
}

function isChecklistOnly(content) {
    const lines = content
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    return lines.length > 0 && lines.every((line) => /^[-*+] \[[ xX]\] /.test(line));
}

function cleanIssueBody(body) {
    if (!body) return body;

    const text = body
        .replace(/\r\n/g, '\n')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<img\b[^>]*>/gi, '[image]')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '[image]');
    const sections = text.split(/(?=^#{1,6} )/m);

    return sections
        .filter((section) => {
            const [firstLine, ...rest] = section.split('\n');
            if (!/^#{1,6} /.test(firstLine)) {
                return !!section.trim();
            }
            const content = rest.join('\n').trim();
            return !isEmptyFormAnswer(content) && !isChecklistOnly(content);
        })
        .join('')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function callResponder(sourceIssue, comments, repoLabels, updateOnly) {
    const labels = (sourceIssue.labels || []).map((label) => (typeof label === 'string' ? label : label.name)).filter(Boolean);

    const { number, state, title, body } = sourceIssue;

    const commentsContent = comments
        .map((comment) => ({
            createdBy: comment.user.login,
            authorRole: getAuthorRole(comment.user, comment.author_association),
            body: stripDisclaimer(cleanIssueBody(comment.body?.trim() || '') || ''),
            createdAt: new Date(comment.created_at),
            modifiedAt: new Date(comment.updated_at),
        }))
        .filter((c) => !!c.body);

    const content = {
        system: 'GitHub',
        issueKey: number,
        issueType: isIssue ? 'Issue' : 'Discussion',
        status: state,
        createdBy: sourceIssue.user.login,
        authorRole: getAuthorRole(sourceIssue.user, sourceIssue.author_association),
        createdAt: new Date(sourceIssue.created_at),
        body: cleanIssueBody(body?.trim()),
        labels,
        comments: commentsContent.length ? commentsContent : undefined,
    };

    const issueUrl = argIssueUrl?.trim() || sourceIssue.html_url || `https://github.com/${repo}/${ticketType}/${issueKey}`;
    const customId = isIssue ? `g_issue_${padNumber(number)}` : `g_discussion_${padNumber(number)}`;
    const requestBody = { customId, title: title?.trim(), content, issueUrl };

    let apiUrl = `${responderBasePath}/bots/${orgId}/${botId}/github/knowledge`;

    if (!updateOnly) {
        apiUrl = `${responderBasePath}/bots/${orgId}/${botId}/github/respond`;
        if (isIssue && repoLabels?.length) {
            requestBody.attributes = { labels: repoLabels.map((label) => ({ text: label.name, description: label.description })) };
        }

        if (testMode) {
            requestBody.testMode = true;
        }
    }

    return await callAPI(apiUrl, {
        headers: {
            'Content-Type': 'application/json',
            Authorization: `token ${authToken}`,
        },
        method: 'POST',
        body: requestBody,
    });
}

async function updateIssueState(url, updateData) {
    try {
        await gitFetch(url, updateData, 'PATCH');
    } catch (error) {
        if (error.status === 422 && updateData.state_reason === 'duplicate') {
            console.warn('GitHub rejected state_reason "duplicate"; retrying with "not_planned".');
            await gitFetch(url, { ...updateData, state_reason: 'not_planned' }, 'PATCH');
            return;
        }
        throw error;
    }
}

async function updateGitHubIssue(issueDetails, apiResponse) {
    if (!apiResponse.isSuccess) {
        console.warn('No updates made as the AI call is not successful:', apiResponse);
        return;
    }

    const isClosing = apiResponse.status === 'closed' && issueDetails.state !== 'closed';

    if (apiResponse.comment) {
        const comment = `${apiResponse.comment}${disclaimerSeparator}${isClosing ? closedTicketDisclaimer : defaultDisclaimer}`;
        await gitFetch(`https://api.github.com/repos/${repo}/${ticketType}/${issueKey}/comments`, { body: comment });
    } else {
        console.log('No comment generated for this ticket.');
    }

    if (!isIssue) {
        return;
    }

    const updateData = {};
    if (apiResponse.status && issueDetails.state !== apiResponse.status) {
        updateData.state = apiResponse.status;

        if (apiResponse.state_reason && apiResponse.state_reason !== 'null') {
            updateData.state_reason = apiResponse.state_reason;
        }
    }

    if (Array.isArray(apiResponse.labels)) {
        updateData.labels = apiResponse.labels;
    }

    if (Object.keys(updateData).length > 0) {
        await updateIssueState(`${issueDetails.repository_url}/issues/${issueKey}`, updateData);
    }
}

function getCmdArguments() {
    const argv = process.argv.slice(2);
    const result = {};

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (!arg.startsWith('--')) {
            console.error(`Invalid argument: ${arg}`);
            process.exit(1);
        }

        const key = arg.slice(2);
        const value = argv[i + 1];

        if (value && !value.startsWith('--')) {
            result[key] = value;
            i++;
        } else {
            result[key] = value ?? true;
            if (!value) {
                i++;
            }
        }
    }

    return result;
}

export async function loadOverride(urlOrPath) {
    if (!urlOrPath) {
        return dummyOverride;
    }

    const isHttp = urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://');
    let modulePath = urlOrPath;

    if (isHttp) {
        try {
            const filePath = path.join(tmpdir(), `rs_override_${Date.now()}.mjs`);

            await new Promise((resolve, reject) => {
                const protocol = urlOrPath.startsWith('https') ? https : http;
                protocol
                    .get(urlOrPath, (response) => {
                        if (response.statusCode !== 200) {
                            reject(new Error(`Failed to download file: ${response.statusCode}`));
                            return;
                        }
                        const writeStream = response.pipe(fs.createWriteStream(filePath));
                        writeStream.on('finish', resolve);
                        writeStream.on('error', reject);
                    })
                    .on('error', reject);
            });

            modulePath = path.resolve(filePath);
        } catch (error) {
            console.error('Error downloading override file:', error);
            return dummyOverride;
        }
    }

    try {
        const moduleFilePath = pathToFileURL(modulePath).href;
        console.log('Loading override module:', moduleFilePath);
        const module = await import(moduleFilePath);
        return { ...dummyOverride, ...module };
    } catch (error) {
        console.error('Error loading override module:', error);
        return dummyOverride;
    }
}
