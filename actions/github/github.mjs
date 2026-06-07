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

const responderBasePath = process.env.RESP_BASE_PATH || 'https://335k3gia6uavyfimzvao2l6fzy0wuajw.lambda-url.ap-south-1.on.aws';

const defaultDisclaimer =
    '**Disclaimer**: Please note that this response has been generated automatically by an AI bot. While we strive for accuracy, there may be instances where the information is incorrect or inappropriate. We review these responses periodically and will make necessary corrections as needed. We appreciate your understanding.';
const closedTicketDisclaimer =
    '**Disclaimer**: This ticket has been closed based on the information provided. Please note that this response was generated automatically by an AI bot, and while we strive for accuracy, there may be instances where the information is incorrect or inappropriate. If you believe it is inappropriate to close this ticket or if you have further issues to discuss, you are welcome to reopen the ticket. It will be reviewed manually at a later point. Thank you for your understanding.';

const {
    ticket: issueKey,
    repo,
    authToken,
    ghToken,
    orgId,
    botId,
    updateOnly,
    ticketType = 'issues',
    overrideFile,
    issueUrl: argIssueUrl,
} = args;
let { testMode } = args;
testMode = Boolean(testMode);

const padNumber = (number) => number.toString().padStart(5, '0');
const isIssue = ticketType === 'issues';
const issueApiUrl = `https://api.github.com/repos/${repo}/${ticketType}/${issueKey}`;

await (async function () {
    try {
        const overrides = await loadOverride(overrideFile?.trim());
        const issueDetails = await gitFetch(issueApiUrl);
        console.log(`Done fetching ${ticketType} details`);

        const comments = issueDetails.comments ? await gitFetch(issueDetails.comments_url ?? `${issueApiUrl}/comments`) : [];
        console.log(`Done fetching ${ticketType} comments`);

        const repoLabels = !updateOnly && ticketType === 'issues' && (await gitFetch(`https://api.github.com/repos/${repo}/labels`));
        console.log('Done fetching repo labels');

        const request = { issueDetails, comments, repoLabels, updateOnly };
        const preProcessedData = overrides.onBeforeGenerateResponse(request);
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
            console.log('Cost incurred for processing this ticket', apiResponse.completionCost);
        }

        const result = overrides.onBeforePostResponse({ response: apiResponse, request });
        if (!result?.response || result?.canceled) {
            console.warn('No updates made based on response from onBeforePostResponse:', result);
            return;
        }
        await updateGitHubIssue(issueDetails, result.response);
        console.log('Done with updating ticket');
    } catch (error) {
        console.error(`Error: ${error.message}`, error);
    }
})();

function gitFetch(url, body, method) {
    const options = { headers: { 'Content-Type': 'application/json' } };
    if (ghToken) {
        options.headers = { ...options.headers, Authorization: `token ${ghToken}` };
    }

    if (body) {
        options.method = method || 'POST';
        options.body = body;
    }

    return callAPI(url, options);
}

async function callAPI(url, options) {
    if (options?.body && typeof options.body === 'object') {
        options.body = JSON.stringify(options.body);
    }
    console.log('About to hit url: ', url);
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`Error calling API: ${response.statusText}; ${await response.text()}`);
    return await response.json();
}

async function callResponder(sourceIssue, comments, repoLabels, updateOnly) {
    const labels = sourceIssue.labels.map((label) => label.name).join(', ');

    const { number, state, title, body } = sourceIssue;

    const commentsContent = comments
        .map((comment) => ({
            createdBy: comment.user.login,
            updatedBy: comment.update_user?.login,
            body: comment.body?.trim(),
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
        createdAt: new Date(sourceIssue.created_at),
        body: body?.trim(),
        comments: commentsContent?.length ? commentsContent : undefined,
        attributes: [labels && { label: 'Labels', value: labels }].filter(Boolean),
    };

    const issueUrl = argIssueUrl?.trim() || (repo && issueKey ? `https://github.com/${repo}/${ticketType}/${issueKey}` : undefined);
    const customId = isIssue ? `g_issue_${padNumber(number)}` : `g_discussion_${padNumber(number)}`;
    const requestBody = { customId, title: title?.trim(), content, issueUrl };

    let apiUrl = `${responderBasePath}/bot/${orgId}/${botId}/github/knowledge`;

    if (!updateOnly) {
        apiUrl = `${responderBasePath}/bot/${orgId}/${botId}/github/respond`;
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

async function updateGitHubIssue(issueDetails, apiResponse) {
    if (!apiResponse.isSuccess) {
        console.warn('No updates made as the AI call is not successful:', apiResponse);
        return;
    }

    const comment =
        apiResponse.comment &&
        `${apiResponse.comment}\n\n---\n${apiResponse.status !== 'closed' ? defaultDisclaimer : closedTicketDisclaimer}`;
    if (comment) {
        await gitFetch(`https://api.github.com/repos/${repo}/${ticketType}/${issueKey}/comments`, { body: comment });
    }

    let updateData = {};
    if (apiResponse.status && issueDetails.state !== apiResponse.status) {
        updateData.state = apiResponse.status;

        if (apiResponse.state_reason && apiResponse.state_reason !== 'null') {
            updateData.state_reason = apiResponse.state_reason;
        }
    }

    if (apiResponse.labels && apiResponse.labels.length > 0) {
        updateData.labels = apiResponse.labels;
    }

    if (Object.keys(updateData).length > 0) {
        await gitFetch(`${issueDetails.repository_url}/${ticketType}/${issueKey}`, updateData, 'PATCH');
    }
}

function getCmdArguments() {
    const args = process.argv.slice(2);
    const result = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg.startsWith('--')) {
            const key = arg.slice(2); // Remove the leading '--'
            const value = args[i + 1];

            // Check if the next item exists and is not another key
            if (value && !value.startsWith('--')) {
                result[key] = value;
                i++; // Increment i to skip the value
            } else {
                result[key] = value ?? true; // Default to true if no value
                if (!value) {
                    i++; // Increment i to skip the value just in case if empty value is passed
                }
            }
        } else {
            console.error(`Invalid argument: ${arg}`);
            process.exit(1);
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
            const tempDir = tmpdir();
            const filename = `rs_override_${Date.now()}.mjs`;
            const filePath = path.join(tempDir, filename);

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
